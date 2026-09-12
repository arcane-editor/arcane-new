**UnityIDE editor reliability review — 10 September 2026**

Reviewed the working tree based on commit `e82fa55`, including the existing uncommitted AI-panel and Unity-bridge work. Application code was not changed. This is a review of editor workflows and their native backends, not a complete audit of the server, payments, website, or every Unity integration feature.

There are **12 actionable findings: three P1 issues involving file integrity and nine P2 issues involving chat, file lifecycle, Windows process cleanup, and responsiveness**. Nine findings were reproduced with the actual store/component implementations and controlled dependencies. Three are supported by the native code paths and still need failure-injection or Windows runtime tests. “Reproduced” below does not mean a complete packaged Windows application was exercised.

Implementation follow-up: the repairs and final validation are recorded in [fixes.md](./fixes.md). The findings and reproduction results below describe the original reviewed state.

**The AI panel crash you described**

Your recollection closely matches `Cannot read properties of undefined (reading 'problems')` in the verification card. Old saved cards predate `uiToolkit`, `input`, and other fields. The original renderer could fall through its string-variant checks and access `.problems` on an absent field.

The current working tree already repairs this case in [backfillVerifiedCards](/Users/inno/Documents/experiments/arcane-editor/editor/src/features/ai-panel/services/session-persistence.ts:374) and supplies defaults in [VerifiedCard](/Users/inno/Documents/experiments/arcane-editor/editor/src/features/ai-panel/components/VerifiedCard.tsx:62). I rendered a legacy card through the current parser and real React component: it succeeded. I therefore do **not** count that historical missing-field bug as an outstanding finding. Without the original stack trace, the match remains a strong inference rather than a verified diagnosis of your particular incident.

Two related weaknesses remain. Finding 5 proves the advertised “close and reopen” recovery does not work. Separately, an intentionally malformed saved card containing `uiToolkit: null` survives parsing and still throws on `.problems`. I reproduced that boundary weakness, but found no normal current producer of that null value; it is a hardening requirement, not evidence that normal cards are still broken. Persisted data needs runtime validation and migration, and one invalid message should not take down the composer and entire transcript.

**Findings, in repair priority order**

**1. [P1] A delayed formatter overwrites newer typing. Reproduced.**

Location: [format-on-save.ts:63](/Users/inno/Documents/experiments/arcane-editor/editor/src/features/lsp/services/format-on-save.ts:63).

Trigger: enable format on save, save a C# file, then keep typing while Roslyn is answering. The helper checks whether the model was disposed, but never checks whether its content/version changed during the request. It applies the old ranges to the new text; `saveFile` then writes that result. My deferred-response probe changed `int x` to `int y` while formatting was pending; the returned formatting edit replaced it with `int x` again.

Repair: capture the model identity and version before requesting formatting. Discard a stale response and save the current buffer, or request fresh formatting. Do not restore a stale snapshot over the user’s newer edits. Regression test: delay the actual formatting boundary, type while it waits, and assert both the model and saved bytes retain the newer change.

**2. [P1] Saving silently overwrites a newer external file version. Reproduced.**

Location: [workspace.ts:1525](/Users/inno/Documents/experiments/arcane-editor/editor/src/stores/workspace.ts:1525); related [open-file-reload.ts:11](/Users/inno/Documents/experiments/arcane-editor/editor/src/utils/open-file-reload.ts:11).

Trigger: edit a file in UnityIDE, then let Unity, another editor, Git, or an AI tool change the same file on disk, then save. The watcher correctly avoids overwriting a dirty buffer, but no conflict flag or saved disk revision is carried into `saveFile`. The save blindly writes the buffer and marks it clean. The probe replaced the disk version with an external edit before saving; the external edit disappeared without a comparison.

Repair: keep the disk revision/content baseline associated with each buffer and detect external changes before committing a save. Offer comparison/merge or an explicit overwrite for a conflict. An external change must not disappear merely because auto-save or Ctrl+S ran. Test external edits against dirty buffers, including a late external write during a pending save.

**3. [P1] Normal saves and chat-history writes can truncate the original on failure. Native code finding; failure injection still needed.**

Location: [lib.rs:274](/Users/inno/Documents/experiments/arcane-editor/editor/src-tauri/src/lib.rs:274).

`write_file` uses `fs::write`, which truncates an existing file before completing the replacement. A full disk, interrupted write, or process termination can leave a partial file and destroy the previous valid version. The same command persists session JSON, so a torn save can also make a conversation unreadable. Returning an error does not restore the old bytes.

