# Arcane Premium Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Arcane Dark and Arcane Light around a five-step "Recessed Chrome" surface ramp and a Unity-semantic code palette, with contrast enforced by tests.

**Architecture:** Three independent layers. (1) Theme *data* — `ui`, `monaco` and `terminal` blocks in the definition files; pure values, no logic. (2) A *contract test* that makes syntax contrast a build failure instead of a thing nobody checks. (3) A *decoration layer* that colors Unity-meaningful identifiers via Monaco `inlineClassName` decorations driven by CSS variables the theme already publishes.

**Tech Stack:** TypeScript, React 19, Monaco Editor, Zustand, Bun test, Tauri v2.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-arcane-premium-theme-design.md`.
- Deep Modules architecture: import features **only** via their `index.ts` barrel. `bun run check:modules` enforces this and runs inside `bun run verify`.
- Adding a key to `UiColors` **requires** adding it to all six definitions — the compiler enforces it. Place it under the correct `// ── CLASS ──` header in `types.ts`; `theme-contract.test.ts` parses those headers to derive each token's class.
- SURFACE and FILL tokens must be fully opaque. OVERLAY tokens must be translucent. SHADOW tokens must be complete `box-shadow` lists.
- The four VS Code-derived themes (`dark-plus`, `light-plus`, `dracula`, `monokai`) stay faithful to their originals. Give them new tokens derived from tokens they already define; never restyle them.
- `bun run verify` must pass before the work is done. A `SKIPPED` from `verify:intellisense` is **not** a pass — say so plainly rather than reporting green.
- Commit on the current branch (`heads/v0.3.0`). Never commit directly on `dev`. Stage explicit paths — `git add -A` from `editor/` stages the whole repo.

---

## File Structure

**Modified:**
- `editor/src/features/theme/types.ts` — four new `UiColors` keys
- `editor/src/features/theme/definitions/arcane-dark.ts` — surfaces, syntax, Unity tokens
- `editor/src/features/theme/definitions/arcane-light.ts` — same, mirrored
- `editor/src/features/theme/definitions/{dark-plus,light-plus,dracula,monokai}.ts` — four derived tokens only
- `editor/src/features/theme/theme-contract.test.ts` — Monaco/terminal contrast block
- `editor/src/features/csharp/services/csharp-decorations.ts` — rewritten
- `editor/src/features/csharp/index.ts` — barrel exports
- `editor/src/features/editor/components/EditorPanel.tsx` — wire the decoration layer
- `editor/src/features/app-shell/components/{ActivityBar,RightActivityBar}.tsx` — icon size
- `editor/src/App.css` — Unity decoration classes, density, font var
- `editor/index.html` — anti-FOUC `THEMES` map
- `editor/src/main.tsx` — font import
- `editor/package.json` — font deps

**Created:**
- `editor/src/features/csharp/services/unity-decorations.test.ts` — unit tests for the pure classifier

**Design note on the split:** `csharp-decorations.ts` currently mixes regex classification with Monaco calls, which makes it untestable without a DOM. The rewrite separates a pure `computeUnityDecorations(text)` from a thin `attachUnityDecorations(editor, monaco)`. Only the pure half gets unit tests; the attach half follows the established pattern in `better-comments.ts` and is exercised by hand.

---

### Task 1: Monaco contrast test + Arcane Dark syntax palette

**Files:**
- Modify: `editor/src/features/theme/theme-contract.test.ts` (append after line 193, before the stylesheet-references block)
- Modify: `editor/src/features/theme/definitions/arcane-dark.ts:78-171`

**Interfaces:**
- Consumes: existing `contrast()`, `parseColor()`, `relativeLuminance()` helpers at `theme-contract.test.ts:31-62`; `themes` array at line 25.
- Produces: `CONTRAST_ENFORCED` allowlist constant, extended in Task 3.

- [ ] **Step 1: Write the failing test**

Append to `theme-contract.test.ts` after the `describe.each` block that ends at line 193:

