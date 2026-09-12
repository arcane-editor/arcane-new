# Specialist harness implementation and acceptance

The built-in UnityIDE agent has an opt-in coordinator workflow under
`ai.specialists.enabled`. It is **off by default** until the live Unity and
three-generation runner benchmark pass. Turning it off restores the existing
execution path. Ask, Plan planning, the single-document design workflow and
external ACP agents keep their existing paths. Approved plan execution can use
the coordinator.

## Execution

Seven role definitions live in `editor/src/features/ai-panel/services/specialists`:
level design, UI building, editor tooling, gameplay, presentation, gameplay
verification and independent review. Each assignment has its own Agent instance,
private history, stable prompt prefix and restricted tools. UI specialists reuse
the existing UI expert rules. Briefs carry explicit targets, dependencies and
acceptance criteria; dependency handoffs omit private histories.

The task owns cancellation, a shared model-call budget, revisioned evidence,
scenario definitions, usage and repair counts. It uses existing hosted routing
and entitlements. Implementation agents cannot write test directories or spawn
children. Verification can write only assigned test/probe files; review cannot
write. At most two read-only assignments run together. Mutations, compile
barriers and Play Mode runs share a workspace lease. Existing file review
preferences still apply to file writes; explicit approve mode also prompts for
structured authoring. Routine structured authoring and playtesting use the task's
authorization in auto mode.

Task and specialist snapshots persist in the current conversation. Restored
running work becomes interrupted. Resume retains its consumed budget and repair
count, invalidates former evidence, and reconciles the Unity playtest owner before
continuing. Captured images are fetched again from the operation journal rather
than copied into saved conversation JSON. The Stop button cancels the coordinator
and children and asks Unity to release test-owned input devices and Play Mode.

The legacy rollback workflow retains its existing single-agent state facades.
The specialist workflow uses explicit task state, private repeat guards and
telemetry, and its own console/scenario evidence instead of those mutable
registries. It does not run the old preplanning pass outside its shared budget.

## Bridge 5 / integration 0.3.0

New methods:

| Method | Meaning |
| --- | --- |
| `authorScene` | Execute structured actions or a declared editor builder in Edit Mode |
| `getAuthoringStatus` | Recover an operation outcome without replaying it |
| `verifySavedScene` | Reopen the saved scene and inspect persistence and references |
| `startPlaytest` | Accept an input-driven scenario, then enter task-owned Play Mode |
| `getPlaytestStatus` | Read durable progress, assertions, console/performance evidence and optional images |
| `cancelPlaytest` | Release test input, exit only test-owned Play Mode and restore scene layout |
| `getAutomationState` | Reconcile the active operation and owning task after reconnect |

Older packages retain their prior RPCs. New capabilities give an upgrade notice
rather than treating unavailable verification as passed. `bun run sync:bridge`
copies the canonical package to the ignored desktop bundle; `-- --channel dev`
also remaps new asset GUIDs. No package publication or production deployment is
part of this implementation.

### Authoring contract

An operation names `operationId`, `taskId`, `scenePath`, `ownedRoot`, `outputs`,
and `actions`. Targets are hierarchy paths relative to the owned root. Supported
actions create/update objects, instantiate prefabs, attach components, assign
serialized values and save prefabs. Parentage comes from the target path, for
example `Track/Obstacle`; parents must exist first. Property values use the
existing bridge's typed serialized-value contract.

A generated builder declares `{ type, method, parameters }`. Its entry point is
`public static void Method(string parameters)` in a project Editor script. It
must update the declared root and outputs, use Undo, and save generated assets.
It must not regenerate in Awake/Start or use InitializeOnLoad/ExecuteAlways as an
authoring trigger. Builder code executes in Unity's process, so these are trusted
project scripts, not a sandbox for arbitrary C#.

Only automation-owned roots and output assets may be updated. Rerunning a fresh
operation updates existing named children instead of adding duplicates. Saved
scenes are reopened through preview scenes; declared prefabs are reloaded too.
Missing scripts, missing serialized references and transient mesh/material/texture
dependencies fail persistence checks. Level assignments also require rendered
geometry and collision before Play. Independent review must still judge whether
that geometry is a representative, usable level.

Unsaved scenes and dirty editor buffers block authoring. Declared outputs and
metadata receive byte-exact checkpoints (2 MiB per existing file; larger outputs
are refused before mutation). The bridge compares checkpoint hashes before
execution to detect intervening edits. Related operations use Undo; declared
outputs are restored on an authoring failure. Uncertain outcomes must be queried
before another mutation. Persistent operation records live in
`Library/UnityIDE/automation`.

### Scenario contract

A scenario names `id`, `scenePath`, `seed`, optional `timeoutSeconds`, and steps:

- `input`: keyboard key, mouse position/button, gamepad control or touch event;
  `value` is a scalar, `[x,y]`, or touch `[x,y,pressed]`.
- `wait`: rendered frames or wall-clock `seconds` (use seconds for endurance).
- `assert`: hierarchy target, optional component, property path, comparison and
  expected value. Nested fields/properties and UI Toolkit element text/visibility
  are observable. Project-specific read-only probes can expose collision and
  progression measurements when generic observation is insufficient.
- `capture`: a labelled rendered Game-view checkpoint, captured after end of frame.

Device events go through the optional Input System adapter and actual bindings.
No gameplay method is called to fake input. Legacy-input projects remain usable
for authoring; automated input reports unsupported. No package or input-system
migration occurs. The runner supports keyboard, mouse, gamepad and one active
touch contact. Multi-touch gestures are not implemented.

