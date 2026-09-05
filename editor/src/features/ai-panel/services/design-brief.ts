/**
 * The screen, in front of the model, before it is asked to change it.
 *
 * **The problem this solves.** A design turn used to start blind. The prompt
 * named a document path and nothing else — not a line of its markup, not a rule
 * from its stylesheets, not one thing the C# does with it. Everything the model
 * needed had to be bought with tool calls, and two of the three answers were
 * expensive or simply unavailable:
 *
 * - `unity_ui_toolkit document=X` returns the element tree and the stylesheet
 *   *paths*, and not a single USS declaration. "Extend the project's visual
 *   language" was being asked of a model that had never been shown it.
 * - `unity_ui_toolkit {element, usages:true}` resolves ONE element and pays a
 *   whole-project `.cs` walk to do it. Asking about six elements walked the
 *   project six times, so `project_symbols` and `list`+`read` over `.cs` looked
 *   like the cheap option — which is exactly the behaviour that was complained
 *   about.
 *
 * All three answers already existed as working, tested code. This assembles
 * them once per send and hands them over, so the model opens the turn knowing
 * the screen rather than spending the turn discovering it.
 *
 * **Why it rides on the user message, not the system prompt.** The system
 * prompt's decoration is frozen per conversation precisely so the provider's
 * prefix cache holds (`frozen-context.ts`); a brief that changes whenever the
 * document changes would re-bill the whole conversation every turn. The
 * message tail is where `agent-service.ts` already puts live context for the
 * same reason.
 *
 * The formatter is pure and the I/O sits behind `DesignBriefDeps`, the same
 * split — and the same reason — as `ui-layout-tool.ts`: the collectors reach
 * `features/uitoolkit` through a dynamic `import()` because that barrel pulls
 * React, which takes Bun's DOM-less suite down on import alone.
 */

import { describeUsage, type ElementUsage } from '../../../utils/uxml-usage';
import { parseUxml } from '../../../utils/uxml-model';
import { resolveToCwd } from './vendor/tools/path-utils';

export interface BriefSheet {
  /** Workspace-relative. */
  path: string;
  source: string;
}

export interface DesignBriefInput {
  /** Workspace-relative path of the document this session is scoped to. */
  documentPath: string;
  /** The `.uxml` source, or null when it could not be read. */
  markup: string | null;
  /** Only the sheets the document actually REACHES — see `styleCoverage`'s note. */
  sheets: readonly BriefSheet[];
  /** Every C# site that touches one of this document's named elements. */
  usages: readonly ElementUsage[];
  /** False when the project walk did not run; the difference between "none" and "unknown". */
  usagesLoaded: boolean;
  /** `formatStyleCoverage`'s output, or null when everything is painted. */
  coverageNote: string | null;
}

/**
 * Character budgets.
 *
 * Generous, because this replaces tool calls that would each cost more, and
 * because a truncated stylesheet is a palette the model then invents around.
 * Every cut is announced in the text — a silently truncated brief would read as
 * a complete one, and the model would conclude a rule simply is not there.
 */
const MARKUP_BUDGET = 6_000;
const SHEETS_BUDGET = 8_000;
const MAX_USAGES = 40;

function clip(text: string, budget: number, what: string): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n… ${what} truncated at ${budget} characters — use \`read\` for the rest.`;
}

/** Longest name, so the usage table's columns line up rather than ragging. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function usageLines(usages: readonly ElementUsage[], loaded: boolean): string[] {
  if (!loaded) {
    return [
      'The project-wide C# walk has not finished, so what the code does with this',
      'screen is UNKNOWN — not "nothing". Treat a name as in use until you know better.',
    ];
  }
  if (usages.length === 0) {
    return [
      'No C# in this project reaches any element of this screen by name. Renaming or',
      'removing an element here cannot break code, so you do not need to read any.',
    ];
  }

  const shown = usages.slice(0, MAX_USAGES);
  const nameWidth = Math.min(24, Math.max(...shown.map((u) => u.elementName.length + 1)));
  const descWidth = Math.min(40, Math.max(...shown.map((u) => describeUsage(u).length)));

  const lines = shown.map(
    (u) =>
      `  ${pad(`#${u.elementName}`, nameWidth)}  ${pad(describeUsage(u), descWidth)}  ${u.filePath}:${u.line}`,
  );
  if (usages.length > shown.length) {
    lines.push(`  …${usages.length - shown.length} more.`);
  }
  return lines;
}

/**
 * Render the brief.
 *
 * Pure — no I/O, no stores, no DOM — so its wording is directly testable, which
 * matters more here than usual: every line of it is an instruction the model
 * will act on, and the "do not go looking for more" sentence is the entire
 * point of the C# section.
 */