```typescript
// ─── syntax contrast ─────────────────────────────────────────────────
//
// The `ui` contrast tests above have existed for a while. `monaco.rules` and
// `monaco.colors` never had any, which is how `comment` sat at 2.72:1 in
// arcane-dark and 2.75:1 in arcane-light through a green suite — roughly 40%
// of a typical C# file rendered below the AA floor.
//
// Enforced for the Arcane themes ONLY. The other four are faithful ports and
// their palettes are upstream's decision, not ours; an audit at the time of
// writing found monokai with 11 rules under 4.5:1 (its signature #F92672 sits
// at 3.93) and dracula's canonical comment blue #6272A4 at 3.03. Holding them
// to AA would mean not shipping Monokai or Dracula.
const CONTRAST_ENFORCED = new Set(['arcane-dark']);

const enforced = themes.filter((t) => CONTRAST_ENFORCED.has(t.id));

describe.each(enforced.map((t) => [t.id, t] as const))('%s syntax contrast', (_id, theme) => {
  const bg = theme.monaco.colors['editor.background'];

  it('declares an editor background to measure against', () => {
    expect(parseColor(bg)).not.toBeNull();
  });

  // `monaco.rules` foregrounds are bare hex with no leading '#'.
  it('every syntax rule clears WCAG AA on the editor background', () => {
    const failures = theme.monaco.rules
      .filter((r) => r.foreground)
      .map((r) => [r.token, `#${r.foreground!.replace(/^#/, '')}`] as const)
      .map(([token, fg]) => [token, fg, contrast(fg, bg)] as const)
      .filter(([, , ratio]) => ratio < 4.5)
      .map(([token, fg, ratio]) => `${token}=${fg} ${ratio.toFixed(2)}`);
    expect([...new Set(failures)]).toEqual([]);
  });

  // Line numbers are supporting UI, not body copy: 3:1, not 4.5:1.
  it('line numbers clear the 3:1 non-text floor', () => {
    const failures: string[] = [];
    for (const key of ['editorLineNumber.foreground', 'editorLineNumber.activeForeground']) {
      const fg = theme.monaco.colors[key];
      if (!fg) continue;
      const ratio = contrast(fg, bg);
      if (ratio < 3) failures.push(`${key}=${fg} ${ratio.toFixed(2)}`);
    }
    expect(failures).toEqual([]);
  });

  it('terminal text clears WCAG AA on the terminal background', () => {
    const ratio = contrast(theme.terminal.foreground, theme.terminal.background);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/features/theme/theme-contract.test.ts`

Expected: FAIL. Two assertions break — the syntax-rule test lists `comment=#5C5965 2.72`, `delimiter=#7E7B86 4.49`, `meta.brace.round=#7E7B86 4.49`, `meta.brace.square=#7E7B86 4.49`, `punctuation.separator=#7E7B86 4.49`; the line-number test lists `editorLineNumber.foreground=#3A3845 1.62`.

- [ ] **Step 3: Replace the `rules` array in `arcane-dark.ts`**

Replace lines 81-135 (the whole `rules: [...]` array) with:

```typescript
    rules: [
      // Six roles, each with its own hue. Gold is deliberately absent: it is
      // the chrome accent, and it used to resolve eight of these tokens at
      // once, which is why `public` and `Awake` were nearly the same colour.
      // It returns only via the Unity decoration layer, on the ~4 identifiers
      // per file the engine actually calls.
      { token: 'comment', foreground: '827E94', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'C79BE0' },
      { token: 'string', foreground: '8FBE7A' },
      { token: 'number', foreground: 'E0A76B' },
      { token: 'type', foreground: '8FBEDA' },
      { token: 'function', foreground: '7FD1C4' },
      { token: 'variable', foreground: 'DCD9E4' },
      { token: 'constant', foreground: 'E0A76B' },
      { token: 'parameter', foreground: 'C6C2CE' },
      { token: 'property', foreground: '8FBEDA' },
      { token: 'tag', foreground: 'D4879A' },
      { token: 'attribute.name', foreground: 'D4879A' },
      { token: 'attribute.value', foreground: '8FBE7A' },
      { token: 'delimiter', foreground: '8B8798' },
      { token: 'operator', foreground: 'C79BE0' },
      { token: 'regexp', foreground: '8FBE7A' },

      // --- Keywords & Storage ---
      { token: 'keyword.control', foreground: 'C79BE0', fontStyle: 'italic' },
      { token: 'keyword.operator.new', foreground: 'C79BE0' },
      { token: 'keyword.operator.expression', foreground: 'C79BE0' },
      { token: 'storage', foreground: 'C79BE0' },
      { token: 'storage.type', foreground: '8FBEDA' },
      { token: 'storage.modifier', foreground: 'C79BE0' },

      // --- Variables & Constants ---
      { token: 'variable.language', foreground: 'D4879A', fontStyle: 'italic' },
      { token: 'variable.other.constant', foreground: 'E0A76B' },
      { token: 'constant.language', foreground: 'C79BE0' },

      // --- Entities & Support ---
      { token: 'entity.name.function', foreground: '7FD1C4' },
      { token: 'entity.name.class', foreground: '8FBEDA' },
      { token: 'entity.name.type', foreground: '8FBEDA' },
      { token: 'support.function', foreground: '7FD1C4' },
      { token: 'support.class', foreground: '8FBEDA' },
      { token: 'support.type', foreground: '8FBEDA' },

      // --- JSX/TSX ---
      { token: 'entity.name.tag', foreground: 'D4879A' },
      { token: 'support.class.component', foreground: '8FBEDA' },

      // --- Punctuation & Delimiters ---
      { token: 'meta.brace.round', foreground: '8B8798' },
      { token: 'meta.brace.square', foreground: '8B8798' },
      { token: 'meta.brace.curly', foreground: 'C79BE0' },
      { token: 'punctuation.separator', foreground: '8B8798' },
      { token: 'string.template', foreground: '8FBE7A' },
      { token: 'punctuation.definition.template-expression', foreground: 'C79BE0' },

      // --- Decorators ---
      { token: 'meta.decorator', foreground: 'D4879A' },
    ],
```

- [ ] **Step 4: Fix the two line-number colours in `arcane-dark.ts`**

In the `colors` block, change these two lines only:

```typescript
      'editorLineNumber.foreground': '#656274',
      'editorLineNumber.activeForeground': '#D4B062',
```

(`#3A3845` → `#656274` lifts inactive line numbers from 1.62:1 to 3.06:1. The active one stays gold — it is one of the moments the accent should own.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd editor && bun test src/features/theme/theme-contract.test.ts`

Expected: PASS, all tests. If `parameter=#C6C2CE` or any other rule still reports below 4.5, the value was mistyped — re-check against the table in spec section 2.

- [ ] **Step 6: Commit**

```bash
cd /Users/inno/Documents/experiments/arcane-editor
git add editor/src/features/theme/theme-contract.test.ts editor/src/features/theme/definitions/arcane-dark.ts
git commit -m "fix(theme): make syntax contrast a test failure, rebuild Arcane Dark's palette

comment sat at 2.72:1 and line numbers at 1.62:1 through a green suite,
because theme-contract only ever checked \`ui\` tokens and never
\`monaco.rules\`. Adds that check, enforced for the Arcane themes only —
monokai's #F92672 is at 3.93 and dracula's #6272A4 at 3.03, and holding
faithful ports to AA would mean not shipping them.

Gold no longer resolves eight token classes at once."
```

---

### Task 2: Arcane Dark surfaces

**Files:**
- Modify: `editor/src/features/theme/definitions/arcane-dark.ts:13-77` (`ui`) and the `colors`/`terminal` blocks
- Modify: `editor/index.html:22`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the same file.
- Produces: `bg-primary` = `#16151F`, the value Task 4's Unity tokens are contrast-checked against.

- [ ] **Step 1: Apply the surface ramp to the `ui` block**

Change exactly these keys in `arcane-dark.ts`'s `ui` object; leave every other key alone:

```typescript
    'bg-primary': '#16151F',
    'bg-sidebar': '#0F0E16',
    'bg-titlebar': '#0B0A10',
    'bg-tab-active': '#16151F',
    'bg-tab-inactive': '#0F0E16',
    'bg-statusbar': '#0B0A10',
    'bg-activity-bar': '#08070C',
    'bg-breadcrumbs': '#0F0E16',
    'bg-input': '#1C1A26',
    'hover': '#1C1A26',
    'selected': '#252034',
    'surface-container-high': '#1C1A26',
    'surface-container-highest': '#242232',
    'surface-bright': '#2E2B3C',
```

`bg-tab-active` intentionally equals `bg-primary` — the active tab becomes continuous with its content. `App.css:586` already draws a 2px `var(--accent)` top rule on `.tab.active`, keyed on `.active` alone, so every tab state keeps its marker. Do not add CSS for this.

- [ ] **Step 2: Apply the matching `monaco.colors` and `terminal` changes**

In the same file's `colors` block:

```typescript
      'editor.background': '#16151F',
      'editor.lineHighlightBackground': '#1C1A26',
      'editor.lineHighlightBorder': '#1C1A26',
      'editorIndentGuide.background': '#242232',
      'editorIndentGuide.activeBackground': '#3E3B4C',
      'editorWidget.background': '#1C1A26',
      'editorWidget.border': '#242232',
      'editorSuggestWidget.background': '#1C1A26',
      'editorSuggestWidget.border': '#242232',
      'editorHoverWidget.background': '#1C1A26',
      'editorHoverWidget.border': '#242232',
      'editorGutter.background': '#16151F',
      'minimap.background': '#16151F',
```

And in `terminal`, `background: '#16151F'` and `black: '#1C1A26'`.

Leave every gold value (`editorCursor.foreground`, the selection/find/bracket-match rgba golds) untouched — those are the accent doing its job.

- [ ] **Step 3: Update the anti-FOUC bootstrap**

`editor/index.html` line 22. This map duplicates each theme's `bg-primary` because the bundle has not loaded yet; stale here means a cold start flashes the old canvas.

```javascript
          'arcane-dark':  ['dark',  '#16151F'],
```

- [ ] **Step 4: Run the theme suite**

Run: `cd editor && bun test src/features/theme/`

Expected: PASS. The `ui` contrast tests re-run against the new darker surfaces — `text-primary` (`#E2E0DA`) on `#16151F` is ~12.4:1 and `text-secondary` (`#7E7B86`) on `#0F0E16` is ~4.9:1, both comfortably clear. If `hover`/`selected` fails the "distinguishable from surfaces" test, one of them was set equal to `bg-primary` or `bg-sidebar` by mistake.

- [ ] **Step 5: Look at it**

Run: `cd editor && bun run tauri:dev-app`

Open a C# file. Confirm: the editor is visibly brighter than the sidebar, the activity bar is the darkest region, the active tab has no fill difference but does have a gold top rule, and no region boundary has gone invisible. Close the app.

- [ ] **Step 6: Commit**

```bash
cd /Users/inno/Documents/experiments/arcane-editor
git add editor/src/features/theme/definitions/arcane-dark.ts editor/index.html
git commit -m "feat(theme): give Arcane Dark a real elevation ramp

Editor-to-sidebar contrast was 1.02:1 across twelve surface tokens that
carried one value, so the whole window read as a single flat sheet.
Chrome now sinks and the editor becomes the brightest plane: 1.9:1.

index.html's anti-FOUC map duplicates bg-primary per theme and moves
with it, or every cold start flashes the old canvas."
```

---

### Task 3: Arcane Light

**Files:**
- Modify: `editor/src/features/theme/definitions/arcane-light.ts`
- Modify: `editor/src/features/theme/theme-contract.test.ts` (the `CONTRAST_ENFORCED` set)
- Modify: `editor/index.html:23`

**Interfaces:**
- Consumes: `CONTRAST_ENFORCED` from Task 1.
- Produces: nothing later tasks depend on.

Arcane Light keeps its own "vellum and iron-gall ink" personality — this is not a darkened copy of the dark palette. Its failures today are comment `#A09584` at 2.75:1, the `#A8632A` accent used for five function-ish tokens at 4.38:1, and line numbers at 1.74:1.

- [ ] **Step 1: Add arcane-light to the enforced set**

In `theme-contract.test.ts`:

```typescript
const CONTRAST_ENFORCED = new Set(['arcane-dark', 'arcane-light']);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd editor && bun test src/features/theme/theme-contract.test.ts`

Expected: FAIL with `comment=#A09584 2.75`, `function=#A8632A 4.38` (and its four aliases `attribute.name`, `entity.name.function`, `support.function`, `meta.brace.curly`), plus `editorLineNumber.foreground=... 1.74`.

- [ ] **Step 3: Apply the light surface ramp**

In `arcane-light.ts`'s `ui` block — editor brightest, chrome stepping down:

```typescript
    'bg-primary': '#FCFAF3',
    'bg-sidebar': '#F2EDE0',
    'bg-titlebar': '#EBE4D3',
    'bg-tab-active': '#FCFAF3',
    'bg-tab-inactive': '#F2EDE0',
    'bg-statusbar': '#EBE4D3',
    'bg-activity-bar': '#E7DFCC',
    'bg-breadcrumbs': '#F2EDE0',
```

Set `'editor.background': '#FCFAF3'`, `'editorGutter.background': '#FCFAF3'`, `'minimap.background': '#FCFAF3'` and `terminal.background: '#FCFAF3'` to match. Update `index.html` line 23 to `'arcane-light': ['light', '#FCFAF3']`.

- [ ] **Step 4: Rebuild the light syntax roles**

Same six-role structure as Arcane Dark, in Light's own palette. Replace the `foreground` of each rule using this mapping — the token list and ordering stay exactly as they are in the file:

| Role | Tokens | Colour |
|---|---|---|
| comment | `comment` | `776D61` |
| keyword | `keyword`, `operator`, `keyword.control`, `keyword.operator.*`, `storage`, `storage.modifier`, `constant.language`, `meta.brace.curly`, `punctuation.definition.template-expression` | `6B3A7A` |
| engine/type | `type`, `property`, `storage.type`, `entity.name.class`, `entity.name.type`, `support.class`, `support.type`, `support.class.component` | `2F5A73` |
| your code | `function`, `entity.name.function`, `support.function` | `1F6459` |
| string | `string`, `attribute.value`, `regexp`, `string.template` | `415C2F` |
| number | `number`, `constant`, `variable.other.constant` | `8A4A16` |
| attribute | `tag`, `attribute.name`, `entity.name.tag`, `variable.language`, `meta.decorator` | `8F3324` |
| body | `variable` | `2A2622` |
| muted | `parameter` | `4A443C` |
| delimiter | `delimiter`, `meta.brace.round`, `meta.brace.square`, `punctuation.separator` | `6B6358` |

Keep the existing `fontStyle` values (`comment` italic, `keyword.control` italic, `variable.language` italic).

Set `'editorLineNumber.foreground': '#9A9184'` and leave `activeForeground` as the accent.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd editor && bun test src/features/theme/theme-contract.test.ts`

Expected: PASS. Every value above was chosen against `#FCFAF3`; if one reports below 4.5, darken it and re-run rather than adjusting the threshold.

- [ ] **Step 6: Look at it**

Run: `cd editor && bun run tauri:dev-app`, switch to Arcane Light via the theme picker, open a C# file. Confirm the palette still reads as warm sepia-on-vellum and not as an inverted dark theme. Close the app.

- [ ] **Step 7: Commit**

```bash
cd /Users/inno/Documents/experiments/arcane-editor
git add editor/src/features/theme/definitions/arcane-light.ts editor/src/features/theme/theme-contract.test.ts editor/index.html
git commit -m "feat(theme): bring Arcane Light up to the same standard

Same bug, mirrored: comment at 2.75:1, line numbers at 1.74:1, and the
sienna accent doing duty for five function tokens at 4.38:1. Rebuilt on
the same six-role structure while keeping Light's own vellum-and-
iron-gall-ink identity rather than inverting the dark palette."
```

---

### Task 4: Four Unity semantic tokens

**Files:**
- Modify: `editor/src/features/theme/types.ts`
- Modify: all six files in `editor/src/features/theme/definitions/`

**Interfaces:**
- Consumes: `bg-primary` = `#16151F` (Task 2), `#FCFAF3` (Task 3).
- Produces: CSS variables `--unity-lifecycle`, `--unity-engine-type`, `--unity-inspector`, `--unity-inspector-rail`, consumed by Task 6's stylesheet.

`applyCssVariables` (`apply.ts:21`) publishes every `ui` key as `--<key>`, so adding them here is all that is needed to make them available to CSS.

- [ ] **Step 1: Add the keys to `UiColors`**

In `types.ts`, under the `// ── CONTENT (alpha free) ──` header, after `'success': string;`:

```typescript
  /** A method the engine calls — Awake, Update, OnTriggerEnter. Gold in the
   *  Arcane themes: this is the accent's one job inside the editor. */
  'unity-lifecycle': string;
  /** A UnityEngine type — MonoBehaviour, Vector3, Time — as distinct from a
   *  type the user wrote. */
  'unity-engine-type': string;
  /** An attribute that surfaces a field in the Inspector — [SerializeField],
   *  [Header], [Range]. */
  'unity-inspector': string;
```

And under the `// ── OVERLAY (translucent) ──` header, after `'focus-ring': string;`:

```typescript
  /** Tints the line behind an Inspector-facing field. Composited over the
   *  editor background, so it must stay translucent. */
  'unity-inspector-rail': string;
```

- [ ] **Step 2: Run the type-check to see the six failures**

Run: `cd editor && bunx tsc --noEmit`

Expected: FAIL — six errors, one per definition file, each reporting the four missing properties.

- [ ] **Step 3: Add values to the two Arcane themes**

`arcane-dark.ts`:

```typescript
    'unity-lifecycle': '#E8C97D',
    'unity-engine-type': '#8FBEDA',
    'unity-inspector': '#D4879A',
    'unity-inspector-rail': 'rgba(212, 135, 154, 0.05)',
```

`arcane-light.ts`:

```typescript
    'unity-lifecycle': '#8A5A12',
    'unity-engine-type': '#2F5A73',
    'unity-inspector': '#8F3324',
    'unity-inspector-rail': 'rgba(143, 51, 36, 0.06)',
```

- [ ] **Step 4: Derive values for the four ports**

Do not invent colours for these — take tokens each theme already defines, so no new palette decisions are made on their behalf. For each of `dark-plus.ts`, `light-plus.ts`, `dracula.ts`, `monokai.ts`, read that file's existing `warning`, `info` and `error-border` values and write:

```typescript
    'unity-lifecycle': <that theme's `warning` value>,
    'unity-engine-type': <that theme's `info` value>,
    'unity-inspector': <that theme's `error-border` value>,
    'unity-inspector-rail': <that theme's `error-border` as rgba at 0.06 alpha>,
```

For the rail, convert the hex to `rgba(r, g, b, 0.06)` — an OVERLAY token must be translucent, and the contract test will reject an opaque one.

- [ ] **Step 5: Run the tests**

Run: `cd editor && bunx tsc --noEmit && bun test src/features/theme/`

Expected: PASS. `tokenClasses()` parses the section headers in `types.ts`, so the new tokens are automatically covered — `unity-inspector-rail` is asserted translucent and the other three are asserted parseable. A failure naming `unity-inspector-rail` in the OVERLAY test means one theme got a hex instead of an rgba.

- [ ] **Step 6: Commit**

```bash
cd /Users/inno/Documents/experiments/arcane-editor
git add editor/src/features/theme/types.ts editor/src/features/theme/definitions/
git commit -m "feat(theme): add four Unity semantic tokens to the contract

These are contract tokens rather than inline getThemeColor() results
because Monaco's inlineClassName needs a CSS class, and applyCssVariables
already publishes every ui key as --<key>.

The four ports derive theirs from warning/info/error-border so no new
palette decisions are made on their behalf."
```

---

### Task 5: Pure Unity decoration classifier

**Files:**
- Modify: `editor/src/features/csharp/services/csharp-decorations.ts`
- Create: `editor/src/features/csharp/services/unity-decorations.test.ts`

**Interfaces:**
- Consumes: `LIFECYCLE_METHOD_NAMES`, `UNITY_LIFECYCLE_METHODS` from `./lifecycle-db`; `UNITY_API_NAMES` from `src/data/unity-api-names.ts`.
- Produces:
  ```typescript
  export interface UnityDecoration {
    line: number;          // 1-based
    startColumn: number;   // 1-based
    endColumn: number;
    kind: 'lifecycle' | 'engine-type' | 'inspector-attribute';
    hover?: string;
  }
  export function computeUnityDecorations(text: string): UnityDecoration[];
  ```
  Task 6 consumes both.

The existing module keeps `decorationIds` as a module-level array, so two editors (diff view, split) would clobber each other's decorations. The rewrite drops that in favour of the per-editor `WeakMap` + `createDecorationsCollection` pattern already used by `better-comments.ts:150-189`.

- [ ] **Step 1: Write the failing tests**

Create `editor/src/features/csharp/services/unity-decorations.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { computeUnityDecorations } from './csharp-decorations';

// Every Unity name used here is present in UNITY_API_NAMES with kind 'type'.
// `CharacterController` deliberately is NOT used — it is a real Unity type
// that the list happens to omit, so asserting either way about it would pin
// down a gap in the data rather than the behaviour of this function.
const SOURCE = `using UnityEngine;

[RequireComponent(typeof(Rigidbody))]
public class PlayerController : MonoBehaviour
{
    [Header("Movement")]
    [SerializeField] private float moveSpeed = 6f;

    private Rigidbody _body;

    private void Awake()
    {
        _body = GetComponent<Rigidbody>();
    }

    private void Recalculate()
    {
    }
}
`;

describe('computeUnityDecorations', () => {
  const found = computeUnityDecorations(SOURCE);
  const kinds = (k: string) => found.filter((d) => d.kind === k);

  it('marks a method the engine calls', () => {
    const lifecycle = kinds('lifecycle');
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].line).toBe(11);
    expect(SOURCE.split('\n')[10].slice(lifecycle[0].startColumn - 1, lifecycle[0].endColumn - 1))
      .toBe('Awake');
  });

  it('does not mark an ordinary method', () => {
    expect(kinds('lifecycle').some((d) => d.line === 16)).toBe(false);
  });

  it('marks engine types but not user types', () => {
    const names = kinds('engine-type').map(
      (d) => SOURCE.split('\n')[d.line - 1].slice(d.startColumn - 1, d.endColumn - 1),
    );
    expect(names).toContain('MonoBehaviour');
    expect(names).toContain('Rigidbody');
    expect(names).not.toContain('PlayerController');
  });

  // UNITY_API_NAMES carries methods and properties too, and C# method names
  // are capitalised, so an unfiltered lookup would paint `GetComponent` as a
  // type.
  it('does not mark an engine method as a type', () => {
    const names = kinds('engine-type').map(
      (d) => SOURCE.split('\n')[d.line - 1].slice(d.startColumn - 1, d.endColumn - 1),
    );
    expect(names).not.toContain('GetComponent');
  });

  it('marks Inspector-facing attributes', () => {
    const lines = kinds('inspector-attribute').map((d) => d.line).sort((a, b) => a - b);
    expect(lines).toEqual([6, 7]);
  });

  it('attaches lifecycle hover text describing when the engine calls it', () => {
    expect(kinds('lifecycle')[0].hover).toContain('Awake');
  });

  it('returns nothing for a file with no Unity content', () => {
    expect(computeUnityDecorations('class Plain { void Go() {} }')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd editor && bun test src/features/csharp/services/unity-decorations.test.ts`

Expected: FAIL with `computeUnityDecorations is not a function` — it does not exist yet.

- [ ] **Step 3: Write the classifier**

Replace the whole body of `csharp-decorations.ts` with the pure classifier plus the attach layer. The classifier:

```typescript
import { LIFECYCLE_METHOD_NAMES, UNITY_LIFECYCLE_METHODS } from './lifecycle-db';
import { UNITY_API_NAMES } from '../../../data/unity-api-names';

export type UnityDecorationKind = 'lifecycle' | 'engine-type' | 'inspector-attribute';

export interface UnityDecoration {
  line: number;
  startColumn: number;
  endColumn: number;
  kind: UnityDecorationKind;
  hover?: string;
}

// Attributes that put a field in the Inspector. [Header] and [Range] only
// render when the field itself is serialized, but they always accompany one,
// so marking them keeps the block visually contiguous.
const INSPECTOR_ATTRS = /\[\s*(SerializeField|Header|Range|Tooltip|Space|TextArea|Multiline|HideInInspector)\b/g;

// A method declaration: optional modifiers, then a return type, then a name.
const METHOD_DECL = /(?:(?:private|protected|public|internal|static|virtual|override|sealed|abstract)\s+)*(?:void|IEnumerator)\s+(\w+)\s*\(/g;

const IDENTIFIER = /\b([A-Z]\w*)\b/g;

// `kind: 'type'` only — the list also carries methods and properties, and C#
// method names are capitalised, so an unfiltered set would paint
// `GetComponent` as a type. 64 of the entries are types.
//
// This list is a fallback COMPLETION list, not an exhaustive Unity type index:
// `CharacterController`, for one, is absent. Engine-type colouring therefore
// has false negatives — a real Unity type that is missing here renders as a
// user type. That is a quiet, acceptable degradation for a highlight; widening
// it means growing the data file, not changing this function.
const ENGINE_NAMES: ReadonlySet<string> = new Set(
  UNITY_API_NAMES.filter((n) => n.kind === 'type').map((n) => n.name),
);

export function computeUnityDecorations(text: string): UnityDecoration[] {
  const out: UnityDecoration[] = [];
  const lines = text.split('\n');

  lines.forEach((lineText, i) => {
    const line = i + 1;

    INSPECTOR_ATTRS.lastIndex = 0;
    for (let m = INSPECTOR_ATTRS.exec(lineText); m; m = INSPECTOR_ATTRS.exec(lineText)) {
      out.push({
        line,
        startColumn: m.index + 1,
        endColumn: m.index + m[0].length + 1,
        kind: 'inspector-attribute',
      });
    }

    METHOD_DECL.lastIndex = 0;
    for (let m = METHOD_DECL.exec(lineText); m; m = METHOD_DECL.exec(lineText)) {
      if (!LIFECYCLE_METHOD_NAMES.has(m[1])) continue;
      const info = UNITY_LIFECYCLE_METHODS.find((x) => x.name === m[1]);
      const start = m.index + m[0].lastIndexOf(m[1]);
      out.push({
        line,
        startColumn: start + 1,
        endColumn: start + m[1].length + 1,
        kind: 'lifecycle',
        hover: `**Unity ${info?.category ?? 'Lifecycle'}**: \`${m[1]}\`\n\n${info?.description ?? ''}`,
      });
    }

    IDENTIFIER.lastIndex = 0;
    for (let m = IDENTIFIER.exec(lineText); m; m = IDENTIFIER.exec(lineText)) {
      if (!ENGINE_NAMES.has(m[1])) continue;
      const startColumn = m.index + 1;
      const endColumn = m.index + m[1].length + 1;
      // A lifecycle mark on the same span wins — it is the more specific fact.
      if (out.some((d) => d.line === line && d.startColumn === startColumn)) continue;
      out.push({ line, startColumn, endColumn, kind: 'engine-type' });
    }
  });

  return out;
}
```

`UNITY_API_NAMES` is `UnityApiName[]` with `{ name: string; kind: 'type' | 'method' | 'property'; detail?: string }` — verified against `src/data/unity-api-names.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd editor && bun test src/features/csharp/services/unity-decorations.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/inno/Documents/experiments/arcane-editor
git add editor/src/features/csharp/services/csharp-decorations.ts editor/src/features/csharp/services/unity-decorations.test.ts
git commit -m "refactor(csharp): extract a testable Unity decoration classifier