The repository already has a separate [atomic writer](/Users/inno/Documents/experiments/arcane-editor/editor/src-tauri/src/fs_atomic.rs:1), but ordinary editor/session writes bypass it. Repair the shared save path with atomic replacement, serialized writes per destination, and appropriate Windows sharing-violation handling. Validate permissions, symlinks, CRLF/BOM preservation, locked targets, and injected write/replace failures. I did not deliberately fill the disk or terminate the live application to test this.

**4. [P2] A disposed AI turn appends results into a new conversation. Reproduced.**

Locations: [agent-service.ts:1140](/Users/inno/Documents/experiments/arcane-editor/editor/src/features/ai-panel/services/agent-service.ts:1140), [dispose:1403](/Users/inno/Documents/experiments/arcane-editor/editor/src/features/ai-panel/services/agent-service.ts:1403).

Trigger: click New Chat while an ordinary hosted-agent turn is waiting for its closing verification. Disposal aborts the vendor agent and removes subscriptions, but the surrounding async service method remains alive. After `runVerifiedPass` resolves, it obtains the *current* AI store and appends the old card without validating session ownership. The probe disposed an old service, switched to `new-session`, then completed verification; the old file’s card appeared in `new-session`.

Repair: give each conversation/send a generation token and reject stale continuations before store writes, repair calls, and final cleanup. Propagate cancellation through closing checks; disposal must invalidate the whole send. Merely checking at method entry is insufficient. Test New Chat and session/workspace replacement at every awaited phase. This probe demonstrated transcript contamination, not cross-project file mutation.

**5. [P2] “Close and reopen the AI panel” does not recover a crashed panel. Reproduced in a browser.**

Locations: [RightSidebarPanel.tsx:23](/Users/inno/Documents/experiments/arcane-editor/editor/src/features/app-shell/components/RightSidebarPanel.tsx:23), [App.tsx:2269](/Users/inno/Documents/experiments/arcane-editor/editor/src/App.tsx:2269), [ErrorBoundary.tsx:61](/Users/inno/Documents/experiments/arcane-editor/editor/src/components/ErrorBoundary.tsx:61).

Allotment hides the sidebar using `visible`, retaining its children and error boundary. Reopening therefore retains `hasError: true`. The compact fallback provides Copy details, but no retry/reset action. In the browser fixture, I caused a transient render error, removed its cause, hid and reopened the panel: the fallback remained and no composer returned.

Repair: add a real boundary-reset/retry action and ensure the advertised reopen action triggers it. Isolate message-level rendering failures so the user can still start a new chat or remove an unreadable history item. Test recovery after a transient failure using the actual mounted pane; testing a fresh boundary alone misses this bug.

**6. [P2] Enter during a running response consumes a follow-up that is never sent. Reproduced.**

Locations: [ChatInput.tsx:98](/Users/inno/Documents/experiments/arcane-editor/editor/src/features/ai-panel/components/ChatInput.tsx:98), [LexicalChatInput.tsx:142](/Users/inno/Documents/experiments/arcane-editor/editor/src/features/ai-panel/components/LexicalChatInput.tsx:142).

The Send button respects `isAgentRunning`, but the Enter plugin is enabled whenever a workspace and text exist. `handleSubmit` has no equivalent busy guard. Dispatch adds a user message and clears attachments before the hosted service refuses the busy send; the Lexical submit path also clears the draft. The probe invoked the real composer callback while the service was busy: it recorded the user bubble, cleared attachments, and returned “Agent is already processing a message.”

Repair: use a single submission guard for keyboard and button actions, allowing pending-question answers explicitly. Clear drafts/attachments only after acceptance. If queued follow-ups are desired, represent and deliver them as a real queue. Test Enter during streaming, permission waits, verification, and connection setup.

**7. [P2] Maximizing/restoring the AI panel discards an unfinished prompt. Reproduced in a browser.**

Locations: [RightSidebarPanel.tsx:15](/Users/inno/Documents/experiments/arcane-editor/editor/src/features/app-shell/components/RightSidebarPanel.tsx:15), [App.tsx:2322](/Users/inno/Documents/experiments/arcane-editor/editor/src/App.tsx:2322).

Maximize unmounts the docked panel and creates another instance in a portal. Lexical owns its draft inside that unmounted subtree; there is no shared draft state. The browser fixture used the actual Lexical composer and these wrappers: `"unfinished Unity prompt"` became `""` immediately on maximize. Local question drafts and other component state have the same lifetime problem.

Repair: keep the composer instance alive across presentation changes, or persist/restore its editor state by conversation. Preserve the selection and mention nodes, not only plain text. Test maximize, restore, and switching to/from the Unity Inspector with a draft and staged attachments.

**8. [P2] Overlapping opens create duplicate tabs and leak an LSP open reference. Reproduced.**

