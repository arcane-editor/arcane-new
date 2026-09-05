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

import { parseUxml, parseStyleRef, type UxmlNode, type UxmlDocument } from '../../../../utils/uxml-model';
import { parseUss, USS_PSEUDO_CLASSES } from '../../../../utils/uss-model';
import { isUssProperty, ussPropertyRemedy, USS_PROPERTY_REGISTRY } from '../../../../utils/uss-properties';
import {
  attributesFor,
  isKnownUxmlElement,
  knownUxmlElementNames,
} from '../../../../utils/uxml-controls';
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
  /**
   * Workspace-relative path of the document being checked.
   *
   * Optional because two of the three callers (`verified-pass.ts` re-reading a
   * touched file, an ad-hoc check) do not always have it. Without it a RELATIVE
   * `<Style src>` cannot be resolved — it is relative to this document — so
   * that one check stays silent rather than guessing a base directory.
   */
  documentPath?: string;
}

/**
 * The namespace UI Toolkit's own controls live in.
 *
 * Element and attribute checks apply to this namespace ONLY. A custom control
 * (`<local:HealthBar>` under `xmlns:local="MyGame.UI"`) is C# this module cannot
 * see, so flagging it would be a guess — and a check that guesses is the one
 * that teaches the agent to ignore every finding it emits.
 */
const UI_TOOLKIT_NAMESPACE = 'UnityEngine.UIElements';

/**
 * Codes that mean "Unity will not load this, or will load it with the styling
 * silently missing" — as opposed to "this is suspicious".
 *
 * Single source of truth for both sides of the write path: `ui-write-tool.ts`
 * refuses a write when one of these is present, and `asset-gate.ts` reports the
 * same set after a raw `write`/`edit` landed. They used to keep separate lists
 * and could disagree about which findings were fatal.
 */
const BLOCKING_CODES: ReadonlySet<string> = new Set([
  // Parse diagnostics — `checkUxml` prefixes every `UxmlDiagnostic.code`.
  'uxml-unclosed-tag',
  'uxml-unexpected-close',
  'uxml-bad-attr',
  'uxml-no-root',
  'uxml-misspelled-element',
  'uxml-template-missing',
  'uxml-style-missing',
  'uss-css-only-property',
  'uss-misspelled-property',
  'uss-bad-unit',
  'inputactions-parse',
  'asset-parse',
  'asset-script-missing',
]);

/**
 * True when this finding should refuse the write rather than annotate it.
 *
 * Everything else is reported and the write proceeds: an unknown element may be
 * a control this table has not caught up with, an unknown property may be a
 * registry gap, and refusing on either would strand the agent on a document it
 * cannot fix.
 */
export function isBlockingFinding(finding: AssetFinding): boolean {
  return BLOCKING_CODES.has(finding.code);
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

// ── Near-miss suggestions ────────────────────────────────────────────────────

/**
 * How far off a name may be and still be treated as a typo rather than an
 * unknown thing.
 *
 * The distinction is load-bearing: a typo is refused (the fix is certain), an
 * unknown name is only reported (our table may simply be behind). Short names
 * get a tighter budget because at length 3 a distance of 2 relates almost
 * anything to anything.
 */
function suggestionBudget(name: string): number {
  return name.length <= 4 ? 1 : 2;
}

/** Levenshtein distance, abandoned as soon as it cannot come in under `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

/**
 * The candidate `name` was most likely meant to be, or `null`.
 *
 * Case-insensitive, so a correctly spelled but wrongly cased name comes back as
 * its own suggestion — `<ui:button>` really is broken in Unity, and "did you
 * mean Button" is the whole fix.
 */
function nearestName(name: string, candidates: readonly string[]): string | null {
  const needle = name.toLowerCase();
  const budget = suggestionBudget(name);
  let best: string | null = null;
  let bestDistance = budget + 1;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase(), budget);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      if (distance === 0) break;
    }
  }
  return bestDistance <= budget ? best : null;
}

// ── UXML ─────────────────────────────────────────────────────────────────────

