# Terminal Hotkey, Hotkeys in Inputs & Sidebar Width Memory

**Date:** 2026-08-08

## Context

Three defects reported together against the running IDE:

1. The terminal should toggle with `mod+j`, not `` mod+` ``.
2. Focusing certain inputs kills every application hotkey.
3. Resizing a sidebar, closing it, and reopening it loses the width.

They are unrelated in cause but share a surface: the application shell's
keyboard and layout behaviour. Each is fixed independently below.

---

## 1. Terminal toggle moves to `mod+j`

### Root cause

Two commands own overlapping behaviour on different chords:

| command | chord | behaviour |
| --- | --- | --- |
| `terminal.toggle` (`App.tsx:469`) | `` mod+` `` | toggles the bottom panel **and spawns a terminal when none exists** |
| `view.toggleBottomPanel` (`App.tsx:691`) | `mod+j` | flips panel visibility only |

Pressing `mod+j` before any terminal has been created therefore opens an empty
panel. The keystroke is handled; it just does not produce a terminal.

This is a known, already-documented confusion. `signpost.ts:14` carries the
comment:

> Keys are resolved from the live command registry rather than written here.
> That is load-bearing: the tester who prompted this work was told "Ctrl+J
> opens the terminal", but `mod+j` is `view.toggleBottomPanel` — the terminal
> merely lives in that panel.

That workaround made the onboarding signpost *display* the correct chord. This
change fixes the binding itself.

### Design

- `App.tsx:472` — `terminal.toggle` keybinding `` 'mod+`' `` → `'mod+j'`.
- `App.tsx:694` — `view.toggleBottomPanel` drops its `keybinding` field. The
  command stays registered and reachable from the command palette, so exactly
  one command owns the chord.
- `` mod+` `` becomes unbound. `terminal.new` keeps `` mod+shift+` ``, and
  `view.toggleMaximizedPanel` keeps `mod+shift+j`.
- `ActivityBar.tsx:93` hardcodes the tooltip ``title="Terminal (Cmd+`)"``.
  Derive it from the registered command's keybinding through the existing
  `formatKeybinding` util (`src/utils/format-keybinding.ts`) so the label
  cannot drift from the binding again.

### Ripples — verified, no change required

- **Monaco bridge** (`bind-shortcuts.ts:36`) reads `cmd.keybinding` from the
  live registry and parses it per command. `mod+j` parses through
  `parseHotkeyToMonaco`.
- **Onboarding signpost** (`signpost.ts:31`) resolves chords from the registry
  by command id. Its test uses fixture bindings, not the real registry, so it
  does not couple to the chord.

### Behaviour note: `Ctrl+J` inside a focused terminal

`terminal.toggle` is already listed in `COMMANDS_TO_SKIP_SHELL`
(`skip-shell.ts:21`). On Linux/Windows, `Ctrl+J` will therefore now toggle the
panel from inside a focused terminal rather than sending LF (`0x0A`) to the
shell — the exact case `isBareCtrlLetterChord` was written to arbitrate.

This is deliberate and is the reason the skip-shell list exists: you must be
able to close the panel from inside the pane that fills it, or the binding is
useless. It also matches VS Code. On macOS the question does not arise — xterm
never forwards Cmd chords to the PTY.

---

## 2. Hotkeys stop working in inputs

Two independent causes, both confirmed by reading the relevant source.

### Root cause a: contenteditable targets are skipped

`KeyboardShortcutManager.tsx:37` passes `{ enableOnFormTags: true }`. That
covers `<input>`, `<textarea>` and `<select>`, but react-hotkeys-hook v5 has a
*separate* gate for contenteditable elements
(`react-hotkeys-hook/dist/index.js:194`):

```js
s.target?.isContentEditable && !t?.enableOnContentEditable || H(y, t?.delimiter).forEach(...)
```

With `enableOnContentEditable` unset, the handler is skipped entirely. The AI
chat box is a Lexical `ContentEditable`
(`LexicalChatInput.tsx:111`), so **every** application shortcut is dead while
typing there.

### Root cause b: the explorer rename box swallows every keystroke

`InlineInput.tsx:86` calls `e.stopPropagation()` on every keydown,
unconditionally. React attaches its listeners to `#root`
(`main.tsx:76`), which sits below `document` — where react-hotkeys-hook's
listener lives. Stopping propagation in a React `onKeyDown` therefore prevents
the native event from ever reaching the hotkey listener. Renaming a file in the
explorer kills every shortcut.

The call is not gratuitous: the input renders inside a `react-arborist` `Tree`
(`ExplorerPanel.tsx:2`), whose keyboard navigation (arrows, type-ahead, Enter,
Escape) would otherwise hijack typing in the rename box.

### Design

**a.** Add `enableOnContentEditable: true` to the `useHotkeys` options in
`KeyboardShortcutManager.tsx:37`. The existing `.find-widget` and
`.terminal-xterm` carve-outs sit inside the handler body and are unaffected.

This makes the AI box consistent with every other input rather than specially
privileged — app chords already fire while typing in a regular `<input>` today
because of `enableOnFormTags: true`. A chord like `mod+k` closing the panel you
are typing in is pre-existing behaviour for other fields, now uniform.

**b.** Narrow `InlineInput`'s propagation stop rather than removing it: stop
propagation only for keystrokes carrying **no** `ctrlKey`, `metaKey` or
`altKey`. Unmodified keys — the tree's entire keyboard vocabulary — stay
isolated; modifier chords bubble to `document` and reach the hotkey listener.

**Accepted tradeoff, to be recorded in a code comment:** `Cmd+A`/`Ctrl+A` while
renaming will now also reach react-arborist's select-all, which highlights tree
rows. It does not touch the rename in progress or the text selection in the
field. That cost is smaller than leaving every shortcut dead during a rename.

