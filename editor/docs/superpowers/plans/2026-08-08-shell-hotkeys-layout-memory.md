# Terminal Hotkey, Hotkeys in Inputs & Sidebar Width Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the terminal toggle to `mod+j`, make application hotkeys work while an input has focus, and make a side pane reopen at the width it was dragged to.

**Architecture:** Three independent fixes in the application shell. The terminal chord moves in the command registry and every display surface reads it back from there. Hotkeys reach `document` by enabling react-hotkeys-hook's contenteditable path and by narrowing one blanket `stopPropagation` to unmodified keys only. Sidebar width stops depending on Allotment's implicit internal cache: App tracks the widths itself and drives the restore through Allotment's imperative `resize()` handle, with the size arithmetic extracted into a pure, unit-tested module.

**Tech Stack:** React 19, TypeScript, Zustand, `react-hotkeys-hook@5.2.4`, `allotment@1.20.5`, `react-arborist`, Bun test runner.

**Spec:** `docs/superpowers/specs/2026-08-08-shell-hotkeys-layout-memory-design.md`

## Global Constraints

- **Test runner is `bun test`, not vitest.** `package.json:18` is `"test": "bun test src"`. Import from `bun:test`: `import { describe, expect, it } from 'bun:test';`
- **No DOM test infrastructure exists and none may be added.** Every existing test is a pure-logic `.test.ts`. There is no jsdom, no React Testing Library, no `ResizeObserver` harness. Do not add one. Where behaviour cannot be unit-tested, the task states the manual verification that replaces it.
- **Deep Modules architecture** (`CLAUDE.md`). Import a feature only through its `index.ts` barrel. New files inside `src/features/app-shell/` are feature-internal and must not be imported from outside that feature. `src/utils/` and `src/stores/` may be imported by anyone.
- **Branch:** commit on `heads/v0.3.0`. Never commit on `dev`.
- **Staging:** `git add -A` from `editor/` stages the whole repo including untracked files outside it. Always `git add` the explicit paths listed in each task.
- **Typecheck:** `bunx tsc --noEmit` must be clean before each commit.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/features/app-shell/layout-sizes.ts` | Pure side-pane width arithmetic: validating persisted widths, computing initial pane sizes, computing the size array for a restore. No React, no DOM. |
| `src/features/app-shell/layout-sizes.test.ts` | Tests for the above. |
| `src/features/app-shell/layout-persist.ts` | `createLayoutPersister` — a debounce factory over an injected writer, so drag frames do not each cause a disk write. |
| `src/features/app-shell/layout-persist.test.ts` | Tests for the above. |
| `src/features/explorer/components/tree-key-isolation.ts` | Pure predicate deciding whether a keystroke in the rename box must be withheld from the surrounding tree. |
| `src/features/explorer/components/tree-key-isolation.test.ts` | Tests for the above. |

**Modified:**

| File | Change |
| --- | --- |
| `src/App.tsx` | `terminal.toggle` chord; `view.toggleBottomPanel` loses its chord; layout sizing moves to `layout-sizes.ts`; adds the `AllotmentHandle` ref, width refs, and the restore layout effect; debounced persist. |
| `src/features/app-shell/components/ActivityBar.tsx` | Terminal tooltip reads the live chord instead of a hardcoded string. |
| `src/features/app-shell/skip-shell.test.ts` | Fixtures updated for the new chord ownership. |
| `src/features/app-shell/components/KeyboardShortcutManager.tsx` | Adds `enableOnContentEditable: true`. |
| `src/features/explorer/components/InlineInput.tsx` | Blanket `stopPropagation` narrowed via the new predicate. |

---

## Task 1: Move the terminal toggle to `mod+j`

**Files:**
- Modify: `src/App.tsx:472`, `src/App.tsx:694`
- Modify: `src/features/app-shell/components/ActivityBar.tsx:93`
- Test: `src/features/app-shell/skip-shell.test.ts`

**Interfaces:**
- Consumes: `formatKeybinding(kb: string, isMac?: boolean): string` from `src/utils/format-keybinding.ts` (already exists); `useCommandsStore` from `src/stores/commands.ts`.
- Produces: `terminal.toggle` is the sole owner of `mod+j`. `view.toggleBottomPanel` remains registered with no `keybinding`. `` mod+` `` is unbound.

**Background:** `terminal.toggle` opens the panel *and* spawns a terminal when none exists. `view.toggleBottomPanel` only flips visibility, so `mod+j` on a cold workspace opens an empty panel. Swapping which command owns the chord is the whole fix.

- [ ] **Step 1: Write the failing test**

In `src/features/app-shell/skip-shell.test.ts`, replace the existing `'keeps terminal-management commands working from inside a terminal'` block with the version below, and add the new block after it. The change: the `terminal.toggle` fixture moves from `` 'mod+`' `` to `'mod+j'`.

