# Manual Verification Checklist — feat/git-multiwindow-fixes

Branch: `feat/git-multiwindow-fixes` (c775415..HEAD). Automated gates green (cargo 238, bun 500, tsc, check:modules). These items need a human with the running app: `bun run tauri dev`, ideally with two Unity test projects A and B.

## 1. Git staleness — the core reported bug
- [ ] In A's integrated terminal: `touch x.txt && git add x.txt` → SCM changes list + activity-bar badge update within ~1s (no window refocus needed).
- [ ] Edit a tracked file with an EXTERNAL editor (TextEdit/vim), save → file appears under Changes; editor gutter markers update.
- [ ] `git checkout -b test-branch` in the terminal → status-bar branch label updates within ~1s.
- [ ] Leave the SCM panel open and idle 2 minutes → no runaway refresh loop (devtools console: no repeated git-state-changed storms).
- [ ] While Unity is compiling (Library churn), the app stays responsive (watcher fires but status refreshes are coalesced).

## 2. Diffs
- [ ] Stage a file, then edit it again → the STAGED entry's diff shows HEAD vs index (without the new edit); the UNSTAGED entry shows index vs worktree (only the new edit).
- [ ] Click a changed file to open its diff, edit the file again, re-click it in the SCM list → diff shows fresh content (no stale tab).

## 3. Branch creation + badge
- [ ] Status bar branch label → picker opens; FIRST row is "＋ Create new branch…"; selecting it enters create mode; type a name, Enter → branch created AND checked out.
- [ ] Command palette "Git: Create Branch" opens the picker directly in create mode.
- [ ] Typing "feature x" in the branch input does NOT auto-capitalize.
- [ ] Changed-file count badge visible on the source-control activity bar icon; clears after commit.

## 4. Multi-window
- [ ] Launch app → welcome/manager window. Open project A → NEW window; welcome window STAYS OPEN. Open B from welcome → third window.
- [ ] From inside A: Cmd+O picks a folder → opens in a NEW window (A untouched).
- [ ] Re-open A from B's recents or the welcome window → focuses A's existing window (no duplicate).
- [ ] Quick-open (Cmd+P) in A and B shows only that project's files; project-wide search run simultaneously in both completes independently.
- [ ] Terminals in A and B don't cross-echo; C# LSP hover works independently in both.
- [ ] With A focused, Cmd+S saves only in A (check B's dirty tab stays dirty).
- [ ] Close A → B keeps working (watcher/search/LSP alive). Reopen A → geometry + tabs restored.
- [ ] Welcome window focused: Cmd+O opens the folder dialog (menu actions reach the welcome window).
- [ ] Open a recent whose folder was deleted → visible error (toast in editor windows; inline message in welcome window); entry removed from recents only in that case.

## 5. Dock (macOS)
- [ ] Right-click dock icon → "New Window" item shows; clicking opens/focuses the welcome window.
- [ ] Close all windows, click dock icon → welcome window reopens (existing behavior intact).

## 6. Input auto-capitalization sweep
- [ ] Type lowercase text in: project search, search include/exclude globs, commit message box, settings search, theme picker, Unity console filter, new C# script dialog, worktree dialog → nothing auto-capitalizes or autocorrects.

## Known deferred minors (adjudicated, non-blocking)
Recorded in `.superpowers/sdd/progress.md` (RUN 2026-07-11b section): event-path gitignore-gating not applied (plan decision), show_rev Ok-empty pattern, locale-dependent stderr matching (pre-existing), isBranchesLoading double-toggle between coalesced runs, WelcomeApp pickFolder copy on spawn failure.
