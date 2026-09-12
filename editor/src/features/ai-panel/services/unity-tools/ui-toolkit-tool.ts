/**
 * `unity_ui_toolkit` — the project's UI Toolkit contract, for the agent.
 *
 * UI Toolkit joins three files through **strings**, and none of them can see
 * the others. The `.uxml` declares `name="hp-bar"`, the `.uss` declares
 * `.hud--danger`, and the C# reaches both with `root.Q<Label>("hp-bar")` and
 * `AddToClassList("hud--danger")`. A name that matches nothing compiles
 * cleanly, returns `null`, and throws a NullReferenceException only when that
 * screen is first opened — which in a game is usually not on the developer's
 * machine.
 *
 * Unity's own UI Builder structurally cannot check this: it has no view of your
 * C#. csharp-ls cannot either: to it these are ordinary string literals. The
 * join only exists in a process that holds the documents and a code index at
 * once, which is what this tool exposes.
 *
 * The snapshot is the analyzers' own (`uitoolkit-cache.ts`), so the agent and
 * UNITY0501 can never disagree about which element names exist — and the
 * four-rung suppression ladder (`resolveQueryName`) is honoured verbatim, so a
 * built-in control's part name is never reported as missing.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { txt, cap } from './text-result';
import type { UxmlDocument, UxmlNode } from '../../../../utils/uxml-model';
import { parseStyleRef } from '../../../../utils/uxml-model';
import { isUssProperty, ussPropertyRemedy } from '../../../../utils/uss-properties';
import { resolveQueryName, type LadderContext } from '../../../../utils/uitoolkit-refs';
import { describeUsage, type ElementUsage } from '../../../../utils/uxml-usage';
import type {
  UxmlIndex,
  UssIndex,
  CsUiRefIndex,
  ElementDecl,
} from '../../../unity-analyzers';

const schema = Type.Object({
  document: Type.Optional(
    Type.String({
      description:
        'A .uxml file (name or path) to show the element tree of, e.g. "HUD.uxml". Omit for the project inventory.',
    }),
  ),
  element: Type.Optional(
    Type.String({
      description:
        'An element name to resolve, e.g. "hp-bar" — says which document declares it, or that nothing does.',
    }),
  ),
  usages: Type.Optional(
    Type.Boolean({
      description:
        'With `element`: also list the C# sites that query it and the handlers they attach. Requires a project scan, so ask for it only when the answer depends on the code.',
    }),
  ),
  classes: Type.Optional(
    Type.Boolean({
      description:
        'Show the USS classes: declared in stylesheets, used in UXML, and referenced from C# — and where those three disagree.',
    }),
  ),
});
type Params = Static<typeof schema>;

/**
 * Injectable data access.
 *
 * The snapshot accessors and the usage scan reach their features through a
 * dynamic `import()` for the reason `input-actions-tool.ts` documents: the
 * `unity-analyzers` barrel pulls Monaco and the `uitoolkit` barrel pulls React,
 * either of which drags `stores/theme.ts` into Bun's DOM-less runtime, where its
 * module-scope `document` access kills the suite on import alone. Everything
 * imported statically above is a leaf module under `utils/`.
 */
export interface UiToolkitSnapshot {
  uxml: UxmlIndex;
  uss: UssIndex;
  csRefs: CsUiRefIndex;
}

export interface UiToolkitToolDeps {
  /** Prime the analyzers' snapshot and hand back the three indexes. */
  loadSnapshot: (workspacePath: string) => Promise<UiToolkitSnapshot | null>;
  findUsages: (workspacePath: string, names: string[]) => Promise<ElementUsage[]>;
}

const defaultDeps: UiToolkitToolDeps = {
  async loadSnapshot(workspacePath) {
    const mod = await import('../../../unity-analyzers');
    // Prime first: `execute` is async, so the tool never has to answer from the
    // cold null snapshot the synchronous analyzer rules must tolerate.
    await mod.loadUiToolkitIndex(workspacePath, mod.blankStringsAndComments);
    const uxml = mod.getUxmlIndex();
    const uss = mod.getUssIndex();
    if (!uxml || !uss) return null;
    return { uxml, uss, csRefs: mod.getCsUiRefIndex() };
  },
  async findUsages(workspacePath, names) {
    const [{ loadUsageIndex }, { blankStringsAndComments }] = await Promise.all([
      import('../../../uitoolkit'),
      import('../../../unity-analyzers'),
    ]);
    const index = await loadUsageIndex(workspacePath, names, blankStringsAndComments);
    return names.flatMap((n) => index.byElement.get(n) ?? []);
  },
};

const NO_UI_TEXT =
  'This project has no .uxml documents, so it does not use UI Toolkit for its UI. ' +
  'Do not write VisualElement/UIDocument code here unless the user is deliberately adopting UI Toolkit — ' +
  'check whether the project uses uGUI (Canvas, RectTransform, UnityEngine.UI) instead.';