```ts
  // These must survive from terminal focus or they'd be unusable — you split a
  // pane from inside a pane. xterm is already told to swallow their chords, so
  // yielding would make them dead keys.
  it('keeps terminal-management commands working from inside a terminal', () => {
    const cases: Array<[string, string]> = [
      ['terminal.toggle', 'mod+j'],
      ['terminal.new', 'mod+shift+`'],
      ['terminal.split', 'mod+backslash'],
      ['terminal.focusNextPane', 'mod+shift+bracketright'],
      ['terminal.focusPreviousPane', 'mod+shift+bracketleft'],
    ];
    for (const [id, kb] of cases) {
      expect(commandBeatsShell(id, kb, inTerminalLinux)).toBe(true);
    }
  });

  // Ctrl+J is LF (0x0A) — squarely in the shell's vocabulary, and the exact
  // shape isBareCtrlLetterChord yields on. terminal.toggle is exempt anyway:
  // you have to be able to close the panel from inside the pane filling it,
  // and xterm already swallows the chord, so yielding would make it dead.
  it('lets terminal.toggle win mod+j even though Ctrl+J is the shell\'s LF', () => {
    expect(commandBeatsShell('terminal.toggle', 'mod+j', inTerminalLinux)).toBe(true);
    // Same chord, a command that is not terminal management: still yields.
    expect(commandBeatsShell('view.toggleBottomPanel', 'mod+j', inTerminalLinux)).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it passes already**

Run: `bun test src/features/app-shell/skip-shell.test.ts`
Expected: **PASS.** `commandBeatsShell` is a pure function over fixture arguments, and `terminal.toggle` is already in `COMMANDS_TO_SKIP_SHELL` (`skip-shell.ts:21`), so no production change is needed to satisfy it.

This is the one place in this plan where the test cannot fail first: the arbitration logic is already correct, and what changes is *which command holds the chord* — data in `App.tsx`, not logic. The test's job is to lock in the new ownership so a future edit cannot silently make `mod+j` yield to the shell. Record this in the commit message rather than contriving a failure.

- [ ] **Step 3: Move the chord in the command registry**

In `src/App.tsx`, at the `terminal.toggle` command (line 472), change:

```ts
      keybinding: 'mod+`',
```

to:

```ts
      // mod+j, not mod+`: this is the command that also spawns the first
      // terminal, and mod+j is the chord users reach for (signpost.ts:14
      // documents the reverse confusion this replaces). On Linux/Windows
      // Ctrl+J is LF, but terminal.toggle is in COMMANDS_TO_SKIP_SHELL so the
      // app wins — you must be able to close the panel from inside it.
      keybinding: 'mod+j',
```

- [ ] **Step 4: Drop the competing binding**

In `src/App.tsx`, at the `view.toggleBottomPanel` command (line 694), delete the `keybinding: 'mod+j',` line entirely and add a comment in its place:

```ts
    {
      id: 'view.toggleBottomPanel',
      label: 'Toggle Bottom Panel',
      category: 'View',
      // Deliberately unbound. `terminal.toggle` owns mod+j because it also
      // spawns the first terminal; this plain visibility flip stays reachable
      // from the command palette so two commands never share one chord.
      handler: () => {
        useUiStore.getState().toggleBottomPanel();
      },
    },
```

- [ ] **Step 5: Make the Terminal button's tooltip read the live chord**

In `src/features/app-shell/components/ActivityBar.tsx`, add the import at the top of the import block:

```ts
import { formatKeybinding } from '../../../utils/format-keybinding';
```

Inside the `ActivityBar` function body, below the other `use*` selectors (after the `changedCount` selector, before `const items`), add:

```ts
  // Read the chord back out of the registry rather than writing it here. The
  // tooltip used to hardcode "Cmd+`" and went stale the moment the binding
  // moved; formatKeybinding is the same formatter the onboarding signpost uses.
  const terminalChord = useCommandsStore(
    (s) => s.commands.get('terminal.toggle')?.keybinding
  );
```

Then replace line 93:

```tsx
          title="Terminal (Cmd+`)"
```

with:

```tsx
          title={terminalChord ? `Terminal (${formatKeybinding(terminalChord)})` : 'Terminal'}
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun test src`
Expected: PASS, no failures.

Run: `bunx tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx \
        src/features/app-shell/components/ActivityBar.tsx \
        src/features/app-shell/skip-shell.test.ts
git commit -m "fix(hotkeys): give mod+j to terminal.toggle, the one that spawns a terminal

view.toggleBottomPanel held mod+j and only flips visibility, so the chord
opened an empty panel on a cold workspace. terminal.toggle — which also
spawns the first terminal — held mod+\` instead. signpost.ts:14 already
documents users being told 'Ctrl+J opens the terminal'; this makes that
true rather than papering over it.

view.toggleBottomPanel stays palette-only so one chord has one owner, and
the Terminal button's tooltip now reads the chord out of the registry
instead of hardcoding it.

The skip-shell test asserts rather than drives the change: commandBeatsShell
is already correct, and what moved is which command holds the chord."
```

---

## Task 2: Let hotkeys fire while a contenteditable has focus

**Files:**
- Modify: `src/features/app-shell/components/KeyboardShortcutManager.tsx:37`

**Interfaces:**
- Consumes: nothing new.
- Produces: no API change.

**Background:** `KeyboardShortcutManager` passes `{ enableOnFormTags: true }`, which covers `<input>`/`<textarea>`/`<select>`. react-hotkeys-hook v5 gates contenteditable **separately** (`node_modules/react-hotkeys-hook/dist/index.js:194`):

```js
s.target?.isContentEditable && !t?.enableOnContentEditable || H(y, t?.delimiter).forEach(...)
```

With the option unset the handler is skipped entirely, so every app chord is dead in the Lexical AI chat box (`src/features/ai-panel/components/LexicalChatInput.tsx:111`).

**No unit test is possible.** This is a one-option change to a third-party hook whose behaviour only manifests against a live DOM with real focus, and the project has no DOM test infrastructure (see Global Constraints). Step 3 is the manual verification that replaces it — do not skip it, and do not add jsdom to make it automatable.

- [ ] **Step 1: Make the change**

In `src/features/app-shell/components/KeyboardShortcutManager.tsx`, replace line 37:

```ts
  }, { enableOnFormTags: true });
```

with:

```ts
    // enableOnFormTags covers <input>/<textarea>/<select>, but v5 gates
    // contenteditable behind a *separate* option (dist/index.js:194 bails when
    // `target.isContentEditable && !enableOnContentEditable`). Without it every
    // app chord is dead while typing in the Lexical AI chat box. Enabling it
    // makes that box behave like every other input rather than a special case.
  }, { enableOnFormTags: true, enableOnContentEditable: true });
```

- [ ] **Step 2: Typecheck and run the suite**

Run: `bunx tsc --noEmit`
Expected: no output. (`enableOnContentEditable?: boolean` is declared in `react-hotkeys-hook/dist/types.d.ts:33`.)

Run: `bun test src`
Expected: PASS.

- [ ] **Step 3: Verify manually in the running app**

Run: `bun run tauri dev`

Open a project, open the AI panel (`mod+shift+a`), click into the chat box so the caret is in it, then check:

| Press | Expect |
| --- | --- |
| `mod+b` | left sidebar toggles |
| `mod+p` | quick-open palette opens |
| `mod+shift+p` | command palette opens |
| typing letters | text still enters the chat box normally |
| `Enter` | still sends the message (Lexical keeps its own handling) |

Then confirm nothing regressed elsewhere: focus a terminal pane and press `mod+b` (sidebar toggles on macOS; on Linux/Windows it correctly yields to the shell), and open Monaco's find widget with `mod+f` and press `mod+g` (Monaco's Find Next runs, not the app's Go To Line).

- [ ] **Step 4: Commit**

```bash
git add src/features/app-shell/components/KeyboardShortcutManager.tsx
git commit -m "fix(hotkeys): fire app chords while the AI chat box has focus

react-hotkeys-hook v5 gates contenteditable behind its own option, separate
from enableOnFormTags — with it unset the handler bails outright, so every
shortcut was dead while typing in the Lexical chat input. Chords already
fire in ordinary <input>s, so this makes that box consistent rather than
privileged.

Verified by hand: no DOM test infrastructure exists in this project and
none was added for a third-party hook option."
```

---

## Task 3: Stop the explorer rename box from swallowing every hotkey

**Files:**
- Create: `src/features/explorer/components/tree-key-isolation.ts`
- Create: `src/features/explorer/components/tree-key-isolation.test.ts`
- Modify: `src/features/explorer/components/InlineInput.tsx:83-88`

**Interfaces:**
- Consumes: nothing.
- Produces: `isolateFromTree(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean` — `true` when the keystroke must be withheld from the surrounding tree.

**Background:** `InlineInput.tsx:86` calls `e.stopPropagation()` on *every* keydown. React attaches its listeners to `#root` (`src/main.tsx:76`), below `document` where react-hotkeys-hook listens, so this kills every shortcut during a rename. The call is not gratuitous — the input renders inside a `react-arborist` `Tree` (`ExplorerPanel.tsx:2`) whose arrow keys, type-ahead, Enter and Escape would otherwise hijack typing. Narrow it instead of deleting it.

- [ ] **Step 1: Write the failing test**

Create `src/features/explorer/components/tree-key-isolation.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { isolateFromTree } from './tree-key-isolation';

const plain = { ctrlKey: false, metaKey: false, altKey: false };

describe('isolateFromTree', () => {
  // The tree's whole keyboard vocabulary is unmodified keys: arrows, Home/End,
  // Enter, Escape, Space, and letters for type-ahead. All of it must be
  // withheld or renaming a file drives the tree selection instead.
  it('withholds unmodified keystrokes from the tree', () => {
    expect(isolateFromTree(plain)).toBe(true);
  });

  // These are app chords (mod+b, mod+p, ...). They have to reach `document`,
  // where react-hotkeys-hook listens — React's own listeners sit on #root,
  // below it, so stopping propagation here would kill them outright.
  it('lets modifier chords through to the document-level hotkey listener', () => {
    expect(isolateFromTree({ ...plain, metaKey: true })).toBe(false);
    expect(isolateFromTree({ ...plain, ctrlKey: true })).toBe(false);
    expect(isolateFromTree({ ...plain, altKey: true })).toBe(false);
  });

  it('lets a chord through whichever combination of modifiers it carries', () => {
    expect(isolateFromTree({ ctrlKey: true, metaKey: true, altKey: false })).toBe(false);
    expect(isolateFromTree({ ctrlKey: false, metaKey: true, altKey: true })).toBe(false);
    expect(isolateFromTree({ ctrlKey: true, metaKey: true, altKey: true })).toBe(false);
  });

  // Shift alone is not a chord modifier — Shift+letter is just typing a
  // capital, and Shift+Home is a selection the field owns. Bound to a variable
  // so the extra property doesn't trip object-literal excess property checking.
  it('treats shift alone as ordinary typing', () => {
    const withShift = { ...plain, shiftKey: true };
    expect(isolateFromTree(withShift)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/features/explorer/components/tree-key-isolation.test.ts`
Expected: FAIL — `Cannot find module './tree-key-isolation'`.

- [ ] **Step 3: Write the implementation**

Create `src/features/explorer/components/tree-key-isolation.ts`:

```ts
/**
 * Whether a keystroke typed in the inline rename box must be withheld from the
 * `react-arborist` tree it renders inside.
 *
 * The rename input sits *inside* the tree, so every keystroke bubbles through
 * the tree's keyboard handler on its way up. Unmodified keys are exactly the
 * tree's vocabulary — arrows, Home/End, Enter, Escape, Space, and letters for
 * type-ahead — so those are stopped, or renaming a file would drive the
 * selection instead of editing text.
 *
 * Modifier chords are let through. React attaches its listeners to `#root`
 * (`src/main.tsx:76`), below `document` where react-hotkeys-hook listens, so a
 * blanket `stopPropagation` here kills every application shortcut while a
 * rename is open — which is the bug this replaces.
 *
 * Accepted cost: Cmd/Ctrl+A now also reaches react-arborist's select-all,
 * highlighting tree rows. It does not touch the rename in progress or the text
 * selection in the field, and it is cheaper than leaving every shortcut dead.
 *
 * Shift is deliberately not a modifier here: Shift+letter is a capital and
 * Shift+Home is a selection, both of which the field owns.
 *
 * Pure so the policy can be tested without a DOM — the same reason
 * `app-shell/skip-shell.ts:52` is pure.
 */
export function isolateFromTree(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return !(e.ctrlKey || e.metaKey || e.altKey);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/features/explorer/components/tree-key-isolation.test.ts`
Expected: PASS, 4 tests (one per `it` block).

- [ ] **Step 5: Wire it into the input**

In `src/features/explorer/components/InlineInput.tsx`, add to the imports at the top:

```ts
import { isolateFromTree } from './tree-key-isolation';
```

Then replace the `onKeyDown` handler (lines 83-88):

```tsx
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(inputRef.current?.value ?? ''); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          e.stopPropagation();
        }}
```

with:

```tsx
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(inputRef.current?.value ?? ''); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          // Not a blanket stop: that also blocked every app hotkey, because
          // react-hotkeys-hook listens on `document` and React's listeners sit
          // on #root below it. See tree-key-isolation.ts for the policy.
          if (isolateFromTree(e)) e.stopPropagation();
        }}
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun test src`
Expected: PASS.

Run: `bunx tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Verify manually in the running app**