/** Normalise `a/b/../c` and `./c` without touching the filesystem. */
function normaliseRelative(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Resolve a `<Style src>` written relative to the document that carries it. */
function resolveRelativeTo(documentPath: string, href: string): string {
  if (href.startsWith('Assets/') || href.startsWith('Packages/')) return normaliseRelative(href);
  const dir = documentPath.split('/').slice(0, -1).join('/');
  return normaliseRelative(dir ? `${dir}/${href}` : href);
}

/**
 * Which prefixes in this document bind to UI Toolkit's own namespace.
 *
 * The default namespace is keyed by the empty string, which is also how an
 * unprefixed tag resolves — so `<Button>` under `xmlns="UnityEngine.UIElements"`
 * is checked and `<Button>` in a document that declares nothing is not.
 */
function uiToolkitPrefixes(doc: UxmlDocument): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [prefix, uri] of Object.entries(doc.namespaces)) {
    if (uri === UI_TOOLKIT_NAMESPACE) out.add(prefix);
  }
  return out;
}

/** True when this element is one UI Toolkit itself defines, rather than a custom control. */
function isUiToolkitElement(node: UxmlNode, prefixes: ReadonlySet<string>): boolean {
  return prefixes.has(node.ns ?? '');
}

/**
 * Parse errors, stylesheet references that point at nothing, elements and
 * attributes UI Toolkit does not have, and classes nothing styles.
 *
 * The class check suppresses on the same rung `resolveQueryName` does: a class
 * the C# names is added at runtime with `AddToClassList`, so it is legitimately
 * absent from every stylesheet. With the C# walk unfinished we cannot know
 * that, so the check stays silent rather than guessing — reporting a class we
 * have not finished looking for is exactly the false positive that would teach
 * the agent to ignore this gate.
 *
 * The element and attribute checks apply the same discipline through the
 * namespace: only tags bound to `UnityEngine.UIElements` are checked at all, so
 * a project's own controls are never reported, and no symbol index has to be
 * warm for the check to mean something.
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
    if (!parsed.path) continue;
    // A `project://` ref is already workspace-rooted. A relative one is
    // relative to THIS document, so it can only be resolved when the caller
    // said which document this is.
    let target: string | null = null;
    if (parsed.kind === 'project') target = parsed.path;
    else if (ctx.documentPath) target = resolveRelativeTo(ctx.documentPath, parsed.path);
    if (!target) continue;
    const lower = target.toLowerCase();
    if (ctx.ussPaths.some((p) => p.toLowerCase() === lower)) continue;
    out.push({
      code: 'uxml-style-missing',
      message:
        `<Style src> points at "${target}", which is not a .uss file in this project. ` +
        'The document will load with none of those styles applied and no error.',
    });
  }

  // `<ui:Instance template="X">` with no `<ui:Template name="X">` above it.
  // Unity raises this at load, and the whole document fails with it.
  const declaredTemplates = new Set(doc.templates.map((t) => t.name));
  const reportedTemplates = new Set<string>();
  for (const instance of doc.instances) {
    if (declaredTemplates.has(instance.templateName)) continue;
    if (reportedTemplates.has(instance.templateName)) continue;
    reportedTemplates.add(instance.templateName);
    out.push({
      code: 'uxml-template-missing',
      message:
        `<Instance template="${instance.templateName}"> has no matching <Template name="${instance.templateName}" src="..."> ` +
        'in this document. Unity fails to load the whole document, not just the instance.',
    });
  }

  const prefixes = uiToolkitPrefixes(doc);
  const knownElements = knownUxmlElementNames();
  const reportedElements = new Set<string>();
  const reportedAttributes = new Set<string>();
  const namesSeen = new Set<string>();
  const reportedDuplicateNames = new Set<string>();

  const walkElements = (node: UxmlNode | null): void => {
    if (!node) return;

    if (node.name) {
      if (namesSeen.has(node.name) && !reportedDuplicateNames.has(node.name)) {
        reportedDuplicateNames.add(node.name);
        out.push({
          code: 'uxml-duplicate-name',
          message:
            `two elements are named "${node.name}". Q<T>("${node.name}") returns the first one in ` +
            'document order and nothing reports the other, so half the wiring silently does nothing.',
        });
      }
      namesSeen.add(node.name);
    }

    if (isUiToolkitElement(node, prefixes)) {
      if (!isKnownUxmlElement(node.localName)) {
        if (!reportedElements.has(node.localName)) {
          reportedElements.add(node.localName);
          const suggestion = nearestName(node.localName, knownElements);
          if (suggestion) {
            out.push({
              code: 'uxml-misspelled-element',
              message:
                `<${node.rawName}> is not a UI Toolkit element — did you mean "${suggestion}"? ` +
                'Tag names are case-sensitive, and Unity fails to load a document with an unknown one.',
            });
          } else {
            out.push({
              code: 'uxml-unknown-element',
              message:
                `<${node.rawName}> is not a built-in UI Toolkit element. If it is a custom control, ` +
                'declare its namespace on the root (xmlns:local="Your.Namespace") and use that prefix; ' +
                'if it is not, Unity will fail to load this document.',
            });
          }
        }
      } else {
        const allowed = attributesFor(node.localName);
        if (allowed) {
          for (const attr of node.attrs) {
            // Any prefixed attribute (`xmlns:ui`, `xsi:schemaLocation`) belongs
            // to XML itself rather than to the control, and none of them is a
            // UI Toolkit property.
            if (attr.name.includes(':')) continue;
            if (allowed.has(attr.name)) continue;
            const key = `${node.localName}/${attr.name}`;
            if (reportedAttributes.has(key)) continue;
            reportedAttributes.add(key);
            out.push({
              code: 'uxml-unknown-attribute',
              message:
                `<${node.rawName}> has no "${attr.name}" attribute. Unity drops an unrecognised ` +
                'attribute at import without a message, so whatever it was meant to set stays at its default.',
            });
          }
        }
      }
    }

    for (const child of node.children) walkElements(child);
  };
  walkElements(doc.root);

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
 * Length units USS does not implement, mapped to what to write instead.
 *
 * USS understands `px` and `%` and nothing else. `font-size: 1.2rem` parses,
 * imports, and then applies nothing — the element keeps the inherited size and
 * no message is produced anywhere, which makes this indistinguishable from a
 * cascade problem when you are looking at the result.
 */
