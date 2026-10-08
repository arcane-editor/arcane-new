# UnityIDE 0.4.0 Rider migration implementation

Updated 8 October 2026. Baseline: `16a2591`, `heads/v0.4.0`.

## Release contract

The approved programme covers everyday and advanced Unity work on Windows x64
and Apple silicon macOS. Unity 6.3 LTS is primary; Unity 6.0 LTS and 2022.3 LTS
remain compatibility requirements. Semantic shaders, DOTS/Burst, coverage,
CPU and memory analysis, and Rider's documented debugging targets remain in
scope. Rider's documented operating-system restrictions apply to the comparison.
Readiness determines release timing.

This working tree implements the first correctness foundation. **It does not
implement the complete approved programme and is not release-ready.** No tag,
deployment, signing operation or production configuration change is included.

The machine-readable inventory is
[`unityide-040-capabilities.json`](./unityide-040-capabilities.json). It contains
44 gates: 41 required and three explicit reference-product exclusions. Each row
records its environments, fixtures, evidence state and implementation locations.
The three exclusions do not waive the separately requested coverage or memory
requirements.

From `editor/`:

```sh
bun run check:readiness-ledger # validates the inventory; does not certify release
bun run check:readiness        # exits unsuccessfully while required gates are open
bun run verify                # mandatory existing verification, including runtime probes
```

Evidence states are `implemented`, `runtime-verified`, `incomplete`, and
`reference-unsupported`. A required gate needs runtime verification for every
declared fixture/environment, with a report artifact. Entries are chronological;
a later failed or skipped run invalidates an older pass. Ledger validation is
part of ordinary verification. The release readiness command is deliberately
separate: passing unit tests while the programme is being developed must not
imply a releasable product. Declared artifacts still require review; this checker
does not independently certify hardware or inspect report contents.

## Implemented foundation

| Change | Result and evidence |
|---|---|
| Save All | A distinct action saves every dirty document through the existing formatting/conflict-aware save pipeline. Failures leave documents unsaved and are reported. Rider `SaveAll` and `SaveDocument` now map to their respective actions; the native menu owns the matching shortcut. Regression coverage: `src/stores/save-format.exec.ts`, native importer fixtures. |
| Workspace text changes | Normalize file identity and preserve server version preconditions; reject resource operations and virtual documents before mutation. Prepare every file, validate ranges, preview multi-file operations/refactorings, then write through a native journal. Open-buffer versions are checked before and after disk application. Regression coverage: `workspace-edit-plan.test.ts`, `workspace-edit.exec.ts`, `src-tauri/src/workspace_edit.rs`. |
| Recovery and undo | Native journals record original and resulting text before writes. Rollback restores only transaction-owned contents. One explicit **Undo Last Workspace Change** action covers dirty buffers and closed files. Interrupted operations are detected on workspace open; **Review Workspace Recovery** previews restoration. Subsequent user/external edits prevent automatic overwrite. |
| Rename safety | File/class synchronization now requests semantic language-server rename against current text. Serialized-field protection follows declaration spans in the semantic rename result across files, including explicit `SerializeReference` fields. Safeguard failure aborts rename. |
| Asset freshness | Scene/prefab and other indexed content changes use the incremental path. Full persisted indexes include content fingerprints and the path set, invalidating offline changes. Concurrent native builds/deltas are serialized; stale frontend map requests cannot refill a reset cache. Incremental changes invalidate persisted results so queued but unprocessed changes cannot be certified as fresh. |
| Headless tests | Every execution reserves a new result/log directory. Process failure, absent/truncated/malformed results, unknown case states and inconsistent run failures are errors. Previous XML cannot become the new run's result. |
| Connected test correlation | Run identity is established before dispatch. UI progress/results require the active run ID and source; duplicate case completion is ignored. Inconclusive remains a distinct outcome. Debug Test waits for the debugger's readiness contract. |
| Debugger readiness | Attachment awaits breakpoint synchronization, exception configuration and current catch-up scans. Obsolete scans are ignored and failed scans refuse readiness. Stop/window cleanup uses an explicit shutdown signal and completion acknowledgement rather than relying on channel closure. Background tasks are joined during cleanup. |
| Full-range CPU hotspots | SQLite aggregates every sample in the selected frame range; visible-page limits cannot hide expensive samples. Self time subtracts children before filtering. Unknown allocations remain unknown. Hotspot scope is explicit, and evidence includes its range/completeness. Frame metadata no longer stops at 2,000 frames. |
| Verification isolation | Default IntelliSense/native smoke fixtures copy only Unity version metadata into disposable projects. Profiler verification prefers a supported stable Unity 6.3 installation over a newer beta. Runtime probes do not alter a user's recent Unity project. |