Location: [workspace.ts:1305](/Users/inno/Documents/experiments/arcane-editor/editor/src/stores/workspace.ts:1305).

Two opens for the same file both pass the initial existence check before either read finishes. Both then append unconditionally. The probe produced two entries for one path; closing that path removed both tabs but decremented the LSP reference count only once, leaving one document tracked. Rapid explorer clicks or simultaneous navigation/open requests can reach this path, especially with slow storage.

Repair: deduplicate pending opens by canonical path, and recheck the store after the read. Separate “load a file” from “make this file active” so an older slow read cannot steal focus from a newer navigation request. Test overlapping same-file opens and reversed completion order.

**9. [P2] Renaming an open file does not transfer its editor/LSP lifecycle. Reproduced.**

Location: [workspace.ts:1848](/Users/inno/Documents/experiments/arcane-editor/editor/src/stores/workspace.ts:1848).

The action renames the disk file and changes tab paths, but does not close the old LSP document, open the new one, or dispose/migrate the old Monaco model. The probe opened `Player.cs`, renamed it, then edited the new path: the old URI remained tracked and the new `didChange` was dropped by the untracked-document guard.

For Unity C# files under Assets, the separate debounced project-regeneration/LSP restart can eventually mask the problem. Other languages and paths do not have that recovery, and it does not dispose the orphaned model. Repair the rename lifecycle directly for files and every open descendant of a renamed directory. Preserve dirty content and deliberate view state, transfer diagnostics/navigation identity, and test without relying on a later server restart.

**10. [P2] Deleting files bypasses normal tab cleanup. Reproduced.**

Location: [workspace.ts:1877](/Users/inno/Documents/experiments/arcane-editor/editor/src/stores/workspace.ts:1877).

Deletion filters entries from `openFiles` instead of using the cleanup performed by `closeFile`. The probe confirmed no model-disposal call, no `didClose`, and an outstanding tracked document after deletion. Background Monaco models can remain in memory and diagnostics remain until separately invalidated. A later workspace edit also has a path that writes orphaned models back to disk, so retaining deleted-path models is more than a cosmetic leak.

Repair: share a cleanup primitive for close/delete/workspace replacement, with appropriate differences for reopen history and dirty-file confirmation. Exercise deletion of a background tab and a directory containing several open tabs; verify models, diagnostics, LSP tracking, and search ownership afterward.

**11. [P2] Windows command timeouts do not terminate the spawned process tree. Native Windows code finding; not run on Windows.**

Location: [lib.rs:723](/Users/inno/Documents/experiments/arcane-editor/editor/src-tauri/src/lib.rs:723).

The hosted command tool runs `cmd /C` on Windows. `kill_on_drop(true)` targets that shell process. Descendant cleanup is implemented only under `#[cfg(unix)]` using a process group. A timed-out build or child process can therefore keep consuming CPU, holding files open, or writing files after the UI reports timeout. Repeated attempts can accumulate surviving children.

Repair: use Windows process-tree lifetime management, such as a job object with kill-on-close, across timeout and cancellation. Test a child that spawns a grandchild and writes heartbeat files; after timeout, assert all PIDs exit and heartbeat writes stop. A mocked timeout result or Unix-only test cannot establish this behavior.

**12. [P2] Opening a large asset performs an unbounded synchronous native read. Native code finding; resource benchmark still needed.**

Location: [lib.rs:225](/Users/inno/Documents/experiments/arcane-editor/editor/src-tauri/src/lib.rs:225); related synchronous [directory listing](/Users/inno/Documents/experiments/arcane-editor/editor/src-tauri/src/lib.rs:129) and [recursive deletion](/Users/inno/Documents/experiments/arcane-editor/editor/src-tauri/src/lib.rs:450).

`read_file_checked` reads the entire file before deciding whether it is binary, with no metadata size gate. Merely clicking a very large texture, video, terrain asset, or generated text file allocates its complete contents in the native process. Large text then crosses IPC and reaches the frontend before Monaco’s large-file options can help. These commands use the synchronous Tauri dispatch path; directory listing also waits on a Git subprocess. Slow disks, network shares, and scanning/locking software make the responsiveness risk more significant.

Repair: perform blocking filesystem work off the synchronous invoke handler, inspect size and a bounded prefix first, and provide a deliberate large-file/binary path. Bound concurrency as well as per-file allocation. Benchmark realistic asset sizes and slow/locked paths on Windows; no particular latency or memory number is claimed by this review.

**Verification results and their limits**