Run: `bun run tauri dev`. In the explorer, start renaming a file (right-click → Rename, or select and press Enter):

| Press | Expect |
| --- | --- |
| `mod+b` | left sidebar toggles — the fix |
| letters | text enters the field; tree selection does **not** jump via type-ahead |
| `ArrowUp` / `ArrowDown` | caret/selection stays in the field; tree selection does not move |
| `Enter` | rename commits |
| `Escape` | rename cancels |

- [ ] **Step 8: Commit**

```bash
git add src/features/explorer/components/tree-key-isolation.ts \
        src/features/explorer/components/tree-key-isolation.test.ts \
        src/features/explorer/components/InlineInput.tsx
git commit -m "fix(explorer): stop the rename box from killing every app hotkey

InlineInput stopped propagation on every keydown. React's listeners sit on
#root, below the document listener react-hotkeys-hook uses, so renaming a
file made every shortcut dead.

The stop is not gratuitous — it keeps react-arborist's arrows, type-ahead,
Enter and Escape out of the field — so narrow it instead of removing it:
withhold unmodified keys, let ctrl/meta/alt chords bubble. Policy extracted
pure and tested, same shape as skip-shell.ts.

Costs Cmd+A reaching arborist's select-all during a rename, which only
highlights rows. Cheaper than dead shortcuts."
```

---

## Task 4: Extract the side-pane width arithmetic

**Files:**
- Create: `src/features/app-shell/layout-sizes.ts`
- Create: `src/features/app-shell/layout-sizes.test.ts`
- Modify: `src/App.tsx:127-143`

