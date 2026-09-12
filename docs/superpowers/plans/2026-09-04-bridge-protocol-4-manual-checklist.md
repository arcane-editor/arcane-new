# Bridge protocol 4 (0.2.0) — republish & manual-smoke checklist

Owner checklist for shipping `arcane-extension` (`com.unityide.editor`) 0.2.0 —
bridge wire-protocol 4 — the last piece of Workstream B
(`2026-09-04-harness-unity-feedback-and-project-map`, Task 19). Everything
that can be proven without a running Unity Editor is already done and green
(see Task 19's report for the full command output). What is left needs owner
credentials (the R2/GitHub Actions publish) or a human at a real Unity
project (the smoke list and the EditMode Test Runner pass) — this doc is
both.

Version pins confirmed consistent, no drift: `arcane-extension/package.json`
`version` = `BridgeBootstrap.PackageVersion` = Rust `MIN_PACKAGE_VERSION` =
**0.2.0**; `Discovery.ProtocolVersion` = Rust `PROTOCOL_VERSION` = **4**. All
four are pinned by tests (`cargo test unity_ipc`, `DiscoveryTests.cs`,
`RpcProtocolGateTests.cs`).

## 1. Publish steps (owner-gated — nothing below was run by this task)

Nothing in this task uploaded anything. `arcane-extension/deploy.sh` only
validates, cleans, and `npm pack`s a tarball **locally** — it never touches
the network. Uploading is a separate step, done by CI on a tag/dispatch, or
locally with `wrangler` if a manual push is ever needed.

### Release channel (the Asset Store / default UPM feed)

```bash
cd arcane-extension
bash deploy.sh release
# -> arcane-extension/com.unityide.editor-0.2.0.tgz  (local only, gitignored)
```

Publishing is automatic: the `unity-extension` job in
`.github/workflows/release.yml` runs on every push of a `v*` tag (or manual
`workflow_dispatch`) — it is a separate job from the app build, keyed off
`arcane-extension/package.json`'s own version, not the tag. It runs
`deploy.sh release`, then uploads the resulting tarball to:

- `arcane-releases/unity-extension-releases/com.unityide.editor-0.2.0.tgz`
- `arcane-releases/unity-extension-releases/latest/com.unityide.editor.tgz`

Both are R2 object puts (`bunx wrangler r2 object put ... --remote`), needing
only the two repo secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
already used by the rest of the release workflow. **Tag whenever this
package's version changes**, even if the editor app version doesn't — the job
runs alongside the app matrix on every tag, cheaply (no native build).

### Dev channel (`com.unityide.editor.dev`, for the "UnityIDE Dev" app)

```bash
cd arcane-extension
bash deploy.sh dev
# -> arcane-extension/com.unityide.editor.dev-0.2.0.tgz  (local only, gitignored)
```

`deploy.sh dev` stages a copy under `.pack-dev/`, rewrites it via
`scripts/unity-extension-channel.mjs` (different UPM id, deep-link scheme,
assembly names, and every asset GUID remapped — `md5(guid:"dev")`, stable
across builds), packs it, moves the tarball back to `arcane-extension/`, and
removes `.pack-dev/`. The checked-in source is never touched by this — verify
with `git status`, which should show only the tarball as untracked (and
ignored).

Publishing is via the `unity-extension-dev` job in
`.github/workflows/dev-build.yml`, which runs `deploy.sh dev` and uploads to:

- `arcane-releases/unity-extension-releases/dev/<short-sha>/com.unityide.editor.dev-0.2.0.tgz`
- `arcane-releases/unity-extension-releases/dev/latest/com.unityide.editor.dev.tgz`

**Caveat found while writing this checklist:** `dev-build.yml`'s trigger is
`on.push.branches: ['dev']` gated by `paths: ['editor/**',
'.github/workflows/dev-build.yml']` — it does **not** list
`arcane-extension/**`. A push to `dev` that touches only the Unity package
(exactly this task's shape of change) will **not** auto-trigger the dev
publish job. Until that path filter is widened, publish the dev-channel
package via `workflow_dispatch` (Actions → Dev Build → Run workflow) after
merging this work to `dev`, or bundle the release with an `editor/**` change.
Not fixed here — it's a CI trigger decision, not a packaging inconsistency,
and out of this task's no-upload scope.

### Local sanity already done (Task 19)

- `cd editor && bun run sync:bridge` and `bun run sync:bridge -- --channel dev`
  both regenerate the gitignored `editor/unity-bridge/` staging folder
  successfully (release: no remap; dev: 37 guids remapped).
- Both tarballs built clean, ~128 KB each, `Editor/Handlers/*.cs` (and its
  `.meta`s) confirmed present inside via `tar tzf` — `deploy.sh`'s own
  `.meta` check only globs `Editor/*.cs` (not `Editor/Handlers/*.cs`), so it
  silently skips the Handlers files; a from-scratch guid audit (below) covers
  what `deploy.sh` misses. `npm pack` itself packs the whole tree correctly
  regardless.

## 2. Compatibility matrix to verify

| Combination | What should happen |
|---|---|
| **Old IDE (protocol < 4) + new package (0.2.0, protocol 4)** | Old package never ships from this task, so this is really "new package installed, IDE build predates protocol 4." The package still handshakes — `connection_init`/`project_info` don't refuse a protocol mismatch, they just emit `unity-bridge-version-mismatch` and connect anyway. Protocol-4-only tool paths degrade individually (see below); everything that predates protocol 4 (play controls, console streaming, compile events, inspector sync, existing test-runner) keeps working unchanged. |
| **New IDE (protocol 4) + old package (< 0.2.0 / protocol < 4)** | Two banners, both persistent `warning` notifications in the notifications tray: (1) `unity-bridge-version-mismatch` → *"Unity bridge protocol mismatch (IDE v4, bridge v&lt;N&gt;). Reinstall the bridge package."* — no action button. (2) `unity-package-stale` (reason `outdated`, since Rust `package_is_too_old` compares the handshake's `packageVersion` against `MIN_PACKAGE_VERSION` "0.2.0") → *"The UnityIDE Unity package is out of date (&lt;installed&gt;; needs 0.2.0). Update it — a stale package fails in confusing ways."* with an **"Update package"** action button that calls `installBridge(workspacePath)`. Verify both fire and the button actually reinstalls the bundled package over the old one. |
| **Unity running, no package installed at all** | `unity-package-stale` fires with reason `missing` → *"Unity is running but the UnityIDE package is missing. Install it to connect the editor."* with an **"Install package"** action. |

### Per-tool degrade behavior against an old (pre-protocol-4) package

Confirmed by reading the source (not all tools degrade the same way — verify
each individually against a real old-package install, ideally 0.1.x):

- **`get_console_errors`** (`unity-tools/read-tools.ts`,
  `unavailableSessionLabel`): once `bridgeProtocol` is known and `< 4`, the
  console-history call returns *"Unity's console history is unavailable: the
  installed bridge package predates protocol 4 — update it"* instead of
  silently returning nothing.
- **`unity_attach_ui_document`, `unity_set_property`**
  (`unity-tools/scene-mutate-tools.ts`, `oldPackageNote`): the RPC comes back
  "Unknown method" on an old bridge; the tool catches that specific message
  and returns *"The installed UnityIDE bridge package predates protocol 4,
  which added the scene-write RPCs — update the package in Unity, then
  retry. Until then, ask the user to make this change in the Inspector."*
- **`unity_run_tests`**: behaves differently on purpose — `runTests` existed
  before protocol 4 as a blocking RPC; protocol 4 only changed it to a queued
  dispatch with a `test_run_completed` push. An old package still runs tests
  via the legacy blocking path rather than erroring. See known limitation
  below (a specific old-package failure reply is misclassified).
- **The Verified card's console row** (`console-check.ts`
  `consoleRowLabel`): shows *"console: stream only (update the bridge
  package for full history)"* when the post-turn check can only see this
  session's streamed log, not the pre-connection snapshot — this is the
  literal "update the bridge package" line the brief refers to.

## 3. Smoke list (needs a real Unity project + a running IDE build)

Run against Unity 2022.3 LTS or 6000.x with the freshly built
`com.unityide.editor-0.2.0.tgz` imported, and an IDE build with
`PROTOCOL_VERSION = 4`.

1. **History backfill.** Generate a few `Debug.LogError`/exception rows in
   Unity's own Console *before* opening/connecting the IDE (or before the
   package installs), then connect. Confirm `backfillConsoleHistory`
   (`stores/unity.ts`) pulls them in and the Unity Console panel
   (`features/unity-console`) marks them as historical (prepended, distinct
   styling) rather than mixing them into the live stream as if they just
   happened.