### Current safety boundaries

- The workspace service handles **text changes only**. Create/move/delete,
  `.meta` pairing, UnityEvent rewrites and explorer transactions are still open.
  Unsupported operations fail explicitly and are no longer advertised to LSP.
- Workspace undo currently exposes the latest operation from the current
  process. Journals survive restart for interrupted-operation recovery. Standard
  document undo remains separate. Closing/reopening an affected buffer or
  editing it again can require manual review instead of automatic undo.
- Closed-file baselines are captured when preparing the returned edit. Proving
  their revision during server-side computation requires a stronger backend
  contract. Filesystem compare-before-replacement also cannot eliminate every
  possible write race with an uncooperative external process.
- Journals are file-synced and atomically replaced using the existing writer.
  Real crash/power-loss certification, Windows failure recovery and the entire
  buffer/disk/watcher interaction matrix remain unverified.
- Serialized-field declarations are found through semantic edit spans, but
  serialization eligibility is still syntactic. Inherited public fields,
  partial types and attribute aliases require actual Roslyn symbol/type identity.
- Asset queries still depend on successful watcher delivery during a session.
  Incremental updates stay in memory; the next restart rebuilds after a delta.
  Scalable persistence with per-ingest fingerprints and explicit freshness is
  follow-up work. This conservative invalidation is intentional.
- Test discovery is still provisional/heuristic. Authoritative Unity test trees,
  cancellation, reload-resilient sessions and coverage are incomplete.
- A successful low-level Mono probe does not certify window-close behaviour,
  Unity reloads, player transports, consoles, IL2CPP or mixed-mode debugging.
- CPU aggregation tests establish query correctness, not successful live capture
  or profiling overhead. Memory snapshots and graphics capture remain open.

## Remaining implementation order

Keep the current editor, csharp-ls and managed debugger. Introduce shared
contracts through feature public APIs and centralized stores; preserve ACP
autonomy/checkpoint rules and legacy compatibility identifiers.

1. **Authoritative Unity compiler graph (B).** Export evaluated compiler inputs
   from `CompilationPipeline`; generate one project per actual assembly and an
   explicit solution. Preserve runtime/Editor/test ownership, asmdef/asmref and
   target constraints, local/embedded/resolved packages, project versus binary
   references, response files, defines, language options, analyzers and generators.
   Fingerprint a last-known-good graph; show stale/disconnected state. Keep the
   language-server host runtime separate from Unity's language version. Gate on
   agreement with Unity's diagnostics and symbol visibility across the corpus.
2. **Complete workspace/asset transactions (C).** Extend the text service with
   ordered resource operations, canonical identity on supported filesystems,
   `.meta` GUID preservation, asset preconditions, durable crash/undo semantics
   and a complete workspace undo history. Resolve serialized-field identity in
   Roslyn and combine UnityEvent binding rewrites in one preview. Require current
   asset evidence and saved Unity state; expose ambiguous strings for review.
3. **C# workflows (D).** Wire metadata/decompiled/generated read-only documents,
   call/type hierarchies and structural navigation. Maintain a small pinned
   csharp-ls extension for actual backend gaps. Inventory the approved rename,
   move, safe delete, Change Signature, extraction, introduction/inline, member
   movement, namespace and conversion families against real semantic fixtures.
   Add cleanup profiles, EditorConfig/team formatting, transitive hot-path
   analysis and analyzer fixes through the common change service.
4. **Debugger system (E).** Finish exception details/filters, casts/statics,
   collections, coroutine/async and Unity-object views. Prototype explicit,
   bounded invocation with main-thread/suspension handling. Certify Editor,
   desktop players, Android network/USB, iOS/iPadOS network/USB and required
   device services, supported IL2CPP configurations and licensed consoles on
   actual targets. Prototype coordinated LLDB DAP mixed-mode support on Windows
   x64 Mono, including stop ownership, threads, symbols and stepping handoff.