**Interfaces:**
- Consumes: `LayoutSizes` from `src/utils/persistence.ts` (fields used: `sidebar?: number`, `rightPanel?: number`).
- Produces:
  - `MAX_SIDE_FRACTION: 0.8`
  - `DEFAULT_SIDE_FRACTION: 0.3`
  - `MIN_EDITOR_WIDTH: 320`
  - `EDITOR_PANE_INDEX: 1`
  - `resolveSideWidth(persisted: number | undefined, windowWidth: number, fallbackFraction: number): number`
  - `initialPaneSizes(persisted: { sidebar?: number; rightPanel?: number }, windowWidth: number): { left: number; right: number; sizes: number[] }`
  - `widthsForRestore(current: readonly number[], paneIndex: number, width: number, editorIndex: number, minEditorWidth: number): number[]`

Task 5 consumes `initialPaneSizes`, `widthsForRestore`, `EDITOR_PANE_INDEX` and `MIN_EDITOR_WIDTH` by exactly these names.

**Background:** `App.tsx:127-143` computes initial pane sizes inline, and discards any persisted width above **45%** of the window — so a deliberately wide sidebar silently reverts to 30% on restart. This task moves that arithmetic into a tested module and raises the cap to 80%. `widthsForRestore` is new and exists for Task 5.

- [ ] **Step 1: Write the failing test**

Create `src/features/app-shell/layout-sizes.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_SIDE_FRACTION,
  EDITOR_PANE_INDEX,
  MAX_SIDE_FRACTION,
  MIN_EDITOR_WIDTH,
  initialPaneSizes,
  resolveSideWidth,
  widthsForRestore,
} from './layout-sizes';

const W = 1600;

describe('resolveSideWidth', () => {
  it('uses a plausible persisted width verbatim', () => {
    expect(resolveSideWidth(420, W, DEFAULT_SIDE_FRACTION)).toBe(420);
  });

  it('rounds a fractional persisted width', () => {
    expect(resolveSideWidth(420.6, W, DEFAULT_SIDE_FRACTION)).toBe(421);
  });

  it('falls back to the fraction when nothing is persisted', () => {
    expect(resolveSideWidth(undefined, W, DEFAULT_SIDE_FRACTION)).toBe(480);
  });

  // Guards against leftovers from a bad layout reopening a pane absurdly wide.
  it('rejects garbage values', () => {
    expect(resolveSideWidth(0, W, DEFAULT_SIDE_FRACTION)).toBe(480);
    expect(resolveSideWidth(-10, W, DEFAULT_SIDE_FRACTION)).toBe(480);
    expect(resolveSideWidth(Number.NaN, W, DEFAULT_SIDE_FRACTION)).toBe(480);
    expect(resolveSideWidth(Number.POSITIVE_INFINITY, W, DEFAULT_SIDE_FRACTION)).toBe(480);
  });

  // The regression this raises the cap for: 45% used to discard a deliberately
  // wide sidebar on restart and snap back to 30%.
  it('honours a wide sidebar up to the cap', () => {
    expect(resolveSideWidth(W * 0.5, W, DEFAULT_SIDE_FRACTION)).toBe(800);
    expect(resolveSideWidth(W * MAX_SIDE_FRACTION, W, DEFAULT_SIDE_FRACTION)).toBe(1280);
  });

  it('rejects a width past the cap', () => {
    expect(resolveSideWidth(W * 0.9, W, DEFAULT_SIDE_FRACTION)).toBe(480);
  });
});

describe('initialPaneSizes', () => {
  it('gives each side the default fraction when nothing is persisted', () => {
    const { left, right, sizes } = initialPaneSizes({}, W);
    expect(left).toBe(480);
    expect(right).toBe(480);
    expect(sizes).toEqual([480, 640, 480]);
  });

  it('puts panes in [sidebar, editor, rightPanel] order', () => {
    const { sizes } = initialPaneSizes({ sidebar: 300, rightPanel: 500 }, W);
    expect(sizes).toEqual([300, 800, 500]);
    expect(sizes[EDITOR_PANE_INDEX]).toBe(800);
  });

  it('never lets the editor collapse below its floor', () => {
    const { sizes } = initialPaneSizes({ sidebar: 700, rightPanel: 700 }, 1000);
    expect(sizes[EDITOR_PANE_INDEX]).toBe(MIN_EDITOR_WIDTH);
  });
});

describe('widthsForRestore', () => {
  // Reopening the left sidebar at 400: the editor absorbs the difference and
  // the total stays pinned to the container width.
  it('reopens a pane at the given width, editor absorbing the change', () => {
    const next = widthsForRestore([0, 1120, 480], 0, 400, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next).toEqual([400, 720, 480]);
    expect(next.reduce((a, b) => a + b, 0)).toBe(1600);
  });

  it('reopens the right pane the same way', () => {
    const next = widthsForRestore([480, 1120, 0], 2, 300, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next).toEqual([480, 820, 300]);
    expect(next.reduce((a, b) => a + b, 0)).toBe(1600);
  });

  it('rounds a fractional width', () => {
    const next = widthsForRestore([0, 1120, 480], 0, 400.4, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next[0]).toBe(400);
  });

  // A remembered width that no longer fits (window shrank, other pane grew)
  // must not squeeze the editor out of existence: the editor takes its floor
  // and the reopening pane gives way.
  it('clamps the reopening pane so the editor keeps its floor', () => {
    const next = widthsForRestore([0, 500, 300], 0, 400, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next[EDITOR_PANE_INDEX]).toBe(MIN_EDITOR_WIDTH);
    expect(next).toEqual([180, 320, 300]);
    expect(next.reduce((a, b) => a + b, 0)).toBe(800);
  });

  // Beyond clamping: the other pane alone plus the editor floor already
  // overflows the container, so no arrangement fits. Floor the reopening pane
  // at 0 rather than going negative — Allotment's resizeViews clamps each
  // entry to the view's own [min, max] and re-runs layout, so an array that
  // over-sums is absorbed rather than fatal.
  it('floors at zero when no arrangement fits', () => {
    const next = widthsForRestore([0, 200, 600], 0, 500, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(next[0]).toBe(0);
    expect(next[EDITOR_PANE_INDEX]).toBe(MIN_EDITOR_WIDTH);
  });

  it('does not mutate the array it is given', () => {
    const current = [0, 1120, 480];
    widthsForRestore(current, 0, 400, EDITOR_PANE_INDEX, MIN_EDITOR_WIDTH);
    expect(current).toEqual([0, 1120, 480]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/features/app-shell/layout-sizes.test.ts`
Expected: FAIL — `Cannot find module './layout-sizes'`.

- [ ] **Step 3: Write the implementation**

Create `src/features/app-shell/layout-sizes.ts`:

```ts
/**
 * Side-pane width arithmetic for the app shell's horizontal Allotment.
 *
 * Pure so the policy can be tested without a DOM — the same reason
 * `skip-shell.ts:52` is pure. This project has no component-test
 * infrastructure, so anything that must be verified is kept out of the React
 * wiring and lives here instead.
 *
 * Pane order in the horizontal group is fixed: [sidebar, editor, rightPanel].
 * All three are permanently mounted and toggled via Allotment's `visible`
 * prop, so the indices are stable regardless of what is currently shown.
 */

/** Fraction of the window each side pane gets on first open. */
export const DEFAULT_SIDE_FRACTION = 0.3;

/**
 * Largest fraction of the window a *persisted* side width may claim.
 *
 * This exists to discard leftovers from a bad layout, not to overrule the
 * user. It was 0.45, which silently snapped any deliberately wide sidebar back
 * to DEFAULT_SIDE_FRACTION on the next launch — the layout looked forgotten
 * because it was.
 */
export const MAX_SIDE_FRACTION = 0.8;

/** The editor never shrinks below this, however wide the side panes get. */
export const MIN_EDITOR_WIDTH = 320;

/** Index of the editor pane in the horizontal group. */
export const EDITOR_PANE_INDEX = 1;

/**
 * A persisted side-pane width, or the fallback fraction when the stored value
 * is missing, malformed, or implausible.
 */
export function resolveSideWidth(
  persisted: number | undefined,
  windowWidth: number,
  fallbackFraction: number,
): number {
  if (
    typeof persisted !== 'number' ||
    !Number.isFinite(persisted) ||
    persisted <= 0 ||
    persisted > windowWidth * MAX_SIDE_FRACTION
  ) {
    return Math.round(windowWidth * fallbackFraction);
  }
  return Math.round(persisted);
}

/**
 * Pane sizes for the initial mount, as absolute px.
 *
 * Allotment scales `defaultSizes` to fit, and wants one entry per
 * always-mounted pane.
 */
export function initialPaneSizes(
  persisted: { sidebar?: number; rightPanel?: number },
  windowWidth: number,
): { left: number; right: number; sizes: number[] } {
  const left = resolveSideWidth(persisted.sidebar, windowWidth, DEFAULT_SIDE_FRACTION);
  const right = resolveSideWidth(persisted.rightPanel, windowWidth, DEFAULT_SIDE_FRACTION);
  const editor = Math.max(windowWidth - left - right, MIN_EDITOR_WIDTH);
  return { left, right, sizes: [left, editor, right] };
}

/**
 * Sizes to hand `AllotmentHandle.resize` so `paneIndex` reopens at `width`.
 *
 * The editor absorbs the difference, matching the LayoutPriority.High it is
 * given in App.tsx — side panes hold their width and the editor takes the
 * delta. The total is pinned to the container width (the sum of `current`) so
 * the call cannot change the group's overall size.
 *
 * When the remembered width no longer fits — the window shrank, or the other
 * side pane grew while this one was hidden — the editor keeps `minEditorWidth`
 * and the reopening pane takes what is left.
 */
export function widthsForRestore(
  current: readonly number[],
  paneIndex: number,
  width: number,
  editorIndex: number,
  minEditorWidth: number,
): number[] {
  const total = current.reduce((sum, n) => sum + n, 0);
  const next = [...current];
  next[paneIndex] = Math.round(width);

  const nonEditor = next.reduce((sum, n, i) => (i === editorIndex ? sum : sum + n), 0);
  const editor = total - nonEditor;

  if (editor >= minEditorWidth) {
    next[editorIndex] = editor;
    return next;
  }

  // Doesn't fit: the editor's floor wins and the reopening pane gives way.
  const otherPanes = nonEditor - next[paneIndex];
  next[editorIndex] = minEditorWidth;
  next[paneIndex] = Math.max(0, total - minEditorWidth - otherPanes);
  return next;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/features/app-shell/layout-sizes.test.ts`
Expected: PASS, 16 tests (6 `resolveSideWidth`, 3 `initialPaneSizes`, 7 `widthsForRestore`).

- [ ] **Step 5: Use it from App.tsx**

In `src/App.tsx`, add the import after the `./utils/persistence` import block:

```ts
import {
  DEFAULT_SIDE_FRACTION,
  EDITOR_PANE_INDEX,
  MIN_EDITOR_WIDTH,
  initialPaneSizes,
  widthsForRestore,
} from './features/app-shell/layout-sizes';
```

`DEFAULT_SIDE_FRACTION`, `EDITOR_PANE_INDEX`, `MIN_EDITOR_WIDTH` and `widthsForRestore` are unused until Task 5. If your editor's lint run fails on unused imports before then, import only `initialPaneSizes` in this task and add the rest in Task 5.

Then replace the whole `initialLayout` memo (lines 124-143) with:

```ts
  // Initial horizontal split: each side pane defaults to 30% of the window on
  // first open (editor takes the rest); persisted drags win. Arithmetic lives
  // in layout-sizes.ts so it can be unit-tested — see that module for why the
  // implausible-value cap is 80% rather than the 45% that used to discard a
  // deliberately wide sidebar on every launch.
  const initialLayout = useMemo(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
    return initialPaneSizes(persistedLayout, w);
  }, [persistedLayout]);
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `bun test src`
Expected: PASS.

Run: `bunx tsc --noEmit`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/features/app-shell/layout-sizes.ts \
        src/features/app-shell/layout-sizes.test.ts \
        src/App.tsx
git commit -m "refactor(app-shell): extract side-pane width arithmetic, raise the cap to 80%

App.tsx computed initial pane sizes inline and threw away any persisted
width above 45% of the window, so a deliberately wide sidebar reverted to
30% on every launch — the layout looked forgotten because it was.

Moves the arithmetic to a pure, tested layout-sizes module (the shape
skip-shell.ts already uses for untestable-in-place policy) and adds
widthsForRestore, which the next commit needs to reopen a pane at the
width it was dragged to."
```

---

## Task 5: Reopen a side pane at the width it was dragged to

**Files:**
- Modify: `src/App.tsx` — imports, the `initialLayout` area, the `Allotment` element (lines 1151-1169), the sidebar/right `Allotment.Pane` elements

**Interfaces:**
- Consumes: `initialPaneSizes`, `widthsForRestore`, `EDITOR_PANE_INDEX`, `MIN_EDITOR_WIDTH` from Task 4; `AllotmentHandle` type from `allotment`.
- Produces: no exported API. Task 6 replaces the `saveLayoutSizes` call inside the `onLayoutChange` callback written here.

**Background:** Allotment caches a hidden pane's size in `ViewItem._cachedVisibleSize` and restores it on show, but the width is not reliably coming back. The internal failure was not isolated (see the spec's Investigation section) and the fix does not depend on identifying it: App tracks the widths itself and drives the restore through the imperative handle.