Splits regex classification from Monaco calls so the interesting half can
be unit-tested without a DOM. Also drops the module-level decorationIds
array, which two editor instances would have clobbered."
```

---

### Task 6: Wire the decoration layer up

**Files:**
- Modify: `editor/src/features/csharp/services/csharp-decorations.ts` (append attach layer)
- Modify: `editor/src/features/csharp/index.ts`
- Modify: `editor/src/features/editor/components/EditorPanel.tsx:341`
- Modify: `editor/src/App.css`

**Interfaces:**
- Consumes: `computeUnityDecorations`, `UnityDecoration` (Task 5); `--unity-*` CSS variables (Task 4).
- Produces: `attachUnityDecorations(editor, monaco): void`.

`applyCSharpDecorations` is currently exported and **never called anywhere**, and none of its four CSS classes are styled in any stylesheet. This task is what makes the feature actually exist.

- [ ] **Step 1: Add the attach layer**

Append to `csharp-decorations.ts`, mirroring `better-comments.ts:150-189`:

```typescript
type MonacoEditor = import('monaco-editor').editor.IStandaloneCodeEditor;
type MonacoModule = typeof import('monaco-editor');
type Model = import('monaco-editor').editor.ITextModel;

interface State {
  collection: import('monaco-editor').editor.IEditorDecorationsCollection;
  contentDispose: import('monaco-editor').IDisposable;
  modelDispose: import('monaco-editor').IDisposable;
  scheduled: ReturnType<typeof setTimeout> | null;
}