2. **`get_console_errors` before/after connect.** Ask the agent for console
   errors while disconnected (expect the "bridge not connected" unavailable
   label), then again after Unity connects (expect real rows, or the
   protocol/backfill-gated message above if testing against an old package).
3. **A failing test through `unity_run_tests`.** Seed one failing EditMode or
   PlayMode test, run it via the tool, and confirm: the queued dispatch
   coalesces a concurrent duplicate call instead of double-running, live
   per-test progress streams (`unity-test-event`), and the final
   `test_run_completed` push produces a correct failure summary
   (`describeTestRunOutcome`) rather than a timeout.
4. **Scaffold → write → layout → attach → Verified card console row.** In one
   turn: `unity_ui_scaffold` a screen template, `unity_ui_write` to edit the
   generated `.uxml`, `unity_ui_layout` to confirm it actually lays out
   on-panel (not off-screen/zero-size), then `unity_attach_ui_document` to
   wire it onto a GameObject (creating the `UIDocument`/`PanelSettings`/theme
   it's missing). Confirm the turn's `VerifiedCard` shows UI Toolkit ok and a
   real (not "skipped") console row.
5. **A repair pass on a seeded `NullReferenceException` in Play Mode.** Enter
   Play Mode with a script that throws an NRE, let the post-turn console
   check see it, make the agent fix it, and re-enter Play Mode. Confirm the
   card is honest per the code comment: a since-quiet error should read as
   *"not seen again"* / `notReobserved`, never claimed as definitively
   "fixed" — repair claims need a re-observation window, not silence alone.
6. **`unity_set_property` on a float, then Undo.** Set a float field via the
   tool (e.g. a `Transform` or component field), confirm the Inspector
   updates live, then hit Unity's native Undo (Cmd/Ctrl+Z) and confirm the
   value reverts — `setSerializedProperty` must go through Unity's normal
   Undo system, not bypass it.

## 4. Unity EditMode tests to run in the Test Runner

These live under `Tests/Editor/` and reference internal types
(`Discovery`, `Journal`, `BridgeClient`, `ConsoleReflection`, ...) so they
cannot run headless in this repo's CI — run them inside Unity's own Test
Runner (Window → General → Test Runner → EditMode), **twice**: once on
**2022.3 LTS** and once on **6000.x**, both green.

| File | What it proves |
|---|---|
| `ConsoleReflectionTests.cs` | **The version canary.** Proves the reflected `UnityEditor.LogEntries` surface (private/internal API) actually resolves and behaves on *this* Unity version's console, without disturbing the real Console window. If this fails on one LTS but not the other, that's a real per-version reflection break, not a bridge bug — triage there first. |
| `ConsoleHookRingTests.cs` | The hook ring's own contract (bounded capacity, oldest-evicted-first, monotonic `Seq`) independent of whether reflection resolves. |
| `DiscoveryTests.cs` | `Discovery.ProtocolVersion == 4`, matching the IDE side. |
| `RpcProtocolGateTests.cs` | Queued-command gating changes meaning by `IdeProtocolVersion`; `MinQueuedProtocol` behavior. |
| `SceneMutationTests.cs` | The first WRITE RPCs — `attachUiDocument`/`setSerializedProperty` — including `EditorGate` refusing writes during Play Mode/domain reload/Prefab Mode. |
| `TestRunProtocolTests.cs` | `runTests` blocking→queued transition and the `test_run_completed` push. |
| `BridgeThreadingTests.cs` | Thread-affinity guarantees of the bridge worker. |
| `DispatcherLivenessTests.cs` | Dispatcher behavior while Unity's main thread is parked (background). |
| `ContractTests.cs` | Journal wire format pinned against the Rust side. |
| `JournalTests.cs` | Journal read/write mechanics. |
| `LauncherTests.cs` | Pure argument construction/quoting for launching UnityIDE (no discovery/IO). |

Compile status (proven headless, this task): both `UnityIDE.Editor.dll` and
`UnityIDE.Editor.Tests.dll` compile clean via `csc` against the local
6000.3.5f2 install (`.superpowers/sdd/.../csharp-compile.sh`) — the Test
Runner pass above is about *running* them inside each Unity version, not
compiling.

## 5. Known limitations (carried from this run's ledger — not fixed here)

- **A mid-turn `unity_console_clear` loses that turn's earlier ring rows
  without a caveat.** The `'reconnected'` unknown-state only fires for
  post-baseline *historical* rows (by design — see Task 13's ruling R13); a
  clear issued mid-turn by the agent itself isn't distinguished from one the
  user issued, and there's no caveat surfaced for either.
- **The `tests: run did not finish` row is not yet reachable.** The test-run
  registry that feeds the Verified card's tests chip
  (`recordTestRunForConsoleCheck`) only records completed (`ok === true`)
  runs, so a run that aborts, times out, or never starts (e.g. Unity
  backgrounded) leaves the chip at `skipped` instead of showing an
  in-progress/failed state. Deferred to a future fix wave as
  `recordTestRunAttempt({status:'unknown', reason})` (Task 11 ruling R11).
- **On a `protocol < 3` (pre-queued-dispatcher) package, a
  `{ok:false, reason:'runner-unavailable'}` reply is misclassified as
  `'not-installed'`** by `isNotInstalledReply`
  (`test-run-wait-core.ts:352-357`) — the agent is told the Test Framework
  package isn't installed when the real cause is a busy/unavailable runner
  on a near-obsolete bridge. Accepted as deferred: protocol < 3 predates the
  queued dispatcher entirely and is not expected to see real-world use.

## Doc fix folded in

`arcane-extension/README.md` and `Documentation~/unityide-extension.md` each
previously stated only a Unity-version requirement with no mention of the
bridge/IDE protocol pairing. Added one line to each Requirements section:
package 0.2.0 speaks protocol 4, needs a UnityIDE build that speaks protocol
4 too (0.3.3+), and what happens when it doesn't (mismatch banner, degraded
protocol-4 RPCs) rather than leaving that undocumented.
