/**
 * What is wrong with a Unity asset the agent just wrote.
 *
 * `analyzer-gate.ts` feeds Unity analyzer findings back into the tool result so
 * the agent self-corrects, and it has always been `.cs`-only:
 *
 *     if (!p.toLowerCase().endsWith('.cs')) return res;
 *
 * So a write to `.uxml`, `.uss`, `.inputactions` or `.asset` went out entirely
 * unchecked. That matters more here than it would in most codebases, because
 * none of these four formats fails loudly: Unity ignores an unknown USS
 * property, silently drops a value whose key it cannot match, and reports a
 * malformed UXML only when something tries to load it. The agent writes,
 * observes success, and moves on.
 *
 * Everything in this module is pure and imports only leaf modules under
 * `utils/`, so it runs under Bun's DOM-less test runtime. The gate that calls
 * it (`asset-gate.ts`) owns the I/O.
 */

import { parseUxml, parseStyleRef } from '../../../../utils/uxml-model';
import { parseUss } from '../../../../utils/uss-model';
import { isUssProperty, ussPropertyRemedy } from '../../../../utils/uss-properties';
import { parseInputActions, findBindingConflicts } from '../../../../utils/inputactions-model';

export interface AssetFinding {
  /** Short stable code, the way analyzer findings carry `UNITY0501`. */
  code: string;
  message: string;
}

/** What the UXML check needs to know about the rest of the project. */
export interface UxmlCheckContext {
  /** Every class any `.uss` in the project declares. */
  declaredClasses: ReadonlySet<string>;
  /** Every class the project's C# names. `null` until the walk completes. */
  csReferencedClasses: ReadonlySet<string> | null;
  /** Workspace-relative paths of every `.uss` in the project. */
  ussPaths: readonly string[];
}

/** Extensions this module knows how to check. `.cs` is deliberately absent. */
export function isCheckableAsset(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('.uxml') ||
    lower.endsWith('.uss') ||
    lower.endsWith('.inputactions') ||
    lower.endsWith('.asset')
  );
}

// ── UXML ─────────────────────────────────────────────────────────────────────

/**
 * Parse errors, stylesheet references that point at nothing, and classes
 * nothing styles.
 *
 * The class check suppresses on the same rung `resolveQueryName` does: a class
 * the C# names is added at runtime with `AddToClassList`, so it is legitimately
 * absent from every stylesheet. With the C# walk unfinished we cannot know
 * that, so the check stays silent rather than guessing — reporting a class we
 * have not finished looking for is exactly the false positive that would teach
 * the agent to ignore this gate.
 */
export function checkUxml(text: string, ctx: UxmlCheckContext): AssetFinding[] {
  const out: AssetFinding[] = [];
  const doc = parseUxml(text);

  for (const d of doc.diagnostics) {
    out.push({
      code: `uxml-${d.code}`,
      message: `${d.message} — Unity will fail to load this document.`,
    });
  }

  for (const ref of doc.styleRefs) {
    const parsed = parseStyleRef(ref.raw);
    // Only `project://` refs carry a workspace-rooted path we can check without
    // resolving relative to this document's own location.
    if (parsed.kind !== 'project' || !parsed.path) continue;
    const target = parsed.path.toLowerCase();
    if (ctx.ussPaths.some((p) => p.toLowerCase() === target)) continue;
    out.push({
      code: 'uxml-style-missing',
      message:
        `<Style src> points at "${parsed.path}", which is not a .uss file in this project. ` +
        'The document will load with none of those styles applied and no error.',
    });
  }

  if (ctx.csReferencedClasses !== null) {
    const seen = new Set<string>();
    const walk = (node: typeof doc.root): void => {
      if (!node) return;
      for (const cls of node.classes) {
        if (seen.has(cls)) continue;
        seen.add(cls);
        if (ctx.declaredClasses.has(cls)) continue;
        if (ctx.csReferencedClasses!.has(cls)) continue;
        out.push({
          code: 'uxml-class-undeclared',
          message:
            `class "${cls}" is not declared in any .uss and is not referenced from C#, so it styles ` +
            'nothing. Add a rule for it, or remove it.',
        });
      }
      for (const child of node.children) walk(child);
    };
    walk(doc.root);
  }

  return out;
}

// ── USS ──────────────────────────────────────────────────────────────────────

/**
 * Properties Unity's USS does not implement.
 *
 * USS looks like CSS and is not CSS. `box-shadow`, `float`, `grid-*` and
 * friends parse fine, apply nothing, and produce no message anywhere — this is
 * the single most common way a UI Toolkit style silently does nothing.
 */
