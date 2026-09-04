/**
 * `unity_ui_layout` — the agent sees its own layout.
 *
 * The human preview (`UxmlPreviewEditor.tsx`) already renders a live UXML
 * document, but the agent cannot see it — it has no eyes on the canvas, and
 * "read the .uxml" only shows the source, never what the source lays out to.
 * A flex rule that pushes a HUD element off the panel, a class typo that
 * leaves a label at its default (invisible) size, a button rendered 4px
 * tall — none of that produces a parse error or a C# exception. It is only
 * visible in the render, which until this tool only a human looking at the
 * preview could check.
 *
 * This tool runs the SAME pipeline the preview does — `loadStyleSheets` +
 * `loadPanelSettings` + `buildRenderPlan`, all reused rather than
 * reimplemented — through an offscreen probe (`layout-probe.ts`) that
 * measures the real DOM instead of painting it, and reports the tree as text:
 * every element's box, key styles, and a lint pass over the geometry
 * (offscreen elements, invisible zero-size content, clipped text, text below
 * WCAG contrast, overlapping absolute siblings, undersized buttons, HUD
 * elements crowding a device's unsafe area).
 *
 * It also closes Task 14's loop: `unity_ui_write` allocates a GUID for a
 * freshly written `.uxml`/`.uss` itself, ahead of Unity's own import
 * (`meta-guid.ts`). Once Unity HAS imported it, this tool — the one an agent
 * naturally calls right after writing UI markup, to see the result — reads
 * the `.meta` back and says so if Unity reassigned the GUID on a collision,
 * since a `<Style src>` or `unity_attach_ui_document` call written this turn
 * would otherwise silently point at nothing.
 */

import { Type, type Static } from '@sinclair/typebox';
import { invoke } from '@tauri-apps/api/core';
import type { AgentTool } from '../vendor/types';
import { txt, cap } from './text-result';
import { resolveToCwd } from '../vendor/tools/path-utils';
import { parseUxml, type UxmlDocument } from '../../../../utils/uxml-model';
import { panelLayoutSize, parsePanelSettings, type Size } from '../../../../utils/panel-settings';
import { renderLayoutTree, DEFAULT_MAX_NODES } from '../../../../utils/layout-tree-text';
import { lintLayout, type LintFinding } from '../../../../utils/layout-lint';
import { compareMetaGuid, takePendingGuidChecks } from './guid-verify';
import type {
  LoadedStyles,
  PanelResolution,
  ProbeLayoutOptions,
  ProbeLayoutOutput,
} from '../../../uitoolkit';

const schema = Type.Object({
  document: Type.String(),
  panel: Type.Optional(
    Type.String({
      description:
        'PanelSettings asset path to lay out against; default: the one wired to this document, else the only one, else 1920×1080.',
    }),
  ),
  maxDepth: Type.Optional(Type.Integer()),
  maxNodes: Type.Optional(Type.Integer()),
  includeStyles: Type.Optional(Type.Boolean()),
  image: Type.Optional(
    Type.Boolean({
      description: 'Also return a rendered image (only when the current model accepts images).',
    }),
  ),
});
type Params = Static<typeof schema>;

/**
 * Injectable data access.
 *
 * `loadStyleSheets`/`loadPanelSettings`/`probe` reach the `uitoolkit` feature
 * through a dynamic `import()` of its barrel for the reason `ui-toolkit-tool.ts`
 * documents: `layout-probe.ts` touches real DOM (`document`, `attachShadow`,
 * `getComputedStyle`), and the barrel that exports it also exports React
 * components that pull `stores/theme.ts` in behind them — either one kills
 * Bun's DOM-less suite on import alone. `probe` in particular is why this
 * module's own tests never import the barrel at all: they inject a fake that
 * returns a hand-built `ProbeLayoutOutput`.
 */
export interface UiLayoutToolDeps {
  readFile: (absPath: string) => Promise<string | null>;
  /** The project's persistent GUID index — guid -> path (Rust `unity_index_guid_map`), same shape `ui-write-tool.ts` uses. */
  guidMap: (workspacePath: string) => Promise<Record<string, string>>;
  loadStyleSheets: (
    doc: UxmlDocument,
    uxmlPath: string,
    workspacePath: string,
    resolveGuid: (guid: string) => Promise<string | null>,
  ) => Promise<LoadedStyles>;
  loadPanelSettings: (uxmlPath: string, workspacePath: string) => Promise<PanelResolution>;
  probe: (opts: ProbeLayoutOptions) => Promise<ProbeLayoutOutput>;
}

