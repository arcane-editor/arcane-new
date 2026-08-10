# Arcane theme: premium surface system + Unity semantic palette

**Date:** 2026-08-10
**Status:** Approved, ready for implementation planning
**Scope:** `src/features/theme/`, `src/features/csharp/services/csharp-decorations.ts`, `src/App.css`, `src/main.tsx`

---

## Problem

Arcane Dark reads as competent but flat. Four measured causes:

1. **No elevation ladder.** `bg-primary` `#13121A`, `bg-sidebar` `#100F14` and `bg-titlebar` `#0E0D11` sit within ~2% luminance of each other. Editor-to-sidebar separation is **ΔL\* 0.96** — at the threshold of perceptibility. Twelve surface tokens exist; they carry effectively one value.

   **On the metric:** surface separation is measured in CIE L\*, not WCAG contrast ratio. WCAG's ratio is built for text legibility and saturates near black — its `+0.05` flare constant dominates when both luminances are under 0.01, so it reports ~1.0 for any two dark surfaces regardless of how different they look. It is the right tool for section 2 and the wrong one here.
2. **Comments fail WCAG AA and dominate the frame.** `comment` `#5C5965` on `#13121A` is **2.74:1**. `editorLineNumber.foreground` `#3A3845` is **1.63:1**. Arcane Light has the same bug: `#A09584` on `#FAF7F0` is **2.75:1**.
3. **Gold carries eight syntax roles.** `keyword`, `number`, `function`, `constant`, `operator`, `meta.brace.curly`, `storage.modifier` and `attribute.name` all resolve to `#D4B062`/`#E8C97D`. `public` and `Awake` differ by one small step.
4. **The brand accent owns nothing the user looks at.** Gold appears on the cursor, active line number and avatar. The loudest colored elements are a green connected dot and a red error mark.

Why the test suite never caught (2): `theme-contract.test.ts` does assert WCAG contrast, but only for `ui` tokens — `text-primary`, `text-secondary`, `accent`, `statusbar-fg`, `button-primary-text`. The `monaco.rules` and `monaco.colors` blocks, where every syntax color lives, are never contrast-checked.

## Direction

Three decisions, validated against rendered mockups of the real shell:

- **Recessed Chrome** — chrome sinks, the editor becomes the brightest plane. Region separation comes from the luminance step, not from a border.
- **Unity semantic palette** — the code goes cool; gold returns only where it carries Unity meaning.
- **Instrument Sans** — replaces Geist for UI type. Geist Mono stays.

---

## 1. Surfaces

Arcane Dark `ui` values only. No new tokens, no CSS changes.

| Token | Today | New |
|---|---|---|
| `bg-activity-bar` | `#0E0D11` | `#08070C` |
| `bg-titlebar` | `#0E0D11` | `#0B0A10` |
| `bg-statusbar` | `#0E0D11` | `#0B0A10` |
| `bg-sidebar` | `#100F14` | `#0F0E16` |
| `bg-tab-inactive` | `#100F14` | `#0F0E16` |
| `bg-breadcrumbs` | `#13121A` | `#0F0E16` |
| `bg-primary` | `#13121A` | `#16151F` |
| `bg-tab-active` | `#1A1922` | `#16151F` |
| `surface-container-high` | `#1A1922` | `#1C1A26` |
| `surface-container-highest` | `#22202C` | `#242232` |
| `surface-bright` | `#2A2836` | `#2E2B3C` |
| `bg-input` | `#1F1E28` | `#1C1A26` |
| `hover` | `#1B1A20` | `#1C1A26` |
| `selected` | `#25201E` | `#252034` |

`monaco.colors` follows: `editor.background` and `editorGutter.background` → `#16151F`, `editor.lineHighlightBackground`/`Border` → `#1C1A26`, `editorWidget.background`/`editorSuggestWidget.background`/`editorHoverWidget.background` → `#1C1A26`, widget borders → `#242232`, `minimap.background` → `#16151F`. Terminal `background` → `#16151F`.

Editor-to-sidebar separation rises **ΔL\* 0.96 → 2.99**, and editor-to-activity-bar **1.5 → 5.19**. ΔL\* ≈ 1 is barely perceptible; ≈ 3 is a clearly visible step.

**`bg-tab-active` deliberately equals `bg-primary`.** The active tab becomes continuous with its content, so it can no longer be marked by a fill difference. It gets a 2px `--accent` top rule instead — the same device `.activity-bar-icon.active` already uses as a 3px left rail.