**Ordering is load-bearing.** React runs child layout effects before parent ones, so Allotment's reconcile — which flips the pane visible and fires `onChange` — has already run when App's `useLayoutEffect` fires. Using `useLayoutEffect` rather than `useEffect` means no frame paints at the wrong width.

**Two refs, not one.** On a show, Allotment's `onChange` fires *before* App's effect and would overwrite the live width ref with whatever (possibly wrong) width the pane came back at. So the width to reopen with is snapshotted at *hide* time into a separate ref that the show path reads.

**No unit test is possible** for the wiring — it is React lifecycle plus a third-party imperative handle, and there is no DOM test infrastructure. The arithmetic it depends on is fully tested in Task 4; Step 6 is the manual verification for the wiring.

- [ ] **Step 1: Add the imports**

In `src/App.tsx`, replace line 1 (currently `import { useEffect, useMemo, useRef, useState } from 'react';`) with:

```ts
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
```

and replace line 2 with:

```ts
import { Allotment, LayoutPriority, type AllotmentHandle } from 'allotment';
```

`AllotmentHandle` is a public export (`allotment/dist/types/src/index.d.ts:1`), and `Allotment` is typed `React.RefAttributes<AllotmentHandle>`, so `useRef<AllotmentHandle>(null)` binds to `ref` without a cast.

Confirm the Task 4 import block now pulls in all five names:

```ts
import {
  DEFAULT_SIDE_FRACTION,
  EDITOR_PANE_INDEX,
  MIN_EDITOR_WIDTH,
  initialPaneSizes,
  widthsForRestore,
} from './features/app-shell/layout-sizes';
```

- [ ] **Step 2: Add the refs**

In `src/App.tsx`, immediately after the `initialLayout` memo from Task 4, add:

```ts
  const allotmentRef = useRef<AllotmentHandle>(null);

  // Live pane sizes, as last reported by Allotment. Kept in a ref rather than
  // state so a drag doesn't re-render the whole shell on every frame.
  const currentSizesRef = useRef<number[]>(initialLayout.sizes);

  // Width each side pane had the last time it was *visible*.
  const liveWidthsRef = useRef({
    sidebar: initialLayout.left,
    rightPanel: initialLayout.right,
  });

  // Width to reopen each side pane at, snapshotted when it was last hidden.
  //
  // Separate from liveWidthsRef on purpose: on a show, Allotment's onChange
  // fires before this component's layout effect, so a single ref would already
  // have been overwritten with whatever width the pane came back at — which is
  // the value we are trying to correct.
  const restoreWidthsRef = useRef({
    sidebar: initialLayout.left,
    rightPanel: initialLayout.right,
  });

  const prevShownRef = useRef({ sidebar: sidebarVisible, rightPanel: rightSidebarVisible });
```

- [ ] **Step 3: Add the onChange callback**

Still in `src/App.tsx`, after the refs above, add:

```ts
  // Reads visibility from the store rather than the render closure. Allotment
  // assigns `onDidChange` in an effect that runs *after* its reconcile effect,
  // so the callback invoked during a visibility flip is the previous render's
  // — with a stale `sidebarVisible` captured. getState() is always current.
  const onLayoutChange = useCallback((sizes: number[]) => {
    currentSizesRef.current = sizes;
    const ui = useUiStore.getState();

    // Record each side's width only while it is actually shown (>0), so a
    // hidden pane keeps its last width instead of recording 0.
    const next: { sidebar?: number; rightPanel?: number } = {};
    if (ui.sidebarVisible && sizes[0] > 0) {
      liveWidthsRef.current.sidebar = sizes[0];
      next.sidebar = sizes[0];
    }
    const last = sizes[sizes.length - 1];
    if (ui.rightSidebarVisible && sizes.length >= 3 && last > 0) {
      liveWidthsRef.current.rightPanel = last;
      next.rightPanel = last;
    }
    if (next.sidebar !== undefined || next.rightPanel !== undefined) {
      saveLayoutSizes(next);
    }
  }, []);
```

(`useCallback` was added to the React import in Step 1.)

- [ ] **Step 4: Add the restore layout effect**

Still in `src/App.tsx`, directly after `onLayoutChange`, add:

```ts
  // Reopen a side pane at the width it was dragged to.
  //
  // Allotment caches a hidden pane's size and is supposed to restore it, but
  // the width does not reliably come back. Rather than depend on that implicit
  // cache, drive the restore explicitly. useLayoutEffect, not useEffect: React
  // runs child layout effects first, so Allotment has already made the pane
  // visible by now, and committing the correct width here means no frame ever
  // paints at the wrong one.
  useLayoutEffect(() => {
    const prev = prevShownRef.current;
    prevShownRef.current = { sidebar: sidebarVisible, rightPanel: rightSidebarVisible };

    // Going hidden: snapshot the width to come back at. liveWidthsRef is still
    // the pre-hide width — the onChange that just fired reported 0 for this
    // pane and its `>0` guard refused to record it.
    if (prev.sidebar && !sidebarVisible) {
      restoreWidthsRef.current.sidebar = liveWidthsRef.current.sidebar;
    }
    if (prev.rightPanel && !rightSidebarVisible) {
      restoreWidthsRef.current.rightPanel = liveWidthsRef.current.rightPanel;
    }

    const handle = allotmentRef.current;
    if (!handle) return;

    let paneIndex: number | null = null;
    let width = 0;
    if (!prev.sidebar && sidebarVisible) {
      paneIndex = 0;
      width = restoreWidthsRef.current.sidebar;
    } else if (!prev.rightPanel && rightSidebarVisible) {
      paneIndex = currentSizesRef.current.length - 1;
      width = restoreWidthsRef.current.rightPanel;
    }
    if (paneIndex === null) return;

    handle.resize(
      widthsForRestore(
        currentSizesRef.current,
        paneIndex,
        width,
        EDITOR_PANE_INDEX,
        MIN_EDITOR_WIDTH,
      ),
    );
  }, [sidebarVisible, rightSidebarVisible]);
```

- [ ] **Step 5: Wire the ref and callback into the JSX**

In `src/App.tsx`, replace the opening `<Allotment>` tag and its inline `onChange` (lines 1151-1169) with:

```tsx
              <Allotment
                ref={allotmentRef}
                proportionalLayout={false}
                defaultSizes={initialLayout.sizes}
                onChange={onLayoutChange}
              >
```

Leave the three `Allotment.Pane` elements and the explanatory comment between them exactly as they are — `preferredSize={initialLayout.left}` and `preferredSize={initialLayout.right}` still serve the initial mount.