5. **Tests and coverage (F).** Consume Unity's authoritative test tree, retain
   offline discovery as provisional, and unify UI/tool run control. Finish stable
   parameterized/generated identity, cancellation, compilation failure, timeout,
   reload recovery, rerun/filter/session persistence and all terminal outcomes.
   Add Unity Code Coverage with source/run/revision identity, line display,
   filters, saved reports and import/export. Current dotCover Mono support is
   not the coverage baseline.
6. **Profiling and memory (G).** Repair/verify real capture and the complete
   ingestion/query/navigation/export/import chain. Add source-linked CPU results,
   explicit collection configurations and overhead disclosure. Prototype
   versioned Unity memory snapshot adapters and background object/reference
   analysis; compare known retained objects in player captures. Keep dotTrace
   comparisons distinct from Unity frame data.
7. **Shaders and DOTS/Burst (H).** Validate DXC IntelliSense on both hosts before
   committing the backend architecture. Build ShaderLab parsing/source maps,
   include resolution, render-pipeline/pass/stage/API/keyword context, semantic
   assistance and transaction-backed rename. Unity compilation is final
   authority. Prototype version-pinned RenderDoc capture, event/texture/vertex
   views and vertex/fragment debugging on Windows. Run actual compatible Entities
   generators through the compiler graph; implement package-specific inspections,
   generated navigation and transitive Burst analysis validated with real Burst.
8. **Migration and delivery (I).** Validate imported action behaviour, inheritance
   and reversibility. Finish settings coverage, familiar search/recent/bookmark/
   TODO navigation, independent editor groups sharing document models, hunk/line
   staging, conflict resolution and local history independent of AI. Preserve
   asset/`.meta` pairs. Certify shortcut ownership, clean signed installation,
   notarization, Unity registration, update/recovery and offline core workflows.
9. **Readiness evidence (R).** Benchmark the whole process tree on the same
   machines/projects as the frozen Rider baseline. Require warm p95 completion
   ≤300 ms, navigation ≤500 ms and incremental diagnostics ≤2 s without sustained
   typing/scrolling stalls. Include approximately 10,000 C# files/50,000 assets,
   200 edit/compile/play/reload cycles per core host/version fixture, and ten
   existing Rider users completing two working weeks across gameplay, tooling,
   graphics/DOTS and device work. Any missing required capability or correctness
   failure that sends a pilot user back to Rider blocks release.

Start shader, memory-format, mixed-mode and licensed-device feasibility early,
alongside the compiler graph. An unsuccessful feasibility gate requires an
explicit architecture revision; it does not silently remove the requirement.

## Verification and outstanding access

The latest mandatory `bun run verify` completed with a failure at the live Unity
profiler check. Type checking, module boundaries, native command arguments,
version synchronization, ledger validation, source/script/isolated tests and
1,002 Rust tests passed before that failure. The live C# IntelliSense, external
ACP agent and Mono debugger checks also passed. The editor build passed with
the existing large-chunk warning. Unit tests and these focused probes are
implementation evidence, not cross-platform product certification.

The profiler fixture on Unity 6000.3.24f1 produced no raw frames (`-1..-1`) or
capture bytes within 60 seconds despite profiling being enabled. Full-range
aggregation regression tests pass, but live capture remains failing and must
be repaired before the profiler gate can pass. The full verification suite
must therefore be reported as failed, not passed or skipped.

The ledger currently records eight required gates as implemented and 33 as
incomplete. None of the 41 required gates has complete runtime certification
across its declared environments and fixtures; all remain release blockers.

Windows execution, supported device/build/backend/transport combinations,
licensed console targets, native symbols, signing credentials and notarization
remain explicit external dependencies. Much of the remaining programme is
ordinary implementation work and must not be characterized as blocked solely
by that access.

No live Unity capture, Windows installed application, physical target, memory
snapshot, shader/DOTS specialist workflow, performance corpus, soak or user
pilot is certified by this implementation.
