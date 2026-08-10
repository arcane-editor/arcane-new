# Phase 2: UI Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the shared foundation the app has never had — geometry/motion tokens, a real tooltip that carries keyboard chords, consistent motion, and honest status — so surfaces stop drifting and the app stops reading as unfinished.

**Architecture:** Colors are already tokenised through `theme/apply.ts`. This adds a *static* token sheet for everything that is not themeable (spacing, radius, type scale, elevation, motion), three new themeable mode-accent colors, and a portal tooltip that reads chords from the command registry so no surface hardcodes one.

**Tech Stack:** React 19, CSS custom properties, Zustand, `@tanstack/react-virtual` (already a dependency, used by SearchPanel and PaletteModal).

## Global Constraints

- Package manager **bun**; `bun run verify` is the gate.
- `theme-contract.test.ts` enforces that every theme defines every token AND that no `var(--x)` in CSS lacks a token. Adding a themeable token means adding it to all six theme definitions.
- Token semantic classes are load-bearing: SURFACE/FILL opaque, OVERLAY translucent, CONTENT free. Mode accents are CONTENT.
- Keybinding changes must be grepped against **both** `src/App.tsx` and `src-tauri/src/menu.rs`; `keybinding-parity.test.ts` enforces it.
- No hand-built `file://` URIs (`file-uri-single-source.test.ts`).
- No bare `Command::new` in Rust (`process_util` test).

---

## Task 1: Geometry and motion tokens

**Files:** Create `src/styles/tokens.css`, `src/styles/tokens.test.ts`; modify `src/main.tsx`.

- [ ] **Step 1: Write the failing test** — assert `tokens.css` defines the full scale on `:root`, that every duration is also collapsed under `prefers-reduced-motion`, and that `main.tsx` imports it *before* `App.css` (so App.css rules can consume the tokens and later rules still win).
- [ ] **Step 2: Run it** — `bun test tokens` — FAIL, file missing.
- [ ] **Step 3: Write `tokens.css`** — `--space-1`…`--space-8` (4px scale), `--radius-sm|md|lg|full`, `--text-xs|sm|base|lg` with line heights, `--shadow-1|2|3`, `--motion-fast|base|slow` (120/180/280ms), `--ease-out`/`--ease-in-out`, and a `@media (prefers-reduced-motion: reduce)` block collapsing all durations to `1ms`.
- [ ] **Step 4: Import in `main.tsx`** above `./App.css`.
- [ ] **Step 5: Run tests** — PASS.
- [ ] **Step 6: Commit.**

## Task 2: Mode accent tokens

**Files:** modify `src/features/theme/types.ts`, all six `src/features/theme/definitions/*.ts`.

- [ ] **Step 1:** Add `'mode-ask' | 'mode-agent' | 'mode-plan'` to `UiColors` under the CONTENT class, documented as accents that must clear the existing contrast rules.
- [ ] **Step 2:** Run `bun test theme-contract` — FAIL, six themes missing three keys each.
- [ ] **Step 3:** Add values to all six definitions, distinct per mode and legible on that theme's surfaces.
- [ ] **Step 4:** Run `bun test theme-contract` — PASS, including WCAG AA.
- [ ] **Step 5: Commit.**

## Task 3: Tooltip that carries the chord

**Files:** Create `src/components/Tooltip.tsx`, `src/components/tooltip-chord.ts`, `src/components/tooltip-chord.test.ts`; modify `ActivityBar.tsx`, `RightActivityBar.tsx`, `TitleBar.tsx`, `App.css`.

This is the single change that answers "show me the shortcut" everywhere at once — 149 native `title=` attributes exist, five hardcode `⌘`/`⇧` and render them verbatim on Windows.