export const defaultUiLayoutDeps: UiLayoutToolDeps = {
  readFile(absPath) {
    return invoke<string>('read_file', { path: absPath }).catch(() => null);
  },
  guidMap(workspacePath) {
    return invoke<Record<string, string>>('unity_index_guid_map', { workspacePath }).catch(
      () => ({}) as Record<string, string>,
    );
  },
  async loadStyleSheets(doc, uxmlPath, workspacePath, resolveGuid) {
    const { loadStyleSheets } = await import('../../../uitoolkit');
    return loadStyleSheets(doc, uxmlPath, workspacePath, resolveGuid);
  },
  async loadPanelSettings(uxmlPath, workspacePath) {
    const { loadPanelSettings } = await import('../../../uitoolkit');
    return loadPanelSettings(uxmlPath, workspacePath);
  },
  async probe(opts) {
    const { probeLayout } = await import('../../../uitoolkit');
    return probeLayout(opts);
  },
};

/** The screen a `ScaleWithScreenSize` panel scales against — same assumption `UxmlPreviewEditor.tsx`'s `SCREEN` makes. */
const SCREEN: Size = { width: 1920, height: 1080 };

const IMAGE_NOT_AVAILABLE =
  'An image preview is not available for the current model; the layout tree above is the authoritative view.';

// ── Panel resolution ─────────────────────────────────────────────────────────

interface PanelInfo {
  settings: PanelResolution['settings'];
  layoutSize: Size;
  /** Contains one of the literal words the header must show: wired / only panel / assumed / no PanelSettings — screen size. */
  confidenceLabel: string;
}

function describeConfidence(r: PanelResolution): string {
  switch (r.confidence) {
    case 'wired':
      return `${r.settings!.name} — wired`;
    case 'only':
      return `${r.settings!.name} — only panel in the project`;
    case 'ambiguous':
      return `${r.settings!.name} — assumed (${r.candidates} panels, none wired to this document)`;
    default:
      return 'no PanelSettings — screen size';
  }
}

/**
 * Explicit `panel` param → wired → only → assumed (1920×1080).
 *
 * The explicit param is resolved separately from `loadPanelSettings`'s own
 * ladder: it names one specific asset, so it is read and parsed directly
 * rather than run through the project-wide wired/only/ambiguous search. A
 * param that does not resolve to a readable `PanelSettings` falls back to
 * that ladder rather than failing outright — Global Constraint 2 (no
 * degraded path reads as success) is why the fallback is stated in `note`
 * rather than silently swapped in.
 */