const STATES = new WeakMap<MonacoEditor, State>();

const CLASS_BY_KIND: Record<UnityDecorationKind, string> = {
  'lifecycle': 'unity-lifecycle-name',
  'engine-type': 'unity-engine-type-name',
  'inspector-attribute': 'unity-inspector-attr',
};

function refresh(editor: MonacoEditor, monaco: MonacoModule, state: State): void {
  const model = editor.getModel();
  if (!model || !model.uri.toString().endsWith('.cs')) {
    state.collection.set([]);
    return;
  }
  state.collection.set(
    computeUnityDecorations(model.getValue()).map((d) => ({
      range: new monaco.Range(d.line, d.startColumn, d.line, d.endColumn),
      options: {
        inlineClassName: CLASS_BY_KIND[d.kind],
        ...(d.kind === 'lifecycle'
          ? {
              glyphMarginClassName: 'unity-lifecycle-glyph',
              glyphMarginHoverMessage: { value: d.hover ?? '' },
            }
          : {}),
        ...(d.kind === 'inspector-attribute'
          ? { isWholeLine: true, className: 'unity-inspector-line' }
          : {}),
      },
    })),
  );
}

export function attachUnityDecorations(editor: MonacoEditor, monaco: MonacoModule): void {
  if (STATES.has(editor)) return;
  const state: State = {
    collection: editor.createDecorationsCollection([]),
    contentDispose: { dispose: () => {} },
    modelDispose: { dispose: () => {} },
    scheduled: null,
  };

  const schedule = () => {
    if (state.scheduled) clearTimeout(state.scheduled);
    state.scheduled = setTimeout(() => refresh(editor, monaco, state), 150);
  };

  function bindModel(model: Model | null) {
    state.contentDispose.dispose();
    if (!model) { state.collection.set([]); return; }
    state.contentDispose = model.onDidChangeContent(schedule);
    refresh(editor, monaco, state);
  }

  bindModel(editor.getModel());
  state.modelDispose = editor.onDidChangeModel(() => bindModel(editor.getModel()));
  editor.onDidDispose(() => disposeUnityDecorations(editor));
  STATES.set(editor, state);
}