Defaults are 120 seconds per scenario and 600 seconds per suite revision; an
endurance scenario can explicitly request a longer timeout within that suite.
Capture failures stay explicit. Images are limited to eight captures and six MiB
of PNG data per scenario to stay within journal transport limits. Cleanup must
complete before a passed result is accepted. Random seeding runs before scene
Awake, including when domain reload is disabled.

The verifier registers the complete required suite through
`unity_register_scenarios` before its first run. Definitions are immutable. Add
coverage under new IDs instead of weakening an existing check. All registered
scenarios must pass at the current revision before completion; repairs invalidate
older evidence. Review can pass visual checks only after its own history received
current captured frames. Compilation alone cannot override missing required
scene, gameplay or visual evidence. There are five repair rounds maximum, with an
earlier stop after two consecutive rounds without more passing checks or
assertions. Reworded failures and new operation IDs do not count as progress.

## Validation and release gate

From `editor/`:

```sh
bun run verify
bun run verify:unity-automation
bun test tooling/unity-eval
bun run sync:bridge -- --channel dev
bun run sync:bridge
```

`verify:unity-automation` uses Unity's compiler to build core, runtime, optional
Input System and test assemblies separately, including a core build without the
optional packages. Set `UNITYIDE_UNITY_RESOURCES` for a different installation.
Compilation is not a substitute for executing Unity Test Runner.

On a workstation with an older global `csharp-ls`, point
`UNITYIDE_CSHARP_LS_DLL` at the bundled pinned server for verification. Fetch the
repository-pinned dependencies with `bun run prepare:csharp-ls -- --require` and
`bun run prepare:unity-analyzers -- --require`. These downloads are checksum
verified and remain outside version control. On macOS with a symlinked `dotnet`
binary, set `DOTNET_ROOT` to the actual SDK installation, not the symlink's bin
directory.

For live integration, create an isolated Unity 6 project with this local package,
Input System and Test Framework, list `com.unityide.editor` in the manifest's
`testables`, then run EditMode tests. The package contains authoring persistence,
idempotency, dirty-scene, transient-asset, rollback and input-binding fixtures.
Run the production bridge in a rendered Unity editor for end-of-frame captures,
Play Mode/domain reload, disconnect and cleanup verification. Batch mode without
graphics cannot validate rendered images.

The fixed original-game brief, seed matrix and fail-closed acceptance evaluator
are in `editor/tooling/unity-eval/benchmarks/endless-runner.ts`. Use three fresh
Unity projects with the same routed model configuration and independent
acceptance fixtures outside implementation write targets. Collect each final
revision's scenario reports, images, usage, latency and context size in the
`RunnerGenerationEvidence` shape, then run:

```sh
bun tooling/unity-eval/benchmarks/check-runner.ts run1.json run2.json run3.json
```

The evaluator requires seeds 17, 41 and 137; movement, jump, slide, collision,
collection, pause/resume, restart, chunk continuity and a three-minute endurance
run for each seed. It rejects missing evidence, altered acceptance fixtures,
reused fresh-project identities and mismatched model configurations. This is an
acceptance gate over collected evidence, not an unattended project-generation
launcher. The live three-generation benchmark and before/after model evaluation
must run before enabling the new workflow by default.

## Unity API references

Scene and prefab persistence use Unity's
[SaveScene](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/SceneManagement.EditorSceneManager.SaveScene.html)
and [SaveAsPrefabAsset](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/PrefabUtility.SaveAsPrefabAsset.html)
APIs. The optional adapter queues
[Input System events](https://docs.unity3d.com/Packages/com.unity.inputsystem@1.14/manual/Events.html)
against synthetic devices. Rendered capture follows the documented end-of-frame
timing for
[CaptureScreenshotAsTexture](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/ScreenCapture.CaptureScreenshotAsTexture.html).

## Validation recorded on 2026-09-10

| Check | Result |
| --- | --- |
| `bun run verify` | Passed with pinned csharp-ls 0.27.0 and Unity analyzers 1.27.0: TypeScript, module boundaries, invoke/version contracts, JavaScript suites, 922 Rust tests, live IntelliSense, ACP and Mono debugger |
| `bun run verify:unity-automation` | Passed: core, runtime, optional Input System and test assemblies compile separately against Unity 6000.3.5f2; also compiled core without optional packages |
| `bun test tooling/unity-eval` | Passed: 129 evaluation unit tests |
| Bundled bridge synchronization | Passed for dev GUID remapping and release bundle; protocol 5, package 0.3.0 |
| Live Unity Test Runner, domain reload, input and rendered-capture checks | **Unverified**: the isolated editor could not connect to `LicenseClient-inno`, even after the user confirmed an active license; no test results were produced |
| Three fresh runner generations with multiple seeds | **Not run**; no generated-game acceptance claim |
| Before/after hosted-model evaluation | **Not run**: the evaluation process has no `DEV_JWT`; no credentials were read from local secret files |
| Brand audit | Existing baseline mismatch reproduced at HEAD; baseline unchanged |

The first IntelliSense attempt used the older globally installed csharp-ls 0.22.0
and failed. Fetching the pinned, checksum-verified packages and running the probe
with `UNITYIDE_CSHARP_LS_DLL` and the actual `DOTNET_ROOT` resolved it without an
IntelliSense code change. The successful full verification explicitly required
the Unity-project, IntelliSense, ACP and debugger probes; no skipped probe was
counted as passing.

The isolated Unity fixture was `/private/tmp/unityide-automation-fixture`; its
stalled editor process was stopped without closing any other Unity project.
Remaining acceptance work is to run the live Unity fixtures, execute the runner
generation/seed matrix and the same-model before/after evaluations, then tune
against those results. Default enablement must wait for that evidence.