**`index.html` must be updated too.** Its anti-FOUC bootstrap hardcodes a `THEMES` map duplicating each theme's `bg-primary` (`'arcane-dark': ['dark', '#13121A']`) because the bundle has not loaded yet. Left stale, every cold start flashes the old canvas before `applyCssVariables` corrects it.

**`border` is unchanged.** The shell regions never used it — `.activity-bar`, `.title-bar`, `.sidebar`, `.status-bar`, `.tab-bar` and `.breadcrumbs` declare a background and no border. All 84 `var(--border)` references are controls, inputs, cards and inner dividers, and they still need a hairline.

## 2. Code palette

`monaco.rules` in `arcane-dark.ts`. Not a contract change.

| Role | Color | Contrast on `#16151F` |
|---|---|---|
| keyword, storage, control | `#C79BE0` | 7.9:1 |
| engine type | `#8FBEDA` | 9.1:1 |
| your type, method, function | `#7FD1C4` | 10.2:1 |
| string, regexp | `#8FBE7A` | 8.5:1 |
| number, constant | `#E0A76B` | 8.5:1 |
| attribute, decorator, tag | `#D4879A` | 6.7:1 |
| variable, parameter (body) | `#DCD9E4` | 13.0:1 |
| comment | `#827E94` | 4.62:1 |
| `editorLineNumber.foreground` | `#656274` | 3.06:1 |

Line numbers target the 3:1 non-text threshold, not 4.5:1 — they are supporting UI, not body copy. Every other value clears AA.

The eight-way gold collapse is resolved by giving keyword, method and number three distinct hues instead of two adjacent golds. Gold leaves `monaco.rules` entirely; `editorCursor.foreground` and `editorLineNumber.activeForeground` keep `#D4B062`.

Arcane Light gets the same treatment against `#FCFAF3`. Its comment becomes `#776D61` (**4.73:1**, from 2.75:1). The remaining light roles keep Arcane Light's own "vellum and iron-gall ink" personality rather than darkening the dark palette, and map as: keyword → deep plum, engine type → the existing `info` slate `#3A6680` family, your type/method → deep teal, string → the existing moss `#4F6B3A`, number → burnt sienna, attribute → the existing iron-rust `#9E3A2C` family. Exact values are chosen during implementation against the 4.5:1 floor the new test enforces.

## 3. Unity semantic layer

Four new tokens, added to `UiColors` and to all six theme definitions.

| Token | Class | Arcane Dark | Meaning |
|---|---|---|---|
| `unity-lifecycle` | CONTENT | `#E8C97D` | a method the engine calls |
| `unity-engine-type` | CONTENT | `#8FBEDA` | `MonoBehaviour`, `Vector3`, `Time` |
| `unity-inspector` | CONTENT | `#D4879A` | `[SerializeField]`, `[Header]`, `[Range]` |
| `unity-inspector-rail` | OVERLAY | `rgba(212,135,154,.05)` | block marker behind Inspector-facing fields |

`unity-inspector-rail` is OVERLAY and must stay translucent — it tints the line background rather than replacing it. The other three are CONTENT with free alpha.

This is where gold returns to the code: roughly four identifiers per file rather than most of the tokens, marking the engine's entry points. Lifecycle methods also get a `▸` glyph in the gutter margin.

### Implementation

Extend `src/features/csharp/services/csharp-decorations.ts` rather than build an LSP semantic-tokens provider. Rationale:

- Lifecycle detection and `[SerializeField]` detection already exist there.
- `UNITY_API_NAMES` (`src/data/unity-api-names.ts`) already provides engine-vs-your-type as a name lookup.
- Decorations are synchronous, so there is no highlight flicker on file open.
- A semantic-tokens provider would be more correct but adds a round-trip and a dependency on `csharp-ls` semantic-token quality that cannot be verified without building it first. `client.ts:525` handles `workspace/semanticTokens/refresh` but no provider is registered.

Two consequences that are in scope:

1. **`applyCSharpDecorations` is exported and never called.** It needs wiring at the editor mount point so the layer actually runs.
2. **Its four CSS classes — `unity-lifecycle-line`, `unity-lifecycle-glyph`, `unity-serialize-field-line`, `unity-inspector-hint` — are not styled in any stylesheet.** They need rules in `App.css` driven by `var(--unity-*)`. This is why the four values are contract tokens rather than inline `getThemeColor()` results: Monaco's `inlineClassName` needs a CSS class, and `applyCssVariables` already publishes every token as `--<key>`.