/**
 * Exported so the design prompt can list these as "refused" from the same table
 * that refuses them. A prompt that names a different set from the validator is
 * how a model learns to distrust the validator.
 */
export const UNSUPPORTED_UNITS: ReadonlySet<string> = new Set([
  'em', 'rem', 'vh', 'vw', 'vmin', 'vmax', 'pt', 'pc', 'ch', 'ex',
  'cm', 'mm', 'in', 'q', 'fr',
]);

/** A number followed by letters — `1.2rem`, `16px`, `0`. Whole tokens only. */
const NUMERIC_TOKEN = /(^|[\s,(])(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)/gi;

/** Units used by a declaration's value that USS will silently drop. */
function badUnitsIn(value: string): string[] {
  const found = new Set<string>();
  // `url(...)` can carry anything; a filename is not a length.
  const scrubbed = value.replace(/url\([^)]*\)/gi, ' ');
  for (const match of scrubbed.matchAll(NUMERIC_TOKEN)) {
    const unit = match[3].toLowerCase();
    if (unit && UNSUPPORTED_UNITS.has(unit)) found.add(unit);
  }
  return [...found];
}

/**
 * Properties Unity's USS does not implement, values it cannot express, and
 * selectors it drops.
 *
 * USS looks like CSS and is not CSS. `box-shadow`, `float`, `grid-*` and
 * friends parse fine, apply nothing, and produce no message anywhere — this is
 * the single most common way a UI Toolkit style silently does nothing.
 *
 * The property findings are split three ways on purpose, because only two of
 * them are certain enough to refuse a write over: a property in the CSS-only
 * table is known-wrong and carries its own remedy, a near-miss on a real
 * property is a typo, and anything else may simply be a gap in
 * `USS_PROPERTY_REGISTRY` — which is a reason to say so, not to refuse.
 */