- [ ] **Step 6: Run the suite, typecheck, and verify manually**

Run: `bun test src`
Expected: PASS.

Run: `bunx tsc --noEmit`
Expected: no output.

Run: `bun run tauri dev` and check:

| Action | Expect |
| --- | --- |
| Drag the left sidebar wide, `mod+b`, `mod+b` | reopens at the dragged width |
| Drag it narrow (near the 150px min), `mod+b` twice | reopens narrow |
| Same for the right sidebar with `mod+k` | reopens at its dragged width |
| Toggle the left sidebar via the Activity Bar icon instead of the chord | same result |
| Open both side panes wide, then shrink the window | editor never disappears; panes give way |
| Hide the sidebar, resize the window smaller, reopen | reopens clamped, editor keeps ≥320px |
| Quit and relaunch | both panes reopen at their last width |

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "fix(app-shell): reopen a side pane at the width it was dragged to

Allotment caches a hidden pane's size and is supposed to restore it; the
width was not reliably coming back and the internal failure was not
isolated. Rather than keep reverse-engineering minified third-party code,
App now owns the widths and drives the restore through Allotment's
imperative resize() handle — deterministic regardless of the internals.

Two refs, not one: on a show, Allotment's onChange fires before this
component's layout effect and would overwrite the live width with the
wrong value being corrected, so the reopen width is snapshotted at hide.