- [ ] **Step 1: Write the failing test** for `tooltipLabel(label, commandId, registry)` — returns `"AI Assistant  ⌘⇧A"` on mac, `"AI Assistant  Ctrl+Shift+A"` elsewhere, plain label when the command has no chord or does not exist. Never hardcodes a chord.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the helper over `useCommandsStore` + existing `formatKeybinding`.
- [ ] **Step 4: Write `Tooltip.tsx`** — portal-rendered, single instance, ~450ms warm-up, instant hand-off between adjacent targets, hides on scroll/Escape/blur, `role="tooltip"` with `aria-describedby`. Positioned with viewport clamping.
- [ ] **Step 5: Adopt** in ActivityBar (every item gains its `view.*` chord), RightActivityBar (`view.aiPanel` → the user's actual complaint), TitleBar.
- [ ] **Step 6: Verify** `bun test && tsc --noEmit`.
- [ ] **Step 7: Commit.**

## Task 4: Motion vocabulary

**Files:** modify `src/App.css`.

- [ ] **Step 1:** Test asserts sidebar/panel/tab/tree-row rules reference `var(--motion-*)` rather than literal `ms` values, and that no rule animates without an easing token.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Apply transitions to sidebar and panel show/hide, tab switch, tree expand, row hover, and modal/popover entry, all using the tokens.
- [ ] **Step 4:** PASS, commit.

## Task 5: AI mode affordances (user ask #8)

**Files:** modify `src/App.tsx`, `src/features/ai-panel/components/ModeSelector.tsx`, `AiChatPanel.tsx`, `src/App.css`, `src-tauri/src/menu.rs` (grep only).

- [ ] **Step 1:** Test asserts three new commands exist with the chords `mod+.` (`ai.cycleMode`), `mod+shift+l` (`ai.newChat`), `mod+shift+h` (`ai.history`), that none collides with an existing registry chord, and that `keybinding-parity.test.ts` still passes.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Register the commands; `ai.cycleMode` advances ask → agent → plan and is a no-op while the agent is running (matching `ModeSelector`'s existing `disabled`).
- [ ] **Step 4:** Colour the mode pill, the selected popover row, and a composer hairline from `--mode-*`; add the chord to the pill's tooltip.
- [ ] **Step 5:** Wire New Chat / History buttons in `AiChatPanel` to the commands so button and chord share one path.
- [ ] **Step 6:** Verify, commit.

## Task 6: Settings controls (user ask #9)

**Files:** modify `src/features/settings/data/definitions.ts`, `SettingsSection.tsx`, `src/App.css`; create `src/features/settings/components/FontPicker.tsx`, `src/features/settings/components/TerminalPreview.tsx`.

`terminal.fontFamily` is a generic `select` whose option values are raw CSS font stacks, rendered as `<option>{String(opt)}</option>` — so the dropdown's label is literally `ui-monospace, SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace`.

- [ ] **Step 1:** Test asserts every `select` option in `definitions.ts` is either short (< 24 chars) or carries an explicit human `label`, so no raw stack can be displayed again.
- [ ] **Step 2: Run** — FAIL on `terminal.fontFamily`.
- [ ] **Step 3:** Extend `SettingDefinition` with `type: 'font' | 'range'` and an `options` shape allowing `{ value, label }`. Keep the stored value the full stack.
- [ ] **Step 4:** `FontPicker` renders each option **in the font it names**; `TerminalPreview` shows a real prompt line at the current family+size.
- [ ] **Step 5:** `range` renders slider + number for `terminal.fontSize`, `editor.fontSize`, `editor.autoSaveDelay`.
- [ ] **Step 6:** Verify, commit.

## Task 7: Honest status

**Files:** modify `src/components/StatusBar.tsx` (or its real path), `src/stores/ui.ts`, bottom-panel tab list.

- [ ] **Step 1:** Test asserts the status bar contains no hardcoded `Spaces: 4` / `UTF-8` / `LF` literals and that the Output tab is gone.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Derive indentation and line endings from the active Monaco model; drop the second Unity indicator; remove the permanently-empty Output tab.
- [ ] **Step 4:** Verify, commit.

## Task 8: The two felt performance problems

**Files:** modify `src-tauri/src/file_scanner.rs` (watcher), `src/features/unity-console/components/UnityConsolePanel.tsx`.

- [ ] **Step 1:** Rust test asserts the watcher's event filter rejects paths under `Library/`, `Temp/`, `Logs/`, `obj/` and accepts `Assets/`. JS test asserts the console list is virtualized.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Apply `walk_policy`'s ignore rules to watcher events; virtualize the console with `useVirtualizer` and memoize the filter so it does not re-run over 10,000 rows per 100ms batch.
- [ ] **Step 4:** Verify, commit.

---

## Final verification

- [ ] `bun run verify` — all stages, `verify:intellisense` must report PASS not SKIPPED.