export function disposeUnityDecorations(editor: MonacoEditor): void {
  const state = STATES.get(editor);
  if (!state) return;
  if (state.scheduled) clearTimeout(state.scheduled);
  state.contentDispose.dispose();
  state.modelDispose.dispose();
  state.collection.clear();
  STATES.delete(editor);
}
```

Delete the now-unused `applyCSharpDecorations`, `clearDecorations` and `withAlpha`.

- [ ] **Step 2: Update the barrel**

In `editor/src/features/csharp/index.ts`, replace line 13:

```typescript
export { attachUnityDecorations, disposeUnityDecorations } from './services/csharp-decorations';
export { computeUnityDecorations } from './services/csharp-decorations';
export type { UnityDecoration, UnityDecorationKind } from './services/csharp-decorations';
```

- [ ] **Step 3: Style the classes**

Append to `editor/src/App.css`. Without these rules the decorations attach and render nothing.

```css
/* Unity semantic decorations — colours come from the active theme.
   `.mtk*` is Monaco's own token class; the !important is needed because the
   theme's tokenizer colour is applied inline on the same span. */
.unity-lifecycle-name {
  color: var(--unity-lifecycle) !important;
  font-weight: 600;
}
.unity-engine-type-name {
  color: var(--unity-engine-type) !important;
}
.unity-inspector-attr {
  color: var(--unity-inspector) !important;
}
.unity-inspector-line {
  background: var(--unity-inspector-rail);
  box-shadow: inset 2px 0 0 var(--unity-inspector);
}
.unity-lifecycle-glyph::after {
  content: '▸';
  color: var(--unity-lifecycle);
  font-size: 10px;
  line-height: 1;
}
```

- [ ] **Step 4: Call it from the editor**

In `EditorPanel.tsx`, inside `onMount` — immediately after `registerBetterComments(editor, monaco);` at line 341:

```typescript
          // Unity semantic colouring: lifecycle methods, engine types, and
          // Inspector-facing attributes. Self-gates on `.cs` per model.
          attachUnityDecorations(editor, monaco);
