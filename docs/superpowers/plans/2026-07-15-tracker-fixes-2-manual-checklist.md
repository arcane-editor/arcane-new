# Manual verification checklist — tracker-fixes-2 (merge gate)

Branch: `tracker-fixes-2` (506cacc..HEAD). Automated gates at HEAD: bun 831/831, cargo 266/266, tsc clean, check:modules OK, vite build OK.

Run `bun run tauri dev` in `editor/`.

## A. Search panel (WS1 — screenshot bug 1)

- [ ] Search a term with many matches in a giant ONE-LINE file (e.g. a SQL dump) → results start at the TOP of the panel, list scrolls normally, no giant empty gap, truncation notice visible above the list.
- [ ] Normal multi-file search still renders/navigates correctly (click result → opens at line/column).

## B. Editor find widget (WS2 — screenshot bug 2)

- [ ] Cmd+F opens find; type a query; press **Escape** → widget closes. (If it STILL doesn't close: the keybinding interference is gone, so capture what has focus and report — next hypothesis is the editor auto-focus path.)
- [ ] With find open: **Cmd+G** advances to next match (Monaco's find-next, no longer shadowed); Cmd+Shift+G goes to previous.
- [ ] While typing IN the find input: app shortcuts (Cmd+P, Cmd+Shift+F) do NOT fire.

## C. AI panel (WS3 + WS4)

- [ ] Long chat (~50+ messages): typing in the composer feels smooth while a response streams; React DevTools "highlight updates" flashes only the streaming message area, not the whole timeline.
- [ ] Scroll UP mid-stream → list does NOT yank down; "jump to bottom" affordance appears; clicking it re-pins.
- [ ] Stop, Retry, ask_user chips, Accept/Reject review bar, PlanList, checkpoint Restore all still work (regression sweep of the recent AI features through the restructured list).
- [ ] Stage-2 go/no-go measurement (plan WS4): seed a ~250-message session, measure keypress→paint (Performance panel) idle and mid-stream. If p95 > ~50ms idle / ~80ms streaming → schedule the virtualization task.

## D. Bottom panel (WS5 + WS6 + WS7)

- [ ] **Cmd+Shift+J** maximizes the whole panel (tab strip visible; Problems clickable while maximized); status bar stays VISIBLE at the bottom; Escape (from a non-terminal tab) restores; Escape while a TUI/vim runs in a terminal does NOT restore; restore returns to the prior height.
- [ ] Fill a terminal with output → **Cmd+\\** splits → LEFT pane keeps its scrollback (no remount); right pane's `pwd` = left's spawn cwd; drag the sash → both refit cleanly.
- [ ] **Cmd+Shift+]** / **Cmd+Shift+[** cycle pane focus with a visible ring WHILE FOCUSED IN A TERMINAL (this was the dead-keybinding fix — verify from terminal focus specifically).
- [ ] Split → switch to Problems and back; switch to another terminal tab and back → panes re-lay-out correctly, NOT collapsed to zero width (Allotment display:none reveal risk — if broken, the documented fallback is visibility:hidden).
- [ ] Kill right pane (Trash) → left fills width; kill last pane → tab disappears; tab ✕ kills the whole group.
- [ ] Unity project: tabs = Terminal, Unity Console, Problems, Output; default view = Unity Console; opening the panel does NOT spawn a PTY until you first click Terminal; terminal `pwd` = project root; Terminal ↔ Unity Console switching preserves scrollback.

## E. Branch picker (WS8)

- [ ] Cmd+Shift+B: current branch first, then most-recently-checked-out order (matches your real reflog).
- [ ] Switch to a branch → reopen picker → it moved to the top (instant optimistic reorder).
- [ ] Fresh repo with no reflog: picker still works (alphabetical).
- [ ] Add-worktree dialog branch dropdowns still populate correctly.

## F. AI empty-response (WS3) — optional live check

- [ ] If you can force an empty model response: an "Empty response" error card with Retry appears instead of a silent empty bubble; a stream that never sends a first token errors at ~25s (not 90s).
