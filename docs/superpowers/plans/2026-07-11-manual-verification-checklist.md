# Manual Verification Checklist — Tasks-Tracker Run (2026-07-11)

All 24 build tasks landed (commits `d750c8f..a2eaaf9` on `heads/v0.2.0`); automated gates green (cargo 202, bun 495, tsc, zero-warning build, module boundaries). The final whole-branch review rated the branch **ready to merge with this checklist as the final gate** — these are the runtime behaviors no automated test can cross (GUI, IPC boundary, visual timing).

Run `bun run tauri dev` against a real workspace (ideally a Unity project) and walk through:

## Priority items (named by the final review)
- [ ] **One real content search** (3+ chars) — results stream in; no error banner. (Exercises the fixed invoke serde path live.)
- [ ] **Rename a folder in Finder, then quick-open (Cmd+P)** — old paths gone, new paths present after the rename. (Exercises `mark_stale` live.)
- [ ] **Click a match on a very long (>500 char) line in the search panel** — cursor lands on the match column. (B4 `lineStart` composition.)
- [ ] **Dev build only: run `debug_panic_async` then `debug_panic_sync` from devtools** (`__TAURI__.core.invoke('debug_panic_async')`) — async panic must NOT kill the app; sync panic behavior recorded (expected: process abort — this is the documented residual risk). 

## Hotkeys (C1)
- [ ] Focus the editor, press Cmd+` → terminal toggles; Cmd+, → settings; Cmd+Shift+` works.
- [ ] Cmd+K with editor focused → right sidebar toggles. If Monaco's chord swallows it, apply the plan's step-2 override (`addKeybindingRules` nulling Cmd+K) — deliberately deferred pending this test.

## Focus & navigation (C2, C3, C4)
- [ ] Open files via explorer click / Cmd+P / tab click → typing goes straight to the editor each time.
- [ ] Search-result click still lands on the match line.
- [ ] In a .ts file: import paths underline on Cmd+hover; Cmd+click and right-click → Go to Definition both open the target; `./foo` resolves to `foo/index.ts`; `../missing` no-ops. Click ON the quote characters (known half-column edge — verify acceptable).
- [ ] Open a deeply nested file via Cmd+P → explorer expands, scrolls, selects it. Toggle `explorer.autoReveal` off in settings → auto-reveal stops; Cmd+Shift+R still reveals manually (also with the sidebar hidden).

## Explorer & tabs (C5, B1)
- [ ] Explorer context menu: Copy Path / Copy Relative Path paste correctly; Reveal in Finder opens Finder with the item selected (file + folder).
- [ ] Tab context menu: same three items; a diff tab reveals/copies the underlying file; menu closes after click.
- [ ] `.env`, `.env.local`, `.gitignore` visible in the tree and quick-open; `.git`/`.DS_Store` never appear.

## Reload behavior (C6)
- [ ] Open a working-tree diff tab + 2 terminals → Cmd+R → diff tab restored with fresh content; `ps aux | grep -c <shell>` stable across repeated reloads (no orphan PTYs).
- [ ] Rename/move the project folder, relaunch → single actionable "moved or deleted" toast.

## Git workstream (A1–A8)
- [ ] `git branch x` in the integrated terminal → x appears in the branch picker AND status bar refreshes without reopening. Repeat inside a linked worktree (`git worktree add`) — switch branches there; status bar follows.
- [ ] Branch picker: open twice — second open shows the list instantly (no "No matching branches" flash); rows don't reshuffle; type a new name → "＋ Create branch" row → creates + switches.
- [ ] Commits section expanded by default; click a commit → file list; click a file → side-by-side diff of that commit.
- [ ] Edit a committed file → gutter shows modified/added/deleted markers; save → markers update; commit → markers clear.
- [ ] Modify 2 files → activity-bar SCM badge shows 2; commit → clears.
- [ ] Push a new local branch → auto set-upstream success toast. Push to an auth-required remote with no credentials → immediate actionable error, no hang.
- [ ] Stash with dirty tree → tree clean + stash listed; pop → restored. Amend checkbox → prefills last message, button reads "Amend Last Commit", log shows rewritten message.

## Search workstream (B2–B6, B8)
- [ ] Large workspace search: results stream progressively; UI stays interactive mid-search (open a file while searching); new query cancels the old (no interleaved stale rows).
- [ ] Regex / case / whole-word toggles work; `src/**, *.ts` include + `*.test.ts` exclude filter correctly; gitignored dirs (node_modules, Library) absent; huge query shows the truncation notice; 10k-row scroll smooth.
- [ ] Quick-open: first search fast, subsequent keystrokes instant (warm index); no layout jump from the loading bar; background file saves don't flicker the list; create/delete a file externally → appears/disappears after the watcher debounce; edit `.gitignore` → next search reflects it.

## Crash hardening (C8, item 14)
- [ ] Kill a terminal's shell process externally (`kill -9 <pid>`), then spam terminal actions — no lock-up, other windows unaffected.
- [ ] Open two project windows; reload one repeatedly — the other stays healthy. (Full crash isolation = future work: process-per-window, noted in lib.rs.)

## Agent (C7)
- [ ] AI panel shows only Arcane (+ "coming soon" placeholder); restoring an old session that used the removed agent opens read-only and runs as Arcane without errors.