export function checkUss(text: string, path: string): AssetFinding[] {
  const out: AssetFinding[] = [];
  const sheet = parseUss(text, path);
  const seen = new Set<string>();
  for (const rule of sheet.rules) {
    for (const decl of rule.declarations) {
      // `--foo` is USS's own custom-property syntax and is always legal.
      if (decl.property.startsWith('--')) continue;
      if (isUssProperty(decl.property)) continue;
      if (seen.has(decl.property)) continue;
      seen.add(decl.property);
      const remedy = ussPropertyRemedy(decl.property);
      out.push({
        code: 'uss-unknown-property',
        message:
          `"${decl.property}" is not a USS property${remedy ? ` — ${remedy}` : ''}. ` +
          'Unity ignores it silently, so the style will simply not apply.',
      });
    }
  }
  return out;
}

// ── .inputactions ────────────────────────────────────────────────────────────

/**
 * A corrupted asset, or a binding that starves another action.
 *
 * The parse check is the important one. `.inputactions` is JSON carrying ids
 * Unity matches on; a hand-edit that breaks it makes the whole asset
 * unloadable, and the failure appears in Unity, not here.
 */
export function checkInputActions(text: string): AssetFinding[] {
  const parsed = parseInputActions(text);
  if (!parsed.doc) {
    return [
      {
        code: 'inputactions-parse',
        message:
          `this .inputactions asset no longer parses (${parsed.error ?? 'invalid JSON'}). ` +
          'Unity cannot load it at all. Restore it and use unity_input_edit, which round-trips the ' +
          'format byte-for-byte instead of rewriting it.',
      },
    ];
  }

  const out: AssetFinding[] = [];
  const conflicts = findBindingConflicts(parsed.doc);
  for (const c of conflicts) {
    out.push({
      code: 'inputactions-starved',
      message:
        `${c.path} is claimed by ${c.winner} first, so ${c.starved.join(', ')} never fire${c.starved.length === 1 ? 's' : ''} ` +
        'at runtime. Declaration order decides; nothing warns about this in Unity.',
    });
  }
  return out;
}

// ── .asset ───────────────────────────────────────────────────────────────────

/** The subset of the Rust snapshot this check needs. */
export interface AssetDocumentInfo {
  classId: string;
  scriptGuid: string | null;
}

/** Unity's class id for MonoBehaviour/ScriptableObject documents. */
const MONO_BEHAVIOUR_CLASS_ID = '114';

/**
 * A serialized asset that no longer reads back.
 *
 * `null` means the Rust reader could not parse it — the write corrupted the
 * document. A `114` document with no `m_Script` guid is the classic "Missing
 * Script" corruption: the asset survives, its type link does not, and every
 * value on it is orphaned.
 */
export function checkAssetDocument(info: AssetDocumentInfo | null): AssetFinding[] {
  if (info === null) {
    return [
      {
        code: 'asset-parse',
        message:
          'this .asset no longer reads back as a Unity serialized document. Restore it and change ' +
          'values with unity_asset_edit, which writes byte-exactly through the guarded writer — ' +
          'a text edit to Unity YAML can break fileIDs and GUIDs with no visible error.',
      },
    ];
  }
  if (info.classId === MONO_BEHAVIOUR_CLASS_ID && !info.scriptGuid) {
    return [
      {
        code: 'asset-script-missing',
        message:
          'the m_Script reference on this asset is gone, so Unity will show it as "Missing Script" ' +
          'and every value on it is orphaned. Restore the m_Script guid.',
      },
    ];
  }
  return [];
}

// ── Result formatting ────────────────────────────────────────────────────────

/** Label per extension, so the note names the format the agent just wrote. */
export function gateLabelFor(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.uxml')) return 'Unity UXML';
  if (lower.endsWith('.uss')) return 'Unity USS';
  if (lower.endsWith('.inputactions')) return 'Unity input actions';
  return 'Unity asset';
}

/**
 * The note appended to the tool result.
 *
 * Shaped exactly like `analyzer-gate.ts`'s so the two read the same to the
 * model — and so `compaction.ts`'s `REPAIR_SENTINELS` can protect both with the
 * same mechanism (a repair instruction elided under compaction is a repair that
 * never happens).
 */
export function formatFindings(path: string, findings: readonly AssetFinding[]): string {
  const label = gateLabelFor(path);
  const body = findings.map((f) => `  • ${f.code}: ${f.message}`).join('\n');
  return (
    `\n\n[${label}] ${findings.length} issue(s) introduced by this write — ` +
    `fix them before finishing:\n${body}`
  );
}