```

Add `attachUnityDecorations` to the existing import from `'../../csharp'` (the barrel — never the service path directly, `check:modules` will reject it).

- [ ] **Step 5: Verify it renders**

Run: `cd editor && bunx tsc --noEmit && bun run check:modules && bun run tauri:dev-app`

Open a Unity C# file with a lifecycle method and a `[SerializeField]`. Confirm: `Awake`/`Update` are gold and bold with a `▸` in the glyph margin, `MonoBehaviour`/`Vector3` are blue, `[SerializeField]` is rose with a tinted line and a left rail, and your own class name is *not* blue. Type in the file and confirm the decorations follow. Switch tabs and back, confirm they survive the model swap. Close the app.

- [ ] **Step 6: Commit**

```bash
cd /Users/inno/Documents/experiments/arcane-editor
git add editor/src/features/csharp/ editor/src/features/editor/components/EditorPanel.tsx editor/src/App.css
git commit -m "feat(csharp): actually turn on the Unity semantic layer

The detection has been sitting in csharp-decorations.ts unused —
applyCSharpDecorations was exported and never called, and none of its
four CSS classes were styled in any stylesheet. Wires it into
EditorPanel's onMount and gives the classes rules driven by the theme's
--unity-* variables.

Gold returns to the editor on roughly four identifiers per file: the
ones the engine calls."
```

---

### Task 7: Typography and density

**Files:**
- Modify: `editor/package.json`, `editor/src/main.tsx`, `editor/src/App.css`
- Modify: `editor/src/features/app-shell/components/ActivityBar.tsx:69,105,112` and `RightActivityBar.tsx:26`

**Interfaces:** none shared.

- [ ] **Step 1: Swap the font dependency**

```bash
cd /Users/inno/Documents/experiments/arcane-editor/editor
bun add @fontsource-variable/instrument-sans
bun remove @fontsource/inter @fontsource/jetbrains-mono
```

(`inter` and `jetbrains-mono` are dependencies that nothing imports — confirm with `grep -rn "fontsource/inter\|fontsource/jetbrains" src/` returning nothing before removing.)

- [ ] **Step 2: Import it**

`editor/src/main.tsx` line 1, replacing the Geist sans import and keeping the mono one:

```typescript
import '@fontsource-variable/instrument-sans/index.css';
import '@fontsource-variable/geist-mono/index.css';
```

- [ ] **Step 3: Point the CSS variables at it**

`editor/src/App.css`, in `:root` (lines 4-11):

```css
  font-family: 'Instrument Sans Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-display: 'Instrument Sans Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