/** Workspace-relative path, so output matches the file tree the user sees. */
function rel(path: string, workspacePath: string): string {
  const prefix = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

// ── Pure analysis ────────────────────────────────────────────────────────────

export interface UssProblem {
  path: string;
  property: string;
  remedy: string | null;
}

/** USS properties Unity does not implement — a silent no-op at runtime. */
export function invalidUssProperties(uss: UssIndex): UssProblem[] {
  const out: UssProblem[] = [];
  const seen = new Set<string>();
  for (const [path, sheet] of uss.docs) {
    for (const rule of sheet.rules) {
      for (const decl of rule.declarations) {
        // Custom properties (`--foo`) are USS's own variable syntax, always legal.
        if (decl.property.startsWith('--')) continue;
        if (isUssProperty(decl.property)) continue;
        const key = `${path}::${decl.property}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ path, property: decl.property, remedy: ussPropertyRemedy(decl.property) });
      }
    }
  }
  return out;
}

/**
 * Classes a `.uxml` uses that no stylesheet declares.
 *
 * Not automatically a bug — a class can be purely a C# handle, added and
 * removed with `AddToClassList`. So a class the C# references is excluded
 * rather than reported, exactly as the query ladder suppresses rung 4.
 */
export function undeclaredClasses(
  uxml: UxmlIndex,
  uss: UssIndex,
  csRefs: CsUiRefIndex,
): string[] {
  const out: string[] = [];
  for (const cls of uxml.classesToDocs.keys()) {
    if (uss.declaredClasses.has(cls)) continue;
    if (csRefs.loaded && csRefs.referencedClasses.has(cls)) continue;
    out.push(cls);
  }
  return out.sort();
}

function ladderFor(
  uxml: UxmlIndex,
  csRefs: CsUiRefIndex,
  associatedPath: string | null,
): LadderContext {
  return {
    associatedPath,
    associatedNames: null,
    projectNames: new Set(uxml.allNames),
    csAssignedNames: csRefs.loaded ? csRefs.assignedNames : null,
    allNames: uxml.allNames,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const MAX_NAMES_LISTED = 40;
const MAX_PROBLEMS_LISTED = 10;
const MAX_TREE_NODES = 200;

export function renderInventory(
  uxml: UxmlIndex,
  uss: UssIndex,
  csRefs: CsUiRefIndex,
  workspacePath: string,
): string {
  if (uxml.docCount === 0) return NO_UI_TEXT;

  const out = [`UI Toolkit: ${uxml.docCount} document(s), ${uss.docCount} stylesheet(s)`, ''];

  out.push('Documents (.uxml):');
  for (const [path, doc] of uxml.docs) {
    const named = [...uxml.namesToDocs].filter(([, paths]) => paths.includes(path)).length;
    const sheets = doc.styleRefs.length;
    const broken = doc.diagnostics.length;
    out.push(
      `  ${rel(path, workspacePath)}  —  ${named} named element(s), ${sheets} stylesheet ref(s)` +
        (broken > 0 ? `, ${broken} PARSE ERROR(S)` : ''),
    );
  }

  if (uss.docCount > 0) {
    out.push('', 'Stylesheets (.uss):');
    for (const [path, sheet] of uss.docs) {
      const classes = new Set(
        sheet.rules.flatMap((r) =>
          r.selectors.flatMap((s) =>
            s.parts.flatMap((p) => p.simples.filter((x) => x.kind === 'class').map((x) => x.name)),
          ),
        ),
      );
      out.push(`  ${rel(path, workspacePath)}  —  ${sheet.rules.length} rule(s), ${classes.size} class(es)`);
    }
  }

  const names = uxml.allNames;
  const shown = names.slice(0, MAX_NAMES_LISTED);
  out.push('', `Named elements (${names.length}):`);
  out.push(
    `  ${shown.join(', ')}${names.length > shown.length ? `, …${names.length - shown.length} more` : ''}`,
  );

  const undeclared = undeclaredClasses(uxml, uss, csRefs);
  const invalid = invalidUssProperties(uss);
  if (undeclared.length > 0 || invalid.length > 0) {
    out.push('', 'Problems:');
    if (undeclared.length > 0) {
      const list = undeclared.slice(0, MAX_PROBLEMS_LISTED);
      out.push(
        `  ${undeclared.length} class(es) used in UXML that no .uss declares and no C# references: ` +
          `${list.join(', ')}${undeclared.length > list.length ? `, …${undeclared.length - list.length} more` : ''}`,
      );
    }
    for (const p of invalid.slice(0, MAX_PROBLEMS_LISTED)) {
      out.push(
        `  ${rel(p.path, workspacePath)}: "${p.property}" is not a USS property` +
          (p.remedy ? ` — ${p.remedy}` : ' — Unity ignores it silently'),
      );
    }
  }

  if (!csRefs.loaded) {
    out.push(
      '',
      'The project-wide C# walk has not finished, so names assigned from code are not yet known. ' +
        'Nothing above is reported as missing on that basis.',
    );
  }

  out.push(
    '',
    'Q<T>("name") resolves against the named elements above. A name no document declares compiles, ' +
      'returns null, and throws only when that screen first opens — use these exact names.',
  );
  return out.join('\n');
}

function treeLines(node: UxmlNode, depth: number, out: string[]): void {
  if (out.length >= MAX_TREE_NODES) return;
  const indent = '  '.repeat(depth + 1);
  const name = node.name ? ` name="${node.name}"` : '';
  const classes = node.classes.length > 0 ? ` class="${node.classes.join(' ')}"` : '';
  const text = node.text ? ` text="${node.text}"` : '';
  out.push(`${indent}<${node.localName}${name}${classes}${text}>`);
  for (const child of node.children) treeLines(child, depth + 1, out);
}

export function renderDocument(
  path: string,
  doc: UxmlDocument,
  workspacePath: string,
): string {
  const out = [rel(path, workspacePath)];

  if (doc.diagnostics.length > 0) {
    out.push('', 'PARSE ERRORS — Unity will fail to load this document:');
    for (const d of doc.diagnostics) out.push(`  ${d.code}: ${d.message}`);
  }

  if (doc.styleRefs.length > 0) {
    out.push('', 'Stylesheets:');
    for (const ref of doc.styleRefs) {
      const parsed = parseStyleRef(ref.raw);
      out.push(`  ${parsed.path ?? ref.raw}${parsed.guid ? `  (guid ${parsed.guid})` : ''}`);
    }
  }

  if (doc.templates.length > 0) {
    out.push('', 'Templates:');
    for (const t of doc.templates) out.push(`  ${t.name} → ${t.raw}`);
  }

  out.push('', 'Element tree:');
  if (doc.root) {
    const lines: string[] = [];
    treeLines(doc.root, 0, lines);
    out.push(...lines);
    if (lines.length >= MAX_TREE_NODES) out.push('  …tree truncated');
  } else {
    out.push('  (no root element)');
  }

  out.push(
    '',
    'Only elements with a `name` are reachable from C# by name. Adding an element without a ' +
      'name means Q<T>() can never find it.',
  );
  return out.join('\n');
}

export function renderElement(
  name: string,
  decls: ElementDecl[],
  uxml: UxmlIndex,
  csRefs: CsUiRefIndex,
  workspacePath: string,
): string {
  if (decls.length > 0) {
    const out = [`${name} — declared in ${decls.length} place(s):`];
    for (const d of decls) {
      out.push(
        `  ${rel(d.path, workspacePath)}:${d.line}:${d.column}  <${d.tag}>` +
          (d.classes.length > 0 ? `  class="${d.classes.join(' ')}"` : ''),
      );
    }
    out.push('', `Query it with root.Q<${decls[0].tag}>("${name}") — the tag above is the element type.`);
    return out.join('\n');
  }

  const verdict = resolveQueryName(name, ladderFor(uxml, csRefs, null));
  switch (verdict.kind) {
    case 'builtin-part':
      return (
        `"${name}" is not declared in any .uxml, but it is a part name a built-in Unity control ` +
        'creates in its own constructor. Querying it is legitimate; no UXML change is needed.'
      );
    case 'assigned-in-code':
      return (
        `"${name}" is not declared in any .uxml, but some C# in this project assigns ` +
        `\`.name = "${name}"\`. The element is created at runtime, so this query is fine.`
      );
    case 'insufficient-data':
      return (
        `Not enough is loaded to judge "${name}" yet — the project-wide C# walk has not finished, ` +
        'so an element created in code would look missing. Retry, or treat this as unknown rather than absent.'
      );
    default: {
      const hint = verdict.suggestion ? ` Did you mean "${verdict.suggestion}"?` : '';
      return (
        `No .uxml in this project declares an element named "${name}", no built-in control uses it as a ` +
        `part name, and no C# assigns it.${hint} ` +
        'Do NOT query it: Q<T>() would return null, and the NullReferenceException surfaces only when ' +
        `that screen first opens. Either add name="${name}" to the UXML or use one of the declared names.`
      );
    }
  }
}

export function renderUsages(
  name: string,
  usages: ElementUsage[],
  workspacePath: string,
): string {
  if (usages.length === 0) {
    return `No C# reads "${name}". It is declared in the UXML but nothing queries it.`;
  }
  const out = [`C# usages of "${name}" (${usages.length}):`];
  for (const u of usages.slice(0, 40)) {
    out.push(`  ${rel(u.filePath, workspacePath)}:${u.line}  ${describeUsage(u)}`);
    out.push(`      ${u.snippet}`);
  }
  return out.join('\n');
}

export function renderClasses(
  uxml: UxmlIndex,
  uss: UssIndex,
  csRefs: CsUiRefIndex,
): string {
  const declared = new Set(uss.allClasses);
  const used = new Set(uxml.classesToDocs.keys());
  const fromCode = csRefs.loaded ? csRefs.referencedClasses : new Set<string>();

  const undeclared = undeclaredClasses(uxml, uss, csRefs);
  const unused = [...declared].filter((c) => !used.has(c) && !fromCode.has(c)).sort();

  const out = [
    `USS classes — ${declared.size} declared in stylesheets, ${used.size} used in UXML, ` +
      `${csRefs.loaded ? fromCode.size : '?'} referenced from C#`,
  ];

  if (undeclared.length > 0) {
    out.push(
      '',
      `Used in UXML, declared nowhere (${undeclared.length}) — these style nothing:`,
      `  ${undeclared.join(', ')}`,
    );
  }
  if (unused.length > 0) {
    const shown = unused.slice(0, MAX_NAMES_LISTED);
    out.push(
      '',
      `Declared in USS, never used (${unused.length}):`,
      `  ${shown.join(', ')}${unused.length > shown.length ? `, …${unused.length - shown.length} more` : ''}`,
    );
  }
  if (undeclared.length === 0 && unused.length === 0) {
    out.push('', 'Every declared class is used and every used class is declared.');
  }
  if (!csRefs.loaded) {
    out.push(
      '',
      'The C# walk has not finished, so a class only ever added with AddToClassList may appear in ' +
        'either list above. Treat both as provisional.',
    );
  }
  return out.join('\n');
}

// ── Tool ─────────────────────────────────────────────────────────────────────

function findDocument(uxml: UxmlIndex, query: string): { path: string; doc: UxmlDocument } | null {
  const lower = query.toLowerCase();
  for (const [path, doc] of uxml.docs) {
    if (path === query) return { path, doc };
  }
  for (const [path, doc] of uxml.docs) {
    const p = path.toLowerCase();
    if (p.endsWith(lower) || baseName(p) === lower) return { path, doc };
  }
  return null;
}

export function createUnityUiToolkitTool(
  workspacePath: string,
  deps: UiToolkitToolDeps = defaultDeps,
): AgentTool {
  return {
    name: 'unity_ui_toolkit',
    label: 'unity ui toolkit',
    description:
      "Read the project's UI Toolkit setup: every .uxml document and its element tree, every .uss " +
      'stylesheet and the classes it declares, which element names exist, and which C# reads them. ' +
      'Call this BEFORE writing any Q<T>("name") lookup, adding a USS class, or editing a .uxml — a name ' +
      'that matches nothing compiles, returns null, and throws only when that screen first opens, and an ' +
      'unsupported USS property is ignored with no error at all. ' +
      'Also says whether the project uses UI Toolkit or uGUI, so you do not write the wrong UI stack.',
    parameters: schema,
    async execute(_id, params) {
      const { document, element, usages = false, classes = false } = params as Params;

      // Gated here, not at registration: the snapshot resolves asynchronously,
      // and conditioning the tool set on it would change the provider's cached
      // prompt prefix mid-conversation (graphify-tools.ts §1).
      let snapshot: UiToolkitSnapshot | null;
      try {
        snapshot = await deps.loadSnapshot(workspacePath);
      } catch {
        return txt(
          'Could not read this project\'s .uxml/.uss files. Fall back to the read tool on the document path.',
        );
      }
      if (!snapshot) {
        return txt(
          'No UI Toolkit snapshot for this workspace yet. Retry once, or use read/list on the .uxml file.',
        );
      }
      const { uxml, uss, csRefs } = snapshot;
      if (uxml.docCount === 0) return txt(NO_UI_TEXT);

      if (document) {
        const found = findDocument(uxml, document);
        if (!found) {
          const known = [...uxml.docs.keys()].map((p) => rel(p, workspacePath)).join(', ');
          return txt(`No .uxml matching "${document}". Documents in this project: ${known}.`);
        }
        return txt(cap(renderDocument(found.path, found.doc, workspacePath)));
      }

      if (element) {
        const decls = uxml.elements.get(element) ?? [];
        const sections = [renderElement(element, decls, uxml, csRefs, workspacePath)];
        if (usages) {
          const hits = await deps.findUsages(workspacePath, [element]).catch(() => []);
          sections.push(renderUsages(element, hits, workspacePath));
        }
        return txt(cap(sections.join('\n\n')));
      }

      if (classes) return txt(cap(renderClasses(uxml, uss, csRefs)));

      return txt(cap(renderInventory(uxml, uss, csRefs, workspacePath)));
    },
  };
}
