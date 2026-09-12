**UnityIDE review fixes — 10 September 2026**

The 12 findings in the [original review](./review.md) now have implementations and regression coverage. Additional fixes validate malformed verification cards, cancel requests queued before an AI backend starts, and correct C# server discovery. This describes the editor changes made for this review; unrelated existing Unity automation and other worktree changes were preserved.

| Finding | Implemented behavior | Regression coverage |
| --- | --- | --- |
| 1. Stale formatter overwrites typing | Check the Monaco model version after the formatting request; discard stale edits. Save the current buffer. | Deferred real formatter request with intervening typing. |
| 2. External edit overwritten on save | Preserve each buffer's disk baseline. Compare before staging and again before replacement. Keep a conflicting buffer dirty and show Compare, Overwrite, Refresh disk version, and Discard/reload actions. Serialize saves and reject queued work belonging to a closed tab. | Actual workspace store plus native concurrent-write and external-change-during-staging tests. |
| 3. Truncation on failed writes | Route ordinary text, history, and byte writes through the shared atomic writer: adjacent temporary file, flush, replacement, bounded per-destination serialization, and cleanup on failure. Follow existing symlinks. | Injected failure preserves the original and removes temporary files; byte-exact BOM/CRLF and Unix symlink/permission checks. A Windows locked-file test was added but not executed here. |
| 4. Old AI verification appears in new chat | Capture conversation generation and workspace ownership. Automatically dispose stale services; abort closing checks and refuse stale cards, repairs, usage updates, and final cleanup. Scope chained-send budget cleanup to its owner. | Real service/store with deferred verification, late stream usage, and old/new submit-budget tests. |
| 5. AI panel cannot recover after reopening | Reset the boundary when reopened or the conversation changes; add Retry. Isolate failed message rendering from the composer. | Mounted transient-error, hide/reopen, and Retry checks. |
| 6. Busy Enter consumes a draft | Use synchronous submission acceptance for button, Enter, and Resume. Cover preparation, streaming, and closing verification. Clear Lexical text and attachments only after acceptance. Stop also invalidates queued preparation. | Real composer callback while busy; Stop during preplanning imports, plan reads, and external-agent connection; mounted Lexical accepted/rejected submissions. |
| 7. Maximize loses the draft | Keep one mounted AI panel and move its stable portal container between dock and overlay. Preserve focus and selection when moving it. | Mounted checks assert the same composer DOM node and draft survive maximize, restore, and the Inspector round trip. |
| 8. Overlapping opens duplicate tabs | Deduplicate pending opens; track tab lifetimes and activation order. Track one LSP claim per tab, including server startup/resynchronization. | Concurrent same-file opens, reverse read completion, close during read, and Windows drive/separator variants. |
| 9. Rename leaves stale editor/LSP state | Release old models, LSP claims, and diagnostics; re-open renamed documents with current buffer contents. Remap navigation and recent paths; capture and restore available editor view state. Apply this to open directory descendants. | Real store test checks old/new document identity, edits after rename, and model disposal. Monaco undo history is not transferred between immutable model URIs. |
| 10. Delete bypasses cleanup | Share cleanup with close/workspace replacement; invalidate pending opens and remove deleted paths from navigation/recent history. | File and directory deletion with foreground/background documents. |
| 11. Windows commands outlive timeout | Start the shell suspended, attach it to a kill-on-close Windows job, then resume it. Keep the job guard alive for the command future. Unix retains process-group ownership. | Windows child/grandchild heartbeat tests for cancellation and the actual command timeout path were added. Windows execution remains unverified here. |
| 12. Large asset reads allocate unbounded data | Move blocking filesystem operations into a bounded blocking pool. Inspect metadata and an 8 KiB prefix before reading; cap text at 20 MiB. Show a binary/large-file notice and refuse to save placeholder content. | A sparse 4 GiB file returns no text payload; NUL binary detection and UTF-8 characters split across the prefix boundary are covered. |

The remembered `.problems` crash was consistent with an older verification-card schema, though the exact incident cannot be identified without its stack trace. Runtime normalization now handles missing, null, and malformed check fields at both history loading and rendering. Invalid evidence becomes skipped or explicitly unverified; it cannot create a passing result. Three additional schema tests cover these cases.

The C# probe now resolves a symlinked `dotnet` executable before deriving `DOTNET_ROOT` and provisions the shipped pinned server. Application discovery now prefers that managed version over automatic global/PATH discovery. Automatically discovered incompatible versions cause managed provisioning; explicit path overrides retain precedence. The existing global tool was not overwritten. The successful semantic probe used **csharp-ls 0.27.0**, not the global 0.22.0 installation that failed the original review.

**Final validation**

`bun run verify` was run from `editor/` after the final application changes. It exited successfully, with the debugger probe explicitly skipped as shown below.

| Check | Result |
| --- | --- |
| TypeScript, module boundaries, invoke arguments, version/updater checks | Passed |
| Source JavaScript/TypeScript suite | 4,642 passed |
| Script suite | 124 passed |
| Isolated execution regressions | 44 passed |
| Rust library suite on macOS | 930 reported passed |
| Real C# semantic probe | Passed: pinned 0.27.0, static and instance completion, incremental changes, resolve, hover, compiler diagnostics, analyzers, quick fixes, and capabilities |
| Real ACP probe | Passed: adapter 0.70.0, session creation, configuration options, and boolean Fast option |
| Mounted browser regression fixture | All 8 checks passed |
| Live Unity debugger probe | **SKIPPED: no Unity runtime found. Unverified.** |
| Windows native tests and packaged Windows/WebView behavior | **Not run on this Mac. Unverified.** |
| `git diff --check` | Passed |

C# timings in the final run: first completion 544 ms, warm completion 25 ms, resolve 129 ms, hover 14 ms, diagnostics 243 ms, analyzer pull 42 ms. All were within the probe budgets. These timings describe this local fixture, not Windows performance measurements.

The browser fixture uses the actual Allotment, sidebar, error boundary, maximized overlay, and Lexical composer, with AI/OS dependencies stubbed. It is an interaction regression test, not a packaged Tauri application test. Rust aggregate success does not turn skipped Unity checks into passes.

To repeat the checks from `editor/`:

```sh
bun run verify
bun scripts/verify-editor-ui.mjs
```

For the UI fixture, open the printed localhost URL, click **Run editor UI checks**, and stop the fixture afterward. The original `run-probes.ts` under this review folder remains historical reproduction evidence: its assertions intentionally describe the old failures. Use the new isolated tests and mounted fixture for fixed behavior.

Windows release validation still needs a real Windows installation: execute the new process-tree/locked-file tests and check packaged editor behavior, Windows permissions, antivirus locking, network shares, scaling, and large Unity projects. The live debugger needs Unity's runtime before it can be verified. Explicit custom C# server overrides also need their own semantic probe. No zero-bug or crash-free guarantee is implied by these fixes.