Leave `--font-mono` alone. Remove the `font-feature-settings: 'ss01', 'ss02', 'cv11';` line — those are Geist's stylistic sets and mean nothing to Instrument Sans.

- [ ] **Step 4: Apply the density corrections**

In `App.css`:
- `.title-bar` (line 142): `height: 35px` → `height: 31px`
- `.activity-bar` (line 79): `width: 48px` → `width: 44px`
- `.activity-bar-icon` (lines 90-91): `width: 48px; height: 48px` → `width: 44px; height: 40px`
- `.status-bar` (line 916): add `font-variant-numeric: tabular-nums;` so `Ln 20, Col 28` stops reflowing as the caret moves

In `ActivityBar.tsx`, change all three `size={24}` (lines 69, 105, 112) to `size={18}`. Do the same for the `size={24}` occurrences in `RightActivityBar.tsx`.

- [ ] **Step 5: Verify**

Run: `cd editor && bunx tsc --noEmit && bun run tauri:dev-app`

Confirm the UI renders in Instrument Sans (not a fallback — check the `a` and `g`), the activity bar is visibly tighter, and moving the caret does not make the status bar jitter. Close the app.

- [ ] **Step 6: Commit**

```bash
cd /Users/inno/Documents/experiments/arcane-editor
git add editor/package.json editor/bun.lock editor/src/main.tsx editor/src/App.css editor/src/features/app-shell/components/
git commit -m "feat(ui): Instrument Sans, and fix the density rhythm

Geist is the house font of half of developer tooling; it reads as a
well-built default rather than a choice. Also drops @fontsource/inter and
@fontsource/jetbrains-mono, which nothing imported.

Activity-bar icons were 24px against 13px UI text, the title bar was
35px, and the status bar reflowed on every caret move for want of
tabular figures."
```