export function checkUss(text: string, path: string): AssetFinding[] {
  const out: AssetFinding[] = [];
  const sheet = parseUss(text, path);
  const seenProperty = new Set<string>();
  const seenUnit = new Set<string>();
  const seenPseudo = new Set<string>();
  const seenSelector = new Set<string>();

  for (const rule of sheet.rules) {
    for (const selector of rule.selectors) {
      // `+`, `~` and `[attr=...]` are CSS combinators and selectors USS has no
      // parser for; `::part`-style pseudo-elements likewise. Unity drops the
      // whole RULE, so everything it declared goes with it.
      const construct = unsupportedSelectorConstruct(selector.source);
      if (construct && !seenSelector.has(selector.source)) {
        seenSelector.add(selector.source);
        out.push({
          code: 'uss-unsupported-selector',
          message:
            `"${selector.source}" uses ${construct}, which USS has no selector syntax for. ` +
            'Unity drops the entire rule, so every declaration inside it is lost. USS supports ' +
            'type, .class, #name, *, descendant and > only.',
        });
      }

      for (const part of selector.parts) {
        for (const simple of part.simples) {
          if (simple.kind !== 'pseudo' || !simple.name) continue;
          if (USS_PSEUDO_CLASSES.has(simple.name)) continue;
          if (seenPseudo.has(simple.name)) continue;
          seenPseudo.add(simple.name);
          out.push({
            code: 'uss-unknown-pseudo',
            message:
              `":${simple.name}" is not a USS pseudo-class, so Unity drops the rule that uses it. ` +
              `USS has :${[...USS_PSEUDO_CLASSES].sort().join(', :')}.`,
          });
        }
      }
    }

    for (const decl of rule.declarations) {
      const units = badUnitsIn(decl.value);
      for (const unit of units) {
        const key = `${decl.property}:${unit}`;
        if (seenUnit.has(key)) continue;
        seenUnit.add(key);
        out.push({
          code: 'uss-bad-unit',
          message:
            `"${decl.property}: ${decl.value.trim()}" uses "${unit}", which USS does not support. ` +
            'USS has px and % only — Unity drops the declaration silently and the property keeps ' +
            'its inherited or default value.',
        });
      }

      // `--foo` is USS's own custom-property syntax and is always legal.
      if (decl.property.startsWith('--')) continue;
      if (isUssProperty(decl.property)) continue;
      if (seenProperty.has(decl.property)) continue;
      seenProperty.add(decl.property);

      const remedy = ussPropertyRemedy(decl.property);
      if (remedy) {
        out.push({
          code: 'uss-css-only-property',
          message:
            `"${decl.property}" is a CSS property USS does not implement — ${remedy} ` +
            'Unity ignores it silently, so the style will simply not apply.',
        });
        continue;
      }

      const suggestion = nearestName(decl.property, USS_PROPERTY_REGISTRY);
      if (suggestion) {
        out.push({
          code: 'uss-misspelled-property',
          message:
            `"${decl.property}" is not a USS property — did you mean "${suggestion}"? ` +
            'Unity ignores an unrecognised property silently, so this declaration does nothing.',
        });
        continue;
      }

      out.push({
        code: 'uss-unknown-property',
        message:
          `"${decl.property}" is not a USS property. ` +
          'Unity ignores it silently, so the style will simply not apply.',
      });
    }
  }
  return out;
}

/** Names the CSS construct a selector uses that USS cannot parse, or `null`. */
function unsupportedSelectorConstruct(source: string): string | null {
  if (source.includes('::')) return 'a pseudo-element (::)';
  if (source.includes('[')) return 'an attribute selector ([...])';
  // Bare, because `.a+.b` is written without spaces as often as with them and
  // `compileSelector` silently folds it into one compound. No USS selector token
  // can legitimately contain either character.
  if (source.includes('+')) return 'the adjacent-sibling combinator (+)';
  if (source.includes('~')) return 'the general-sibling combinator (~)';
  return null;
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