Token coloring for identifiers uses `inlineClassName` decorations; the existing whole-line `className` and `overviewRuler` behavior is retained.

**Out of scope:** the inline `[Range]` bounds pill shown in the mockup. It is a feature, not a theme, and belongs to the separate Unity features spec.

## 4. Typography and density

- `--font-display` → `'Instrument Sans Variable'`. Add `@fontsource-variable/instrument-sans`, import in `src/main.tsx` alongside the existing Geist imports. `--font-mono` (Geist Mono) is unchanged.
- Remove `@fontsource/inter` and `@fontsource/jetbrains-mono` from `package.json` — both are dependencies that nothing imports.
- `.title-bar` height `35px` → `31px`.
- `.activity-bar` width `48px` → `44px`; `.activity-bar-icon` box `48px` → `40px`; lucide `size={24}` → `size={18}` in `ActivityBar.tsx` (3 call sites) and `RightActivityBar.tsx`.
- `font-variant-numeric: tabular-nums` on status-bar figures so `Ln 20, Col 28` stops reflowing as the caret moves.

## 5. Other themes

- **Arcane Light** — mirrored surface pass (editor brightest, activity bar darkest), comment fix, syntax role rebuild, four Unity tokens.
- **dark-plus, light-plus, dracula, monokai** — receive the four Unity tokens derived mechanically from tokens they already define, so no new palette decisions are made for them: `unity-lifecycle` ← `warning`, `unity-engine-type` ← `info`, `unity-inspector` ← `error-border`, `unity-inspector-rail` ← `error-border` at 5% alpha. No restyling; they stay faithful to their originals.

## 6. Testing

Extend `theme-contract.test.ts` with a Monaco contrast block:

- every `monaco.rules[].foreground` clears **4.5:1** against `monaco.colors['editor.background']`
- `editorLineNumber.foreground` and `editorLineNumber.activeForeground` clear **3:1** against `editor.background`
- terminal `foreground` clears **4.5:1** against terminal `background`

**Enforced for `arcane-dark` and `arcane-light` only,** via an explicit theme-id allowlist in the test.

This exemption is deliberate, not a loophole. An audit of the current definitions shows the rule is unshippable across all six:

| Theme | `monaco.rules` under 4.5:1 |
|---|---|
| arcane-dark | comment `#5C5965` **2.72**, `#7E7B86` delimiters/braces **4.49** |
| arcane-light | comment `#A09584` **2.75**, `#A8632A` functions **4.38** |
| monokai | **11 rules** — `#F92672` **3.93**, comment `#75715E` **3.03** |
| dracula | comment `#6272A4` **3.03** |
| light-plus | `attribute.name` `#FF0000` **4.00** |
| dark-plus | none |

`#F92672` is Monokai's signature pink and `#6272A4` is Dracula's canonical comment color. Forcing them to AA would contradict section 5's promise that the four ports stay faithful to their originals — their contrast is upstream's decision, not ours. The allowlist and this reasoning belong in a comment in the test.

Line numbers currently fail in both Arcane themes (`1.62` dark, `1.74` light) and pass in all four ports.

The existing WCAG helpers (`parseColor`, `relativeLuminance`, `contrast`) are reused; `monaco.rules` foregrounds are bare hex without `#` and need prefixing before parsing.

The existing class-invariant tests cover the four new tokens automatically, since `tokenClasses()` parses `types.ts` section headers — placing them under the right header is what registers them.

`bun run verify` must pass before this is considered done, per `CLAUDE.md`. A `SKIPPED` from `verify:intellisense` is not a pass.

## Risks

- **Arcane Light's syntax roles are specified by threshold, not by value.** The test enforces the floor, but the hue choices are made during implementation and should get a visual check before merge.
- ~~**`bg-tab-active` fusing with `bg-primary`** leaves the tab strip relying on an accent rule that may be missed on some tab states.~~ **Resolved:** `App.css:586` already defines `.tab.active::after` as a 2px `var(--accent)` top rule with a glow, keyed on `.active` alone, so every tab state inherits it. No new CSS is needed for this.
- **`csharp-decorations.ts` uses regex, not a parser.** `METHOD_REGEX` will color a user-defined `void Update()` on a non-`MonoBehaviour` class as a lifecycle method. Acceptable for a highlight; it would not be acceptable for a diagnostic.