---

### Task 8: Full verification

**Files:** none modified unless verification fails.

- [ ] **Step 1: Run the full suite**

Run: `cd editor && bun run verify`

This is `tsc --noEmit`, `check:modules`, `check:invoke`, `bun test src`, `cargo test --lib`, and `verify:intellisense`.

- [ ] **Step 2: Read the IntelliSense result carefully**

`verify:intellisense` reporting **`SKIPPED` is not a pass** — it means the check did not run and any claim that IntelliSense works is unsupported. If it skips, set a Unity project path and re-run:

```bash
cd editor && ARCANE_INTELLISENSE_E2E=required ARCANE_SMOKE_UNITY_PROJECT=<path> bun run verify:intellisense
```

- [ ] **Step 3: Expect one known flake**

The `auth_loopback` stop test in the Rust suite is flaky under load and fails roughly half the time. It is pre-existing and unrelated to this work — re-run `cd editor/src-tauri && cargo test --lib` to confirm it passes in isolation rather than investigating it as a regression from this branch.

- [ ] **Step 4: Check all six themes still render**

Run: `cd editor && bun run tauri:dev-app`. Cycle through all six themes in the picker with a C# file open. Confirm none of them has an unreadable region, a missing active-tab marker, or Unity decorations in a colour that fights the rest of its palette. Close the app.

- [ ] **Step 5: Report honestly**

State what passed, what was skipped, and what failed, quoting the actual output. Do not describe the work as done if step 1 did not come back clean.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. Surfaces (incl. `index.html`, `border` unchanged, tab fusion) | 2 |
| 2. Code palette (dark) | 1 |
| 2. Code palette (light) | 3 |
| 3. Unity tokens | 4 |
| 3. Decoration implementation + wiring + CSS classes | 5, 6 |
| 3. `[Range]` pill — explicitly out of scope | none, by design |
| 4. Typography and density | 7 |
| 5. Arcane Light | 3 |
| 5. Four ports | 4 |
| 6. Testing (allowlist, thresholds, `bun run verify`) | 1, 3, 8 |

No gaps.

**Placeholder scan:** No TBDs. The one deferral — Arcane Light's exact syntax hex — is resolved to concrete values in Task 3 step 4 rather than left to the implementer.

**Type consistency:** `computeUnityDecorations` / `UnityDecoration` / `UnityDecorationKind` are defined in Task 5 and consumed under those exact names in Task 6. `attachUnityDecorations(editor, monaco)` is defined in Task 6 step 1, exported in step 2, called in step 4. `CONTRAST_ENFORCED` is created in Task 1 and extended in Task 3. `CLASS_BY_KIND`'s three values match the three CSS class names in Task 6 step 3.

**Known risk carried from the spec:** the classifier is regex-based, so a user-defined `void Update()` on a class that does not derive from `MonoBehaviour` gets lifecycle colouring. Acceptable for a highlight; it would not be acceptable for a diagnostic. Task 5's test pins the narrower case (an ordinary method named `Recalculate` is not marked) but does not attempt base-class resolution.