| Check | Result |
| --- | --- |
| TypeScript, module boundaries, invoke arguments, version/updater configuration | Passed |
| Existing `bun test src` | 4,636 passed |
| Existing script tests | 123 passed |
| Existing isolated JS tests | 30 passed |
| Rust library suite, outside the sandbox | 922 reported passed |
| Full `bun run verify` | **Failed** at IntelliSense initialization |
| IntelliSense diagnostic rerun with resolved `DOTNET_ROOT` | **Failed:** `Camera.` returned zero items, missing `main` |
| Real ACP handshake/configuration probe | Passed, adapter 0.70.0; boolean config option confirmed |
| Live Unity debugger probe | **SKIPPED:** Unity runtime not found; not verified |
| Additional review probes | Nine tests of current behavior passed, including the legacy-card fix and malformed-card boundary experiment |
| Browser fixture | Draft loss and failure to recover after reopening both reproduced |

The first sandboxed Rust run had permission failures for localhost listeners and generated Unity project files. A permitted run outside the sandbox resolved those failures; they are not counted as application bugs. Rust’s aggregate success does not override the explicitly skipped live debugger check.

The default IntelliSense probe derived `/opt/homebrew/bin` as `DOTNET_ROOT` from a symlinked executable, rather than `/usr/local/share/dotnet`; see [resolveDotnetRoot](/Users/inno/Documents/experiments/arcane-editor/editor/scripts/verify-csharp-intellisense-lib.ts:264). Supplying the resolved directory allowed initialization, but did not make semantic completion pass. The selected user tool reported **0.22.0.0**, while this build pins **0.27.0**. Both [probe discovery](/Users/inno/Documents/experiments/arcane-editor/editor/scripts/verify-csharp-intellisense-lib.ts:245) and [application discovery](/Users/inno/Documents/experiments/arcane-editor/editor/src-tauri/src/csharp_ls.rs:190) can select an existing global tool; the application intentionally prefers it. Test both the shipped pinned server and a user override, and validate override compatibility explicitly. I did not replace your installed tool or establish the precise cause of the remaining completion failure.

Existing CI does have Windows/macOS unit-test jobs. However, [ci.yml](/Users/inno/Documents/experiments/arcane-editor/.github/workflows/ci.yml:1) does not exercise the real IntelliSense, ACP, or debugger workflows, and there is no mounted React/WebView interaction suite in that job. Many current tests assert source text or isolated decisions. They are useful guards, but do not prove async ownership, mount lifetime, or real OS behavior. The reproduced findings explain how thousands of passing tests can coexist with user-visible breakage.

**Repair and prevention sequence**

1. Protect saved work first: reject stale formatter edits, detect external conflicts, and make file replacement failure-safe.
2. Repair the AI conversation lifetime: invalidate disposed continuations, share the send guard, preserve drafts, and provide working local recovery.
3. Centralize file lifecycle cleanup for open/rename/delete. Verify buffer, Monaco model, LSP document, diagnostics, and navigation together.
4. Add executable tests around these real boundaries. Convert the review reproductions into assertions of the desired behavior after fixes; keep source-pattern checks as supplementary checks.
5. Add a release gate on an actual Windows installation with Unity and the shipped sidecars. Require real semantic completion, debugger, terminal process cleanup, and an ACP session. Do not count an unavailable dependency as a pass.

The Windows release matrix should include drive-letter casing, paths with spaces and non-ASCII characters, UNC paths where supported, CRLF/BOM files, locked/read-only files, external edits during saves, rapid repeated opens, sleep/reconnect, 125–200% scaling, narrow panes, and long chat histories. Test New Chat/Stop/maximize/history changes while a model call, tool, permission request, or verification step is pending. Schema fixtures should cover every previously shipped session version and incomplete/malformed records.

No review can promise that no future bug will occur. These changes and gates address the demonstrated failure mechanisms and make their recurrence observable before release.

**Reproduction artifacts**

[run-probes.ts](/Users/inno/Documents/experiments/arcane-editor/docs/reviews/unityide-2026-09-10/run-probes.ts) creates synthetic fixtures in a temporary directory and runs each probe in a separate Bun process. It uses the installed editor dependencies and actual implementation modules, mocking OS/model-service boundaries. It does not make model requests or write project source files. The browser fixture retains the real Allotment panes, sidebar wrapper, error boundary, maximized portal and Lexical composer; chat services and attachment plugins are stubbed.

Run from the repository root:

```sh
bun docs/reviews/unityide-2026-09-10/run-probes.ts
bun docs/reviews/unityide-2026-09-10/run-probes.ts --ui
```

For the second command, open the printed localhost address and click **Run review UI checks**. Ctrl+C stops the fixture. These are **reproduction assertions**, so success means the documented behavior was observed; they are deliberately not added to the normal passing regression suite. Recorded output is in [reproduction-results.txt](/Users/inno/Documents/experiments/arcane-editor/docs/reviews/unityide-2026-09-10/reproduction-results.txt).