### Scope check

`InlineInput.tsx:86` is the only *blanket* keydown propagation stop in the
codebase. The other keydown-adjacent `stopPropagation` calls are key-specific
and intentional: `SettingsModal.tsx:53` (Escape only, so Escape closes the
modal and nothing behind it) and `MentionPopover.tsx:384` (Enter only, so Enter
picks a mention). Both stay as they are. `LexicalChatInput` registers no
keydown interception of its own.

---

## 3. Sidebar width is lost across a toggle

### Investigation

The reported failure is **within a single session**: resize, close, reopen,
wrong width — no restart involved.

Reading Allotment 1.20.5's bundle, this should already work. `ViewItem.setVisible`
caches the live size on hide and restores it clamped on show:

```js
setVisible(e, t) {
  e !== this.visible && (e
    ? (this.size = x(this._cachedVisibleSize, this.viewMinimumSize, this.viewMaximumSize),
       this._cachedVisibleSize = void 0)
    : (this._cachedVisibleSize = "number" == typeof t ? t : this.size, this.size = 0), ...);
}
```

`setViewVisible` → `distributeEmptySpace` → `layoutViews` then rebalances the
delta into the High-priority editor pane, which is what the panes are already
configured for (`App.tsx:1183`). The React reconcile effect only calls
`resizeView(preferredSize)` for *newly added* panes, and all three panes are
permanently mounted and toggled via `visible` (`App.tsx:1177`), so
`preferredSize` is not reapplied on a toggle.

The exact internal failure was **not** identified. Rather than continue
reverse-engineering minified third-party code, the fix stops depending on an
implicit library cache and makes the restore explicit and owned.

This is also a limit worth stating plainly: the design below is chosen because
it is deterministic regardless of Allotment's internals, not because a specific
line in Allotment was proven wrong.

### Design

Take ownership of the width:

1. Track each side pane's last known **visible** width in a ref, updated from
   the existing `onChange` handler (`App.tsx:1154`), which already receives the
   full `[sidebar, editor, rightPanel]` size array and already guards against
   recording a hidden pane's `0`.
2. Attach a `useRef<AllotmentHandle>` to the outer `Allotment`. The handle
   exposes `resize(sizes: number[])`
   (`allotment/dist/types/src/allotment.d.ts`).
3. In a `useLayoutEffect` keyed on `[sidebarVisible, rightSidebarVisible]`,
   detect a hidden→visible transition and call `resize()` with the remembered
   width.

Effect ordering is load-bearing and correct by construction: React runs child
layout effects before parent layout effects, so Allotment's reconcile (which
flips the pane visible) has already run when App's effect fires. Using
`useLayoutEffect` rather than `useEffect` means no frame paints at the wrong
width.

### Testing

The size-resolution policy — the persisted-value validation and the
restore-width computation — moves into a pure module
`src/features/app-shell/layout-sizes.ts`, unit-tested with `bun test`.

This follows the precedent `skip-shell.ts:52` sets for exactly this situation:

> Pure so the policy can be tested without a DOM or a second platform.

The project has **no component-test infrastructure** — `package.json:18` runs
`bun test src`, and every existing test is a pure-logic `.test.ts`. No jsdom,
React Testing Library, or `ResizeObserver` harness is introduced for this
change. The imperative wiring in `App.tsx` is verified by running the app.

### Included alongside

Both sit directly in the code path being changed and serve the same
"remember my layout" goal. Approved by the user when the design was presented.

- **Restore cap.** `App.tsx:134` discards any persisted side-pane width above
  45% of the window width and silently falls back to 30%. A deliberately wide
  sidebar is therefore lost on restart. Raise the cap to 80% of window width —
  still rejects implausible leftovers from a bad layout, honours a real choice.
  This is a *restart-path* fix; it is not the cause of the reported
  within-session bug.
- **Persist debounce.** `onChange` fires per mousemove frame during a drag, and
  each call reaches `saveLayoutSizes` → `writeWindowState` → an `await
  win.save()` against the Tauri store (`persistence.ts:316`). That is a disk
  write per frame. Debounce the persist; keep the in-memory ref update
  immediate so a toggle occurring mid-drag still restores the current width.

---

## Out of scope

- Broadening or removing the `.find-widget` carve-out
  (`KeyboardShortcutManager.tsx:21`). It is deliberate and documented: it lets
  Monaco's find/replace keymap win wholesale while that widget is open.
- Supporting multiple keybindings per command. Considered for keeping
  `` mod+` `` as a secondary terminal chord and rejected — it would require
  changing `keybinding: string` to `string | string[]` across the commands
  store, the Monaco bridge, the signpost and the palette's key rendering, for
  an alias the user did not ask to keep.
- Any change to `terminal.new`, `terminal.split`, or the pane-focus bindings.

## Verification

- `bun test src` passes, including new `layout-sizes` tests.
- `bunx tsc --noEmit` clean.
- In the running app:
  - `mod+j` opens the panel *and* spawns a terminal on a cold workspace;
    `mod+j` again closes it, including from inside a focused terminal.
  - `` mod+` `` does nothing.
  - The Terminal button's tooltip reads the live chord.
  - With focus in the AI chat box: `mod+b`, `mod+p`, `mod+shift+p` all fire.
  - While renaming a file in the explorer: `mod+b` fires; arrow keys and
    type-ahead still edit the field rather than moving the tree selection;
    Enter commits and Escape cancels.
  - Drag the left sidebar wide, `mod+b` twice — it returns at the dragged
    width. Same for the right sidebar with `mod+k`. Survives a restart.