async function resolvePanel(
  uxmlPath: string,
  workspacePath: string,
  explicitPanelPath: string | undefined,
  deps: UiLayoutToolDeps,
): Promise<{ info: PanelInfo; note: string | null }> {
  if (explicitPanelPath) {
    const abs = resolveToCwd(explicitPanelPath, workspacePath);
    const content = await deps.readFile(abs).catch(() => null);
    const settings = content ? parsePanelSettings(content, explicitPanelPath) : null;
    if (settings) {
      return {
        info: {
          settings,
          layoutSize: panelLayoutSize(settings, SCREEN),
          confidenceLabel: `${settings.name} — explicit (panel param)`,
        },
        note: null,
      };
    }
  }

  let resolution: PanelResolution;
  let loadFailed = false;
  try {
    resolution = await deps.loadPanelSettings(uxmlPath, workspacePath);
  } catch {
    resolution = { settings: null, confidence: 'none', path: null, candidates: 0 };
    loadFailed = true;
  }

  const layoutSize = resolution.settings ? panelLayoutSize(resolution.settings, SCREEN) : SCREEN;
  const confidenceLabel = describeConfidence(resolution);
  const note = explicitPanelPath
    ? `Could not use the requested panel "${explicitPanelPath}" — it is not a readable PanelSettings asset. Falling back: ${confidenceLabel}.`
    : loadFailed
      ? `Could not resolve PanelSettings for this document — assuming ${SCREEN.width}×${SCREEN.height}.`
      : null;

  return { info: { settings: resolution.settings, layoutSize, confidenceLabel }, note };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function findingLine(f: LintFinding): string {
  return `  [${f.severity}] ${f.code}: ${f.message}`;
}

/**
 * The pending GUID checks Task 14's `unity_ui_write` registered this send.
 * Not scoped to the document being laid out — an agent calling this tool
 * right after a write is exactly the moment to surface it, whatever path it
 * was for. Drains the registry (a check reported once is done), the same
 * take-once contract every other per-send registry in this codebase follows.
 */
async function pendingGuidSection(workspacePath: string, deps: UiLayoutToolDeps): Promise<string | null> {
  const pending = takePendingGuidChecks();
  if (pending.length === 0) return null;

  const lines: string[] = [];
  let matched = 0;
  for (const { path, guid } of pending) {
    const metaAbs = resolveToCwd(`${path}.meta`, workspacePath);
    const metaText = await deps.readFile(metaAbs);
    if (metaText === null) {
      lines.push(`${path}: Unity has not imported it yet — no .meta on disk.`);
      continue;
    }
    const outcome = compareMetaGuid(guid, metaText);
    if (outcome.kind === 'match') {
      matched++;
    } else if (outcome.kind === 'mismatched') {
      lines.push(
        `Unity reassigned the GUID for ${path} (expected ${guid}, now ${outcome.actual}) — references written this turn must be updated.`,
      );
    } else {
      lines.push(`${path}: its .meta exists but its GUID could not be read.`);
    }
  }
  if (matched > 0) {
    lines.unshift(
      `${matched} write${matched === 1 ? '' : 's'} confirmed — Unity kept the GUID this session assigned.`,
    );
  }
  return `GUID check:\n${lines.map((l) => `  ${l}`).join('\n')}`;
}

export function createUnityUiLayoutTool(
  workspacePath: string,
  deps: UiLayoutToolDeps = defaultUiLayoutDeps,
): AgentTool {
  return {
    name: 'unity_ui_layout',
    label: 'unity ui layout',
    description:
      'See how a .uxml document actually lays out — its own render, as text: every element as a box ' +
      '(position, size) with its key styles, plus a lint pass for bugs that compile clean and are invisible ' +
      'to unity_ui_toolkit: elements pushed off the panel, zero-size content, text clipped or below readable ' +
      'contrast, overlapping absolutely-positioned siblings, buttons under 32px, and HUD elements crowding a ' +
      "device's safe-area edge. Uses the SAME render pipeline the human preview does. Call this after writing " +
      'or editing a .uxml/.uss to see the result, before assuming a layout change worked.',
    parameters: schema,
    async execute(_id, params) {
      const { document: relPath, panel: panelParam, maxDepth, maxNodes, includeStyles = false, image = false } =
        params as Params;

      if (!relPath.toLowerCase().endsWith('.uxml')) {
        return txt(`unity_ui_layout only lays out .uxml documents — ${relPath} is not one.`);
      }

      const abs = resolveToCwd(relPath, workspacePath);
      const content = await deps.readFile(abs).catch(() => null);
      if (content === null) {
        return txt(
          `Could not read ${relPath}. Use unity_ui_toolkit to see this project's .uxml documents and their exact paths.`,
        );
      }

      const doc = parseUxml(content);
      if (!doc.root) {
        return txt(
          `${relPath} has no root element to lay out` +
            (doc.diagnostics.length > 0 ? ' — it does not parse as UXML.' : '.'),
        );
      }

      const guidMapObj = await deps.guidMap(workspacePath).catch(() => ({}) as Record<string, string>);
      const resolveGuid = async (guid: string) => guidMapObj[guid] ?? null;
      const loaded = await deps
        .loadStyleSheets(doc, relPath, workspacePath, resolveGuid)
        .catch((): LoadedStyles => ({ sheets: [], unresolved: [] }));

      const { info: panelInfo, note: panelNote } = await resolvePanel(
        relPath,
        workspacePath,
        panelParam,
        deps,
      );

      let probeResult: ProbeLayoutOutput;
      try {
        probeResult = await deps.probe({
          uxmlText: content,
          sheets: loaded.sheets,
          size: panelInfo.layoutSize,
          maxNodes,
        });
      } catch (e) {
        return txt(`Could not lay out ${relPath}: ${e instanceof Error ? e.message : String(e)}`);
      }

      const tree = renderLayoutTree(probeResult, { maxDepth, includeStyles });
      const findings = lintLayout(probeResult, panelInfo.layoutSize);

      const lines: string[] = [
        relPath,
        `Panel: ${panelInfo.confidenceLabel}  —  laid out at ${panelInfo.layoutSize.width} × ${panelInfo.layoutSize.height}`,
      ];
      if (panelNote) lines.push(panelNote);
      lines.push('', tree, '');
      lines.push(findings.length > 0 ? `Problems (${findings.length}):` : 'Problems: none');
      for (const f of findings) lines.push(findingLine(f));

      const notes = [...probeResult.notes, ...loaded.unresolved];
      if (probeResult.truncated) {
        notes.push(
          `Layout probe stopped at ${maxNodes ?? DEFAULT_MAX_NODES} nodes; pass a higher maxNodes to see the rest of the tree.`,
        );
      }
      if (notes.length > 0) {
        lines.push('', 'Notes:');
        for (const n of notes) lines.push(`  - ${n}`);
      }

      const guidSection = await pendingGuidSection(workspacePath, deps);
      if (guidSection) lines.push('', guidSection);

      if (image) lines.push('', IMAGE_NOT_AVAILABLE);

      return txt(cap(lines.join('\n')));
    },
  };
}
