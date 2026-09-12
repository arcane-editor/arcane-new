# Unity debugger and profiler implementation status

This change is an initial implementation, not completion of the approved plan or
a claim of Rider parity. The product scope remains Unity and the C# needed by
Unity projects. General .NET applications, native debugging and consoles are not
added.

## Implemented

- Native Mono DAP `setVariable` for primitive locals, object fields, array
  elements and nested value-type fields. Writes re-read parents to preserve
  siblings. Float32 values retain their wire type. Readonly fields, incompatible
  literals and fabricated object references are refused. String creation,
  arbitrary assignment expressions and full unsigned 64-bit literals remain
  unsupported.
- Corrected the Mono ObjectRef.SetValues command from 3 (IsCollected) to 6.
  A real Mono fixture covers local, array and nested struct edits and checks that
  the process survives detach.
- Unity runtime discovery includes `Resources/Scripting/MonoBleedingEdge`.
  Debugger verification cannot conceal a failed process behind a skip message.
- Thread selection, expandable watches, breakpoint enablement, exception filter
  controls, manual player addresses, visible operation failures and clearing
  stale inspection state on resume/termination.
- Unity Profiler bottom-panel tab and command, explicit target selection and
  recording, frame selection, follow mode, saved captures, import/export,
  paginated virtualized sample rows, timeline, page-level marker totals,
  recorded counters and frame percentile comparison.
- Unity RawFrameDataView exporter with bounded gzip chunks and backpressure.
  The bridge transports control/status and chunk indices, not complete captures.
  Rust commits each chunk transactionally before the Editor deletes it.
- Version 1 indexed SQLite `.unityide-profile` files can be reopened offline.
  Decompression and sample-page sizes are bounded. Recording storage defaults
  to 2 GiB; the database also enforces the configured page limit.
- Stop drains the available frame backlog. Target changes, overwritten frames,
  writer errors and limits are surfaced. Domain reload recovery retains completed
  chunks for ingestion when the user reconnects.
- Debugger/profiler evidence is frozen when staged in the AI composer. Staging
  does not submit a prompt, change backend permissions or apply code changes.
  Oversized evidence is rejected during attachment resolution.
- Required real-Unity profiler gate creates a disposable project and compares a
  known CPU marker's exported name/timing with Unity RawFrameDataView. Missing
  Unity or a failed runtime fixture exits nonzero.

## Remaining implementation

- Saved Unity run configurations; launch/test workflows; owned mobile tunnels
  and Apple device transport; per-target Mono/IL2CPP capability negotiation.
- Temporary/dependent breakpoints, frame-boundary pausepoints, exception detail
  inspection, expanded C# invocation/evaluation, decompilation with IL mappings,
  and scene/texture/Entities visualizers.
- Version adapters validated beginning with Unity 2021.3. The current profiler
  implementation compiles against installed Unity 6.3 assemblies only.
- Capture-wide marker aggregation and inverted hierarchy, full flame graph,
  source fingerprint checks, inline hints and build/settings comparison.
  Current frame queries expose the latest 2,000 frames; the chart shows 300.
  Hotspots are explicitly limited to the current 1,000-sample page.
- Memory snapshot capture/import, managed/native graphs, retention paths and
  snapshot comparison. No Memory Profiler package internals are coupled into
  the bridge yet.
- Configurable recording limits in the UI, persisted interruption/drop metadata,
  cancellation and million-sample/object performance acceptance tests. Current
  transient status is not preserved inside exported database metadata.
- GPU/platform diagnostics beyond measurements actually supplied by Unity.
  Absent GPU values render as unavailable, never as zero-cost measurements.

## Verification and support evidence

Run from `editor/`:

```sh
bun run verify
bun run verify:unity-automation
UNITYIDE_PROFILER_EDITOR=/path/to/Unity bun run verify:profiler
```

The installed runtime is Unity 6000.3.5f2 on macOS. Mono fixtures exercise that
runtime in a standalone managed fixture; they do not establish real Editor,
player, IL2CPP or mobile support. Extension compilation is also not runtime
verification.

The real profiler gate was attempted in a disposable project. Unity licensing
initialization timed out; the gate failed without capture results. Do not count
this as passed or skip it for release qualification. Windows/Linux hosts,
Unity 2021.3 and later representative versions, development players, mobile
devices, Mono/IL2CPP combinations and memory/GPU coverage remain unverified.

Full support requires completing the remaining implementation and the original
acceptance matrix, including repeated reloads, disconnects, corrupt captures,
resource limits, memory graphs and large-dataset responsiveness.