onChange also now reads visibility from the store instead of the render
closure. Allotment assigns onDidChange in an effect that runs after its
reconcile effect, so the callback firing during a visibility flip is the
previous render's, with stale visibility captured."
```

---

## Task 6: Stop writing to disk on every drag frame

**Files:**
- Create: `src/features/app-shell/layout-persist.ts`
- Create: `src/features/app-shell/layout-persist.test.ts`
- Modify: `src/App.tsx` — the `onLayoutChange` callback and the vertical Allotment's `onChange`

**Interfaces:**
- Consumes: `saveLayoutSizes(sizes: LayoutSizes): void` from `src/utils/persistence.ts`.
- Produces: `createLayoutPersister<T>(write: (value: T) => void, delayMs?: number): { persist(value: T): void; flush(): void; cancel(): void }`

**Background:** `onChange` fires once per mousemove frame during a drag. Each call reaches `saveLayoutSizes` → `writeWindowState` → `await win.save()` (`persistence.ts:316`) — a disk write per frame. Debounce it.

The in-session restore path never reads persistence (it reads `liveWidthsRef`/`restoreWidthsRef` from Task 5), so deferring the write cannot affect it.

- [ ] **Step 1: Write the failing test**

Create `src/features/app-shell/layout-persist.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import { createLayoutPersister } from './layout-persist';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createLayoutPersister', () => {
  it('writes once for a burst of calls', async () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => writes.push(v), 10);
    for (let i = 1; i <= 20; i++) p.persist(i);
    expect(writes).toEqual([]);
    await tick(30);
    expect(writes).toEqual([20]);
  });

  it('writes again after the window closes', async () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => writes.push(v), 10);
    p.persist(1);
    await tick(30);
    p.persist(2);
    await tick(30);
    expect(writes).toEqual([1, 2]);
  });

  // A hard quit right after releasing a drag must not lose it.
  it('flush writes the pending value immediately', async () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => writes.push(v), 1000);
    p.persist(7);
    p.flush();
    expect(writes).toEqual([7]);
    await tick(20);
    expect(writes).toEqual([7]); // the timer did not fire a second write
  });

  it('flush is a no-op when nothing is pending', () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => writes.push(v), 10);
    p.flush();
    p.flush();
    expect(writes).toEqual([]);
  });

  it('cancel drops the pending write', async () => {
    const writes: number[] = [];
    const p = createLayoutPersister<number>((v) => writes.push(v), 10);
    p.persist(1);
    p.cancel();
    await tick(30);
    expect(writes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/features/app-shell/layout-persist.test.ts`
Expected: FAIL — `Cannot find module './layout-persist'`.

- [ ] **Step 3: Write the implementation**

Create `src/features/app-shell/layout-persist.ts`:

```ts
/**
 * Trailing-edge debounce for layout persistence.
 *
 * Allotment's `onChange` fires once per mousemove frame during a sash drag,
 * and `saveLayoutSizes` reaches an `await store.save()` — a disk write per
 * frame. Only the last value of a drag is worth keeping.
 *
 * The writer is injected rather than imported so the timing can be tested
 * without pulling in the Tauri store, which does not exist under `bun test`.
 *
 * Safe to defer: nothing in-session reads persistence back. App holds the live
 * pane widths in refs and restores from those, so the persisted copy only
 * matters at next launch.
 */
export function createLayoutPersister<T>(
  write: (value: T) => void,
  delayMs = 250,
): { persist(value: T): void; flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    persist(value: T): void {
      pending = { value };
      clear();
      timer = setTimeout(() => {
        timer = null;
        const p = pending;
        pending = null;
        if (p) write(p.value);
      }, delayMs);
    },

    /** Write any pending value now — for teardown, before the window goes. */
    flush(): void {
      clear();
      const p = pending;
      pending = null;
      if (p) write(p.value);
    },

    cancel(): void {
      clear();
      pending = null;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/features/app-shell/layout-persist.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Use it from App.tsx**

In `src/App.tsx`, add the import next to the Task 4 layout-sizes import:

```ts
import { createLayoutPersister } from './features/app-shell/layout-persist';
```

Add the persister above `onLayoutChange`, and flush it on unmount:

```ts
  // One persister per window, flushed on teardown so a quit right after a drag
  // still keeps the width. See layout-persist.ts for why this is debounced.
  const layoutPersister = useMemo(
    () => createLayoutPersister<Parameters<typeof saveLayoutSizes>[0]>(saveLayoutSizes),
    [],
  );
  useEffect(() => () => layoutPersister.flush(), [layoutPersister]);
```

Then in `onLayoutChange`, replace the write call:

```ts
    if (next.sidebar !== undefined || next.rightPanel !== undefined) {
      saveLayoutSizes(next);
    }
```

with:

```ts
    if (next.sidebar !== undefined || next.rightPanel !== undefined) {
      layoutPersister.persist(next);
    }
```

and add `layoutPersister` to that `useCallback`'s dependency array:

```ts
  }, [layoutPersister]);
```

The vertical Allotment (line 1185) has the same per-frame problem. Replace:

```tsx
                    <Allotment vertical onChange={(sizes) => saveLayoutSizes({ vertical: sizes })}>
```

with:

```tsx
                    <Allotment vertical onChange={onVerticalLayoutChange}>
```

and define that callback next to `onLayoutChange`:

```ts
  const verticalPersister = useMemo(
    () => createLayoutPersister<number[]>((vertical) => saveLayoutSizes({ vertical })),
    [],
  );
  useEffect(() => () => verticalPersister.flush(), [verticalPersister]);
  const onVerticalLayoutChange = useCallback(
    (sizes: number[]) => verticalPersister.persist(sizes),
    [verticalPersister],
  );
```

- [ ] **Step 6: Run the suite, typecheck, and verify manually**

Run: `bun test src`
Expected: PASS.

Run: `bunx tsc --noEmit`
Expected: no output.

Run: `bun run tauri dev`:

| Action | Expect |
| --- | --- |
| Drag the sidebar, release, wait a second, quit, relaunch | reopens at the dragged width |
| Drag the bottom panel's height, release, quit, relaunch | reopens at the dragged height |
| Drag continuously for several seconds | no stutter; the drag stays smooth |

- [ ] **Step 7: Commit**

```bash
git add src/features/app-shell/layout-persist.ts \
        src/features/app-shell/layout-persist.test.ts \
        src/App.tsx
git commit -m "perf(app-shell): debounce layout persistence instead of writing per frame

Allotment's onChange fires once per mousemove frame, and saveLayoutSizes
reaches an await store.save() — a disk write per frame of every sash drag,
on both the horizontal and vertical groups.

Trailing-edge debounce with a flush on unmount, so a quit straight after a
drag still keeps the width. Deferring is safe because nothing in-session
reads persistence back: the restore path uses App's own width refs."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 `terminal.toggle` → `mod+j` | Task 1, Step 3 |
| §1 `view.toggleBottomPanel` drops its chord | Task 1, Step 4 |
| §1 ActivityBar tooltip from the registry | Task 1, Step 5 |
| §1 `Ctrl+J` behaviour inside a terminal | Task 1, Steps 1-2 (test) |
| §2a `enableOnContentEditable` | Task 2 |
| §2b `InlineInput` narrowing + `Cmd+A` tradeoff comment | Task 3 |
| §3 width tracking, `AllotmentHandle`, layout effect | Task 5 |
| §3 pure `layout-sizes.ts` + `bun test` | Task 4 |
| §3 restore cap 45% → 80% | Task 4, `MAX_SIDE_FRACTION` |
| §3 persist debounce | Task 6 |
| Out of scope: `.find-widget`, multi-chord commands, other terminal bindings | not touched by any task |

No gaps.

**Placeholder scan:** No TBD/TODO. Every code step carries the literal code. No "similar to Task N" — Task 3's and Task 4's pure-module docblocks each spell out their own rationale rather than cross-referencing.

**Type consistency:** `initialPaneSizes`, `widthsForRestore`, `EDITOR_PANE_INDEX`, `MIN_EDITOR_WIDTH`, `DEFAULT_SIDE_FRACTION`, `MAX_SIDE_FRACTION` are defined in Task 4 and used under those exact names in Tasks 4-5. `isolateFromTree` is defined and used in Task 3. `createLayoutPersister`'s `{ persist, flush, cancel }` shape matches its use in Task 6. `AllotmentHandle.resize(sizes: number[])` matches `allotment/dist/types/src/allotment.d.ts`. `onLayoutChange` is introduced in Task 5, Step 3 and modified in Task 6, Step 5 — Task 6 quotes the exact lines it replaces.

**Ordering note:** Tasks 1-3 are independent of each other and of 4-6. Task 5 depends on Task 4; Task 6 depends on Task 5 (it edits the callback Task 5 introduces). Run them in order.

---

## Post-Execution Corrections

Written after the plan was executed. **The plan text above is the plan as written, not as built** — it contains defects that review caught. Do not re-run it without applying these. Each was escalated to and ruled on by the human.

**1. Task 3 was reverted in full.** Narrowing `InlineInput`'s propagation stop was wrong. Modifier chords that bubble past it reach `react-arborist`'s container key handler, which only stands down when `tree.isEditing` — and this app renames via its own `renamingNodeId` state, never entering arborist's edit mode, so that guard never closes. An unconditional type-ahead then calls `tree.focus()`, `row-container.js:50` turns that into a real DOM `focus()` on another row, the rename input blurs, and `onBlur` commits the half-typed name. Dead hotkeys beat silent data loss. A real fix requires making the rename register as an arborist edit; see the comment left in `InlineInput.tsx`. **Spec §2b is therefore not delivered.**

**2. Every deep import in this plan is wrong.** `scripts/check-deep-modules.mjs` (`package.json` → `check:modules`) mechanically rejects them. All app-shell symbols must be exported from `src/features/app-shell/index.ts` and imported through the barrel. This affects Task 4 Step 5, Task 5 Step 1, and Task 6 Step 5.

**3. Task 4's `widthsForRestore` needs a zero floor.** As written it returns a negative pane width for non-positive input: `widthsForRestore([0,1120,480], 0, -50, 1, 320)` → `[-50, 1170, 480]`, because shrinking the pane only grows the editor and so makes the "fits" branch *more* likely to be taken. Use `next[paneIndex] = Math.max(0, Math.round(width));`. Task 4's step text also miscounts the tests as 16; the code block contains 15.

**4. Task 5 had two defects.** Its `onLayoutChange` comment blames "the previous render's callback with a stale `sidebarVisible` captured" — false, since the callback is `useCallback(fn, [])` and captures no visibility value. The real reason `getState()` is required is that Allotment rebinds `onDidChange` in a *passive* effect, which always lags a same-commit layout-effect-timed flip **regardless of the callback's deps** — so the original wording would lead a maintainer to "just add deps" and reintroduce the bug. Separately, its `if`/`else if` restore branch drops the right pane when both panes show in one commit; use two independent `if` blocks, each reading `currentSizesRef.current` **fresh** (the first `resize()` re-enters `onLayoutChange` and updates it before the second read).

**5. Task 6's flush-on-unmount is dead code.** `src/main.tsx` renders `<App/>` once and nothing calls `.unmount()`; a Tauri window close tears down the JS context without running React cleanups. Combined with the debounce delaying the write, that made drag-then-quit *worse* than before the task. Flush through the codebase's existing close paths instead — `useCloseGuard.ts`'s awaited `onCloseRequested` handler and `App.tsx`'s `beforeunload` listener — which requires the persisters to be module-scope rather than `useMemo`'d. Task 6's flush test also needs retiming: at `delayMs=1000` with `tick(20)` it proves nothing.

**A general rule this plan violated:** no task's commit message may assert verification the executing agent cannot perform. Task 2's mandated message said "Verified by hand" for a GUI check that never ran. Every GUI verification step in Tasks 2, 3, 5 and 6 is un-runnable by an agent and must be handed to a human.