export function formatDesignBrief(input: DesignBriefInput): string {
  const out: string[] = ['## This screen, as it stands right now', ''];

  if (input.markup === null) {
    out.push(
      `${input.documentPath} could not be read, so what follows may be incomplete.`,
      'Read it before changing it.',
      '',
    );
  } else {
    out.push(`### ${input.documentPath}`, '', '```xml', clip(input.markup, MARKUP_BUDGET, 'Markup'), '```', '');
  }

  out.push('### The stylesheets this document reaches', '');
  if (input.sheets.length === 0) {
    out.push(
      'None. Every element on this screen renders with Unity default styling, whatever',
      'classes the markup gives it. A `.uss` that exists in the project but is not',
      'referenced from this document with `<Style src>` styles nothing here.',
      '',
    );
  } else {
    let spent = 0;
    for (const sheet of input.sheets) {
      const remaining = SHEETS_BUDGET - spent;
      if (remaining <= 0) {
        out.push(`(${sheet.path} omitted — stylesheet budget spent. Use \`read\` for it.)`, '');
        continue;
      }
      const body = clip(sheet.source, remaining, sheet.path);
      spent += body.length;
      out.push(`#### ${sheet.path}`, '', '```css', body, '```', '');
    }
  }

  out.push('### What this project’s C# does with these elements', '');
  out.push(...usageLines(input.usages, input.usagesLoaded));
  // Only over a non-empty list. "That is the complete list" under "no C# reaches
  // any element" is a second sentence saying the same thing, and reads oddly
  // enough to make a careful reader wonder which one to believe — the empty
  // branch already carries the instruction ("you do not need to read any").
  if (input.usagesLoaded && input.usages.length > 0) {
    out.push(
      '',
      'That is the complete list — every site in the project that reaches this screen',
      'by name, from the same index the editor’s own "C# references" tab uses. Do not',
      'search the codebase for more; there is no more. Read a `.cs` file only when you',
      'are about to change a name that appears above.',
    );
  }
  out.push('');

  if (input.coverageNote) {
    out.push('### Styling coverage', '', input.coverageNote, '');
  }

  return out.join('\n').trimEnd();
}

// ── Collection ───────────────────────────────────────────────────────────────

export interface DesignBriefStyles {
  /** Resolved stylesheets, in reference order, with their source text. */
  sheets: BriefSheet[];
  /** `formatStyleCoverage`'s output, or null when every element is painted. */
  coverageNote: string | null;
}

export interface DesignBriefDeps {
  readFile: (absPath: string) => Promise<string | null>;
  guidMap: (workspacePath: string) => Promise<Record<string, string>>;
  /**
   * Resolve the document's stylesheets and score its coverage in ONE pass.
   *
   * They are one dep rather than two because coverage has to be measured
   * against the parsed sheets the document actually resolved — the same
   * objects, not a re-read — and splitting them would either re-parse every
   * stylesheet or leak `UssStyleSheet` into this module's public shape for no
   * benefit.
   */
  styles: (
    markup: string,
    documentPath: string,
    workspacePath: string,
    resolveGuid: (guid: string) => Promise<string | null>,
  ) => Promise<DesignBriefStyles>;
  usages: (workspacePath: string, names: string[]) => Promise<ElementUsage[] | null>;
}

/** Workspace-relative, so every path in the brief matches the tree the user sees. */
function rel(path: string, workspacePath: string): string {
  const prefix = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function declaredNames(markup: string): string[] {
  const doc = parseUxml(markup);
  const out = new Set<string>();
  for (const node of doc.byId.values()) {
    if (node.name) out.add(node.name);
  }
  return [...out];
}

export const defaultDesignBriefDeps: DesignBriefDeps = {
  async readFile(absPath) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('read_file', { path: absPath }).catch(() => null);
  },
  async guidMap(workspacePath) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, string>>('unity_index_guid_map', { workspacePath }).catch(
      () => ({}) as Record<string, string>,
    );
  },
  async styles(markup, documentPath, workspacePath, resolveGuid) {
    const uitoolkit = await import('../../uitoolkit');
    const doc = parseUxml(markup);
    const { sheets } = await uitoolkit.loadStyleSheets(
      doc,
      documentPath,
      workspacePath,
      resolveGuid,
    );
    const coverage = uitoolkit.styleCoverage(uitoolkit.buildRenderPlan(doc, sheets).root, sheets);
    return {
      sheets: sheets.map((s) => ({ path: rel(s.path, workspacePath), source: s.source })),
      coverageNote: uitoolkit.formatStyleCoverage(documentPath, coverage),
    };
  },
  async usages(workspacePath, names) {
    if (names.length === 0) return [];
    const [uitoolkit, analyzers] = await Promise.all([
      import('../../uitoolkit'),
      import('../../unity-analyzers'),
    ]);
    const index = await uitoolkit.loadUsageIndex(
      workspacePath,
      names,
      analyzers.blankStringsAndComments,
    );
    // `loaded: false` means the walk did not run. That is a different answer
    // from "nothing uses these", and the brief says so rather than telling the
    // model there is nothing to worry about.
    if (!index.loaded) return null;
    return names.flatMap((n) => index.byElement.get(n) ?? []);
  },
};

/**
 * Assemble the brief for one design send.
 *
 * Never throws and never returns a partial claim: any half that could not be
 * collected says so in its own words rather than being omitted, because an
 * omitted C# section reads exactly like "no C# touches this screen" — the one
 * wrong conclusion this is here to prevent.
 */
export async function buildDesignBrief(
  workspacePath: string,
  documentPath: string,
  deps: DesignBriefDeps = defaultDesignBriefDeps,
): Promise<string> {
  const relPath = rel(documentPath, workspacePath);
  const markup = await deps.readFile(resolveToCwd(relPath, workspacePath)).catch(() => null);

  if (markup === null) {
    return formatDesignBrief({
      documentPath: relPath,
      markup: null,
      sheets: [],
      usages: [],
      usagesLoaded: false,
      coverageNote: null,
    });
  }

  const guids = await deps.guidMap(workspacePath).catch(() => ({}) as Record<string, string>);
  const [styles, usages] = await Promise.all([
    deps
      .styles(markup, relPath, workspacePath, async (guid) => guids[guid] ?? null)
      .catch((): DesignBriefStyles => ({ sheets: [], coverageNote: null })),
    deps.usages(workspacePath, declaredNames(markup)).catch(() => null),
  ]);

  return formatDesignBrief({
    documentPath: relPath,
    markup,
    sheets: styles.sheets,
    usages: usages ?? [],
    usagesLoaded: usages !== null,
    coverageNote: styles.coverageNote,
  });
}
