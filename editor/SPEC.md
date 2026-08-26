# Unity IDE — Feature Specification & Implementation Prompt

> **How to use this document:** This is a master specification written as an implementation prompt for Claude Code. Each feature section is self-contained — you can paste an individual section into Claude Code as a task, or reference this whole file in your repo (e.g. `SPEC.md`) and ask Claude Code to implement features by ID (e.g. "Implement F-3.2 per SPEC.md"). Sections include behavior requirements, technical guidance, and acceptance criteria so Claude Code can verify its own work.

> 🟢 **RESUMING THIS PROJECT? START AT [§0.5 IMPLEMENTATION STATUS](#05-implementation-status-read-before-implementing-anything).** Much of this spec is already built (most of P0). §0.5 flags every feature ✅/🟡/⏳ with commits, file locations, the architecture decisions already locked in, and the recommended order for the remaining work. Read it before implementing anything so you don't rebuild what exists or contradict committed decisions.

---

## 0. Context & Architecture Constraints (read first, applies to every task)

You are working on an AI-powered IDE purpose-built for Unity developers.

**Stack:**
- **Shell:** Tauri (Rust backend, system webview frontend)
- **Editor:** Monaco
- **Frontend:** TypeScript (assume React unless the repo says otherwise)
- **Backend services:** Rust (Tauri commands + long-running sidecar processes where needed)

**Hard rules for all implementations:**
1. Heavy work (file indexing, YAML parsing, process management, debugger protocol, LSP proxying) lives in the **Rust backend**, never in the webview. The webview receives results over Tauri events/commands.
2. Never block the UI thread. All Rust commands that can take >50ms must be async and report progress via events.
3. The IDE must remain fully functional as a plain C# editor when **no Unity Editor is running** and when **no Unity Editor Bridge package is installed**. Every Unity-Editor-dependent feature must degrade gracefully with a clear, non-nagging UI state ("Unity Editor not connected — [Install bridge] [Docs]").
4. Unity regenerates `.csproj` and `.sln` files at will. **Never write to Unity-generated files.** Treat them as read-only build artifacts; watch them for changes instead.
5. All file watching must be debounced and must ignore `Library/`, `Temp/`, `Obj/`, `Build/`, `Logs/`, and `UserSettings/` by default.
6. Cross-platform from day one: Windows + macOS are P0, Linux is P1. Any path handling goes through a shared utility; no hardcoded separators.
7. Every feature ships with a settings entry to disable it. Unity devs are opinionated; respect that.

**Priority legend:** P0 = launch blocker, P1 = fast-follow, P2 = differentiator/backlog.

---

## 0.5 IMPLEMENTATION STATUS (read before implementing anything)

> Added 2026-06-14 to hand off to a fresh session. Status legend: ✅ **done** (committed, builds green) · 🟡 **partial** (backend or core done, wiring/UI missing) · ⏳ **not started**. Every ✅/🟡 item below builds clean (`bun run build`, `bun run check:modules`, `cargo test` — 31 Rust tests pass). Commit hashes are on branch `master`. A detailed task-level log lives at `~/.claude/plans/context-ref-file-users-inno-documents-e-humming-waffle.md`.

### Architecture decisions already made (DO NOT relitigate — match these)
- **Bridge transport is a Unix domain socket, NOT a WebSocket.** Socket path resolved via discovery file `<project>/Library/UnityIDE/bridge.json` (`{socketPath, protocolVersion, ideVersion, idePid}`); frames are **4-byte big-endian length prefix + UTF-8 JSON**, 16 MB cap. RPC is request/response-correlated by `id` through the `unity_ipc_request` Tauri command (10 s timeout). Rust: `src-tauri/src/unity_ipc.rs`. *(Windows named-pipe/TCP transport + per-connection auth token are deferred — flagged in code.)*
- **The Unity bridge C# code is part of the single Unity extension package**, which lives at `arcane-extension/` in the repo root (`com.unityide.editor`, Editor-only) — the single source of truth. It merges the live socket bridge (`UnityIDE.Bridge`) with the external-code-editor integration (`UnityIDE.Editor`: External Tools registration, double-click open, `.sln`/`.csproj` generation). `scripts/sync-unity-bridge.mjs` copies it into a gitignored `unity-bridge/` staging folder before every `tauri dev`/`build` (wired via `beforeDevCommand`/`beforeBuildCommand`); Tauri bundles that as a resource and `unity_install_bridge` installs it into `<project>/Packages/com.unityide.editor/` (embedded package; no manifest.json surgery). It has NOT been run against a live Unity Editor yet — see "live validation" below.
- **Analyzers are a TypeScript layer**, not Roslyn analyzers (spec §F-2.4 permits this fallback). Feature: `src/features/unity-analyzers/`. Monaco marker owner `'unity-analyzer'`.
- **Multi-source diagnostics**: `useUiStore.setFileDiagnostics(uri, source, items)` with sources `lsp | unity-analyzer | unity-compiler | asmdef | unity-packages`; read-time dedup drops `unity-compiler` items on a line that also has an `lsp` item. (`src/stores/ui.ts`)
- **Debugger = DAP via the external `vscode-mono-debug` adapter** (needs system Mono to run the adapter; Unity's own soft-debugger agent is the debuggee). Native-Rust soft-debugger client and self-contained adapter were considered and **deferred**. Rust host: `src-tauri/src/dap.rs`.
- **Every feature has a `unity.*` disable setting** already in `src/stores/settings.ts` + `src/types/index.ts` + Settings UI.
- **New feature modules added** (deep-modules; each has an `index.ts` barrel): `unity-bridge`, `unity-analyzers`, `asmdef`, `unity-packages`, `debugger`. New stores: `asmdef`, `unity-index`, `debug`. New Rust modules: `asmdef.rs`, `unity_yaml.rs`, `unity_index.rs`, `dap.rs`.

### Per-feature status
| Feature | Status | Notes / where |
|---|---|---|
| **F-1.1** detection + Hub editor resolve | ✅ | `unity.rs` `detect_unity_project` (+ nested depth-1/2), `resolve_unity_editor` (Hub json + default paths + UnityYAMLMerge path); `stores/project-context.ts`. |
| **F-1.2** asmdef graph + missing-ref quick-fix | ✅ | `src-tauri/src/asmdef.rs` (graph + owning-assembly implicit rules, 8 tests); `src/features/asmdef/`; StatusBar owning-assembly. Missing-ref diagnostic is a **v1 heuristic keyed off LSP CS0246** (conservative single-candidate) — needs live csharp-ls tuning. |
| **F-1.3** package manifest intelligence | ✅ | `src/features/unity-packages/` (manifest completion/hover, newer-version hints, PackageCache read-only banner). Registry index is a **static seed list** (`data/common-packages.ts`); `unity_fetch_registry_index` is best-effort cache-only (no HTTP dep added). Go-to-def into package source = the read-only PackageCache open path. |
| **F-1.4** generated solution / hot-reload | 🟡 | IDE generates its own `.unityide.csproj`/`.sln` for csharp-ls (`unity_setup_lsp`); on `.cs` add/remove it regenerates + sends `didChangeWatchedFiles`. **`didChangeWatchedFiles` efficacy unverified with live csharp-ls** (fallback = targeted restart, documented in `workspace.ts`). Bridge `generateSolution` RPC exists. |
| **F-2.1** LSP integration | ✅ | Pre-existing csharp-ls/pyright/ts via `lsp.rs`; **added** rename provider + `applyLspWorkspaceEdit` (open/closed files) + `workspace/applyEdit` handler + code-action registry (`src/features/lsp/services/{rename-provider,workspace-edit,code-actions}.ts`). csharp-ls rename quality needs live check. |
| **F-2.2** lifecycle/message awareness | ✅ | Lifecycle DB + gutter (pre-existing); **near-miss message diagnostics** (casing/params/static) + unused-suppression in `unity-analyzers`. CS-code suppression list needs live csharp-ls confirm. |
| **F-2.3** serialization-aware editing | ✅ | `[FormerlySerializedAs]` rename post-processor + non-serializable `[SerializeField]` diagnostics (`unity-analyzers/services/fsa-rename.ts`, `rules/non-serializable-types.ts`). |
| **F-2.4** Unity static analysis | ✅ | 13 rules + quick-fixes in `unity-analyzers/rules/`; fixtures at `fixtures/analyzers/*.cs`. Heuristic/conservative by design. |
| **F-2.5** code-gen templates | ✅ | Generators (`csharp/data/templates.ts`) + **NewScriptModal** (template picker, validated class name, asmdef `rootNamespace` default, target-type for editor kinds), explorer "New C# Script…" menu, "Unity: New C# Script…" palette verb, and class↔file rename-sync (offer on `.cs` rename, GUID-preserved note). `csharp/components/NewScriptModal.tsx`, `csharp/services/class-rename-sync.ts`. |
| **F-3.1** ShaderLab + HLSL | ✅ | Monarch highlighting (pre-existing) + completions + `#include` go-to-def (relative / `Packages/` / PackageCache / built-in CGIncludes) in `src/features/shader-languages/`. P2 live shader-error feed not done. |
| **F-3.2** Unity YAML assets | ✅ | Rust parser (`unity_yaml.rs`) + **structured AssetViewer** (`unity-asset-viewer/`): GameObject→component→property tree, clickable `{guid}` refs via the index, "View Raw"/"Edit Raw" (warned) toggle wired into EditorPanel; **`.uxml`/`.uss`** map to Monaco css/xml + Unity completions (`uitoolkit/`); **`.inputactions`** structured action-map viewer (`InputActionsViewer`). |
| **F-4.1** bridge transport & lifecycle | ✅* | Full C# package + Rust Unix-socket server + discovery + protocol-version check + reconnect/backoff + domain-reload survival + `unity_install_bridge`. *Unix socket not WebSocket; no auth token; MCP-server abstraction not done. **NOT live-validated against Unity.** |
| **F-4.2** console stream | ✅ | Console streaming + clickable traces (pre-existing) **+ compile errors → Problems panel + inline markers** as `unity-compiler` diagnostics (`unity-compiler/`, from the C#-already-emitted `compilation_finished.messages`; read-time dedup vs LSP). |
| **F-4.3** engine state & scene context | ✅ | RPC handlers + wrappers (pre-existing) **+ live Hierarchy panel UI** (`unity-hierarchy/`, left SidebarView) backed by the shared `useUnitySceneStore` (subscribes to hierarchy/selection change events); component→script jump. Live populate is live-validation debt. |
| **F-4.4** editor commands | ✅ | play/pause/step/stop + `refreshAssets/generateSolution/executeMenuItem/openAsset/focusUnity/setExternalScriptEditor` + **auto-`refreshAssets`-on-`.cs`-save** (`unity-bridge/services/refresh-on-save.ts`, gated `unity.bridge.refreshOnSave`). |
| **F-4.5** play-mode telemetry (P2) | ✅* | Opt-in (`unity.telemetry.enabled`) FPS/memory/GC status-bar strip + sparkline (`unity-telemetry/`), fed by C# `PlayModeStatsHook` (outbound-only, ≤4Hz while playing) → Rust `unity-playmode-stats`. *Live stream NOT validated. |
| **F-5.1** context assembly | ✅ | `ai-panel/services/prompts/unity-facts.ts` (version, pipeline, input system, packages, owning asmdef, `.ai/unity-rules.md`) injected into all modes. |
| **F-5.2** agent tools | ✅ | `ai-panel/services/unity-tools/` — read: `get_console_errors` (local log ring, offline), `get_editor_state/get_scene_hierarchy/get_game_object`, `find_asset_references` (offline index + live), `get_unity_docs` (version-matched, `data/unity-docs-index.ts`); engine-mutate: `unity_play/stop/refresh/run_tests/execute_menu_item`. Registered in `createToolsForPromptMode` (Unity-only; mutate only in agent modes). Live tools = live-validation debt. |
| **F-5.3** generation policy | ✅ | Prompts (pre-existing) **+ analyzer-gate**: `withUnityAnalyzerGate` wraps write/edit on `.cs`, appends error-severity `runAnalyzersOnText` findings to the tool result so the agent self-corrects. |
| **F-5.4** "Fix this console error" | ✅ | "Fix" button on console error rows → `fix-console-error.ts` assembles error + stack→code-regions, nudges checking unassigned serialized fields via tools, drives the agent. |
| **F-5.5** scene-aware chat (@mentions) | ✅ | MentionPopover "UNITY CONTEXT": `@scene/@selection/@hierarchy/@console` + live object-name picking (`@object`), resolved at send-time in `attachments.ts` against `useUnitySceneStore`/bridge/index. `@console` + static paths offline. |
| **F-5.6** safety & approval | ✅ | Engine-mutate tools block on per-action inline approval (`approval-gate.ts`, reuses `useAiStore` permission requests; sequential loop ⇒ never batched). `PermissionRequestBlock` routes to Claude(ACP)/UnityIDE by `selectedAgent`. |
| **F-6.1** GUID index | ✅ | `unity_index.rs` (guid↔path + reverse-ref + meta-hygiene + incremental delta, tests) + `resolveGuid` forward cache. Meta-pairing rename/delete pre-exists; **typed-confirm for lone-`.meta` delete** now wired (`explorer/components/TypedConfirmDialog.tsx`). |
| **F-6.2** find usages in assets | ✅ | `SceneUsagePanel` re-backed by index + "Used in N prefabs, M scenes" CodeLens. Works Unity-closed. |
| **F-6.3** safe-delete (P2) | ✅ | `ImpactDeleteDialog`: deleting a referenced asset/script first shows its blast radius (scenes/prefabs referencing it, via the offline index) before confirming. Lone-`.meta` typed-confirm takes precedence. Works Unity-closed. |
| **F-7.1** attach to Unity Editor | ✅* | **Full debugger**: `dap.rs` host + DAP client + debug store (breakpoints persisted, attach/attach+play, step, stack, scopes/vars, watch) + breakpoint gutter + debug UI panels (`src/features/debugger/`). Unity-aware value rendering. Graceful degradation hardened. *Uses external mono-debug adapter (needs Mono); **NOT live-validated** (no Mono/adapter/Unity in build env). Adapter not vendored — `find_adapter` also picks up a system VS Code "Mono Debug" extension; see `scripts/fetch-mono-debug.ts`. |
| **F-7.2** players & tests (P1/P2) | ⏳ | Not started. |
| **F-8** test runner | ✅* | `unity_tests.rs` discovery (asmdef-based, cargo tests) + headless `-runTests` + NUnit3 parser (tested); C# `TestRunnerHandlers` (`TestRunnerApi` streaming via `test_event`, asmdef versionDefine-guarded); `unity-test-runner/` panel + Run/Debug CodeLens + `useTestStore` (one event path live+headless); "Run All Tests" verb. *TestRunnerApi streaming + the `-batchmode` run NOT live-validated. |
| **F-9** Unity-aware git | ✅* | Backend (pre-existing) **+ frontend** (`git/`): SCM "Merge Conflicts" section with UnityYAMLMerge + ours/theirs resolve, meta-pairing commit-block (`unity-git.ts`), `.gitignore` doctor on Unity-repo open. *UnityYAMLMerge CLI not live-validated. |
| **F-10** Unity-native UX | 🟡 | Status-bar cluster + attach-debugger (pre-existing). **Now done**: compile-feedback-on-save (F-4.2), Assets-first explorer + `.meta` hiding (`explorer/services/unity-tree-view.ts`), palette verbs (Show Hierarchy/Open Scene/Find Asset/Run All Tests/New Script), version-matched docs-on-hover (T10.2, `editor/services/unity-docs-hover.ts`). **Remaining: external-editor registration + `unityide://` deep link (T10.1 — needs a Tauri deep-link plugin + packaged build; only meaningfully testable when installed).** |
| **F-11** performance/scale | 🟡 | Addressed by design (Rust index background+persisted, console 10k ring buffer, 10 s bridge-call timeouts, virtualized trees) but **not load-tested at 10k-file scale**. |

### ⚠️ Live-validation debt (cannot be tested in a headless build env — needs a real Unity install + machine with Mono/.NET)
1. **C# bridge** end-to-end: `UnixDomainSocketEndPoint` under the project's .NET API compatibility level (needs .NET Standard 2.1), `log_batch` rendering (the C# sends a **bare array** to match the frontend listener), domain-reload survival, RPC round-trips.
2. **Debugger** (F-7.1): the whole breakpoint→hit→step→inspect loop, and breakpoint rebinding across domain reloads. Needs `brew install mono` + a vendored/extension `mono-debug` adapter + a running Unity Editor.
3. **`didChangeWatchedFiles`** (F-1.4) efficacy with live csharp-ls.
4. **Analyzer CS-code suppression** (F-2.2) exact Roslyn `code` values.
5. **UnityYAMLMerge** CLI invocation (F-9) against a real editor install.
6. **AI Unity tools** (F-5.2/5.4/5.5) live-bridge tools + `@scene`/`@object` resolution + the analyzer-gate against a real agent run.
7. **Test runner** (F-8): TestRunnerApi streaming (`test_event` round-trip) + the `Unity -batchmode -runTests` headless run (needs an editor install; PlayMode needs a graphics device).
8. **Compile feedback** (F-4.2): the `compilation_finished.messages` → Problems mapping against real compiler output, and auto-refresh-on-save round-trip.

> **2026-06-14 update:** every ✅ above **builds green** (`bun run build`, `bun run check:modules`, `cargo test` — 38 Rust tests). The C# bridge additions compile by inspection only. Of the remaining-work list, only **F-2.5, F-3.2, F-4.2, F-4.3, F-4.4, F-5.2–5.6, F-6.1-confirm, F-6.3, F-8, F-9, F-10-core, T10.2, F-4.5, `.inputactions`** are done; the rest below is *live-validation* debt (a real Unity install + Mono machine) or P1/P2 items needing infrastructure this env lacks — not unbuilt logic.

### Recommended order to finish (remaining work)
1. **Live-validation pass** on a real Unity + Mono machine — work the debt list above; this is now the bulk of what's left.
2. **F-10 T10.1** external-editor registration + `unityide://` deep link — the one remaining buildable feature; needs a Tauri deep-link plugin + OS scheme registration that only functions in a packaged/installed build (not testable headlessly), so it was deferred.
3. **F-7.2** player/mobile debugging (P2) — needs live dev players + multicast discovery.
4. **F-11** load-test at the 10k-file scale.

---

## 1. Unity Project Model (P0)

The foundation everything else builds on. The IDE must understand "a Unity project" as a first-class concept, not just a folder of files.

### F-1.1 Unity project detection
- On opening a folder, detect a Unity project by the presence of `ProjectSettings/ProjectVersion.txt` + `Assets/` + `Packages/manifest.json`.
- Parse `ProjectVersion.txt` to get the exact Unity version (e.g. `6000.0.32f1`) and display it in the status bar.
- Support opening a parent folder that contains the Unity project one level down (common in repos: `repo/MyGame/Assets/...`). Detect and offer to "focus" the Unity project root.
- Resolve the matching Unity Editor installation on disk: check Unity Hub's `editors.json` / default install paths per OS (`C:\Program Files\Unity\Hub\Editor\<version>` on Windows, `/Applications/Unity/Hub/Editor/<version>` on macOS). Expose the resolved editor path to other subsystems (debugger, "Open in Unity" command, bridge installer).
- **Acceptance:** Opening a Unity project shows the Unity version in the status bar within 2 seconds; opening a non-Unity folder shows no Unity UI at all.

### F-1.2 Assembly definition (asmdef) awareness
- Index all `.asmdef` and `.asmref` files. Build an in-memory graph: assembly name → root folder → references → defineConstraints → platform includes/excludes.
- Every C# file in `Assets/` or `Packages/` must be resolvable to its owning assembly (nearest ancestor asmdef; fallback to the implicit `Assembly-CSharp` / `Assembly-CSharp-Editor` rules, including the `Editor/` special-folder rule and `Assembly-CSharp-firstpass` for `Plugins/`).
- Show the owning assembly in the breadcrumb/status bar for the active file.
- Diagnostics: warn inline when a file references a type from an assembly that its asmdef does not reference ("Type `X` lives in assembly `Foo.Runtime`, which is not referenced by `Game.Core.asmdef` — add reference?"), with a quick-fix that edits the asmdef JSON.
- **Acceptance:** Clicking a C# file under a custom asmdef shows the right assembly name; the missing-reference quick-fix produces a valid asmdef edit that Unity accepts without errors on recompile.

### F-1.3 Package manifest intelligence
- Treat `Packages/manifest.json` and `Packages/packages-lock.json` as known schemas: completion for registry package names/versions (use a cached index of the Unity registry; refresh in background), hover docs showing the package's description, inline "newer version available" hints.
- Resolve embedded packages (`Packages/<name>/`), local `file:` packages, and git URL packages so their source participates in indexing and navigation.
- **Acceptance:** Typing `"com.unity.` inside manifest.json offers completions; go-to-definition works into package source under `Library/PackageCache/` (opened read-only with a banner: "Package cache file — read-only. [Embed package to edit]").

### F-1.4 Generated solution/project handling
- Watch `*.csproj`/`*.sln` at the project root. On change, hot-reload the language service's project model without a full restart (see F-2).
- If solution files don't exist yet (fresh clone), surface a one-click action: "Generate project files" — which either (a) instructs the connected Unity Editor via the bridge (preferred, see F-4), or (b) launches Unity headless with `-batchmode -quit -executeMethod` and a tiny bundled script, or (c) explains the user must open Unity once. Never attempt to hand-write csproj files.
- **Acceptance:** Adding a new C# file in Unity (which regenerates csproj) results in working IntelliSense for that file in the IDE within a few seconds, with no manual reload.

---

## 2. C# Language Intelligence, Unity-flavored (P0)

### F-2.1 Language server integration
- Integrate a C# LSP as a sidecar process managed by the Rust backend. Recommended: **Roslyn-based `csharp-language-server` / OmniSharp** — verify the license of whatever is bundled (the Microsoft C# Dev Kit and its Roslyn LSP distribution are license-restricted to VS Code; do **not** bundle those binaries). Architect behind a trait/interface so the LSP can be swapped.
- Point the LSP at Unity's generated `.sln`. Wire full LSP lifecycle: diagnostics, completion, hover, signature help, go-to-def, find-references, rename, code actions, semantic tokens into Monaco (Monaco does not speak LSP natively — implement or adopt a monaco-languageclient bridge; keep the transport in Rust, not a browser websocket to a public port).
- Handle Unity's constant csproj regeneration: debounce reloads, preserve open-document state, never show a "project reloading" modal — a subtle status-bar spinner only.
- **Acceptance:** Completion latency <100ms p50 on a mid-size project; rename across assemblies works; no LSP restart needed across a Unity script recompile.

### F-2.2 Unity lifecycle & message awareness
- Recognize classes deriving from `MonoBehaviour`, `ScriptableObject`, `Editor`, `EditorWindow`, `StateMachineBehaviour`, etc. (resolve via semantic info from the LSP, not regex).
- For Unity message methods (`Awake`, `Start`, `Update`, `FixedUpdate`, `OnEnable`, `OnDisable`, `OnDestroy`, `OnCollisionEnter`, `OnTriggerEnter2D`, the full set per Unity version):
  - **Gutter icon** marking recognized Unity messages, with hover docs (link to Unity docs for the project's Unity version).
  - **Completion:** typing inside a MonoBehaviour offers a "Unity Messages" completion group that generates the full correct signature (e.g. `private void OnCollisionEnter(Collision collision)`), including the right parameter types for 2D vs 3D variants.
  - **Diagnostics:** warn on near-miss signatures Unity will silently never call — wrong casing (`update`), wrong parameters (`OnCollisionEnter(Collider c)`), accidentally `static`. This single feature prevents one of the most common silent Unity bugs; treat it as a flagship diagnostic.
- Suppress "method is never used" style dead-code hints for Unity messages and for fields marked `[SerializeField]` (they're invoked/assigned by the engine).
- **Acceptance:** Typing `void OnTriggerEnt` inside a MonoBehaviour completes to the correct full signature; `private void Updat()` produces no warning but `private void update()` produces "Did you mean `Update`? Unity messages are case-sensitive."

### F-2.3 Serialization-aware editing
- Understand Unity serialization rules: public fields and `[SerializeField]` privates on serializable types are serialized; properties, statics, and `[NonSerialized]` are not.
- **Rename protection (flagship feature):** when the user renames a serialized field, automatically offer/apply `[FormerlySerializedAs("oldName")]` (adding the `UnityEngine.Serialization` using). Without this, renames silently wipe inspector-assigned data across every scene and prefab. Make this the default behavior of LSP rename on serialized fields, with a setting to disable.
  - Bonus (P1): after the rename, scan scene/prefab YAML (see F-6) and report how many serialized references exist, so the user understands the blast radius.
- Diagnostics: "field is `[SerializeField]` but the type is not serializable by Unity" (e.g. `Dictionary<,>`, properties, interfaces without `[SerializeReference]`); suggest `[SerializeReference]` where applicable.
- **Acceptance:** Renaming `[SerializeField] private float speed;` to `moveSpeed` produces `[FormerlySerializedAs("speed")]` automatically.

### F-2.4 Unity-specific static analysis (custom diagnostics + quick-fixes)
Implement as an analyzer layer (Roslyn analyzers loaded into the LSP if feasible; otherwise a Rust/TS post-pass on semantic tokens — prefer Roslyn analyzers, and consider bundling **Microsoft.Unity.Analyzers**, which is MIT-licensed, as the base set, then extend). Each rule: severity configurable, quick-fix where stated, all documented in a rules reference page.

Performance rules (the headline set):
- `GetComponent`/`GetComponents`/`Find`/`FindObjectOfType` called inside `Update`/`FixedUpdate`/`LateUpdate`/`OnGUI` → warn; quick-fix: hoist to a cached field assigned in `Awake`.
- `Camera.main` in hot paths (older Unity versions) → suggest caching (skip for Unity versions where it's cached internally — gate rules on project Unity version).
- String-based APIs: `Invoke("MethodName", …)`, `SendMessage`, `StartCoroutine("Name")`, `Animator.SetFloat("Speed", …)` → suggest `nameof()`/cached `Animator.StringToHash` (quick-fix generates the static readonly hash field).
- Allocation hints in hot paths: LINQ, `string` concatenation in loops, `new` of reference types, boxing, `params` calls, `foreach` over non-struct enumerators inside Update-family methods → info-level squiggle with explanation ("allocates each frame → GC pressure").
- Empty Unity message methods (`void Update() { }`) → warn "empty Unity messages still incur engine call overhead; remove."
- Coroutine `yield return new WaitForSeconds(x)` in loops → suggest caching the `WaitForSeconds` instance.

Correctness rules:
- `== null` patterns on `UnityEngine.Object` vs C# null-conditional: warn on `?.` / `??` / `is null` applied to UnityEngine.Object-derived types (these bypass Unity's overloaded lifetime check); quick-fix to explicit comparison. Severity default: warning, with docs explaining destroyed-object semantics.
- `Destroy(this)` vs `Destroy(gameObject)` confusion → info hint explaining the difference.
- Instantiating prefabs without parenting/position overloads in UI contexts → info.
- `Time.deltaTime` inside `FixedUpdate` (suggest `Time.fixedDeltaTime`) and vice versa → warn.
- Setting `transform.position` in a loop per-axis (3 property hits) → suggest single assignment.
- Editor-only API (`UnityEditor.*`) referenced from runtime assembly → error before Unity even compiles, with quick-fix to wrap in `#if UNITY_EDITOR` or move to an Editor assembly.

**Acceptance:** Each rule has a test fixture project file demonstrating trigger + non-trigger cases; quick-fixes produce compiling code.

### F-2.5 Code generation templates (Unity-correct "new file" flow)
- "New C# Script" creates a file whose **class name matches the file name** (Unity requirement for MonoBehaviours) and offers templates: MonoBehaviour, ScriptableObject (with `[CreateAssetMenu]` scaffold), Editor (custom inspector scaffold targeting a chosen type), EditorWindow, PropertyDrawer, plain class, interface, struct, Unity Test (PlayMode/EditMode).
- Renaming a file containing a matching MonoBehaviour class offers to rename the class in sync (and vice versa), and warns that the `.meta` GUID is what preserves references (see F-6.1) so the rename is safe as long as the meta file moves with it.
- Templates respect the project's `.editorconfig` and root namespace settings from asmdef (`rootNamespace`).
- **Acceptance:** New MonoBehaviour from template compiles in Unity with zero edits and lands in the correct namespace per its asmdef.

---

## 3. Shader & Unity File-Format Support (P1)

### F-3.1 ShaderLab + HLSL
- Syntax highlighting, folding, and bracket matching for `.shader` (ShaderLab), `.hlsl`, `.cginc`, `.compute`. Monarch grammar or TextMate grammar via a Monaco tokenizer — pick one and document it.
- Completion for ShaderLab structure keywords (`Properties`, `SubShader`, `Pass`, `Tags`, common tag values like `"RenderType"`, `"Queue"`), HLSL intrinsics, and common Unity shader includes/macros (`UnityCG.cginc`, URP's `Core.hlsl`, `TEXTURE2D`, `SAMPLE_TEXTURE2D`).
- Resolve `#include` paths including Unity package paths (`Packages/com.unity.render-pipelines.universal/...`) for go-to-definition.
- P2: live error feed — when the Unity Editor bridge is connected, surface shader compile errors from the Editor console mapped back to file/line.
- **Acceptance:** Opening a URP shader gives highlighted, navigable code; `#include "Packages/..."` is clickable.

### F-3.2 Unity YAML assets (scenes, prefabs, assets, meta)
- Recognize `.unity`, `.prefab`, `.asset`, `.meta`, `.anim`, `.controller`, `.mat` as **Unity YAML** with custom highlighting (Unity's YAML has non-standard multi-document `--- !u!<classId> &<fileId>` headers and sometimes `stripped` markers — a vanilla YAML parser will choke; the parser must be lenient).
- Implement a Rust-side Unity YAML parser producing a structured model: documents → classId, fileId, properties; resolve `{fileID: X, guid: Y, type: Z}` references via the GUID index (F-6.1).
- Default UX: opening a scene/prefab shows a **structured read-only viewer** (hierarchy tree of GameObjects → components → serialized properties, references rendered as clickable links to scripts/assets) with a "View raw YAML" toggle. Editing raw scene YAML by hand is a footgun; allow it but behind an explicit "Edit raw" action with a warning.
- `.uxml` / `.uss` (UI Toolkit): XML/CSS-derived highlighting and completion for known UI Toolkit elements and USS properties.
- **Input System `.inputactions`**: render as structured JSON viewer with action-map summary (P2).
- **Acceptance:** Opening a `.prefab` shows its GameObject hierarchy with component names resolved from GUIDs to script class names; clicking a script reference opens the `.cs` file.

---

## 4. Unity Editor Bridge (P0 — the differentiating subsystem)

A two-part system: a **Unity package** (`com.<yourcompany>.bridge`) installed in the user's project, and a **Rust-side client** in the IDE. This is what elevates the product from "Monaco with AI" to "an IDE that can see the engine."

### F-4.1 Transport & lifecycle
- The Unity package opens a localhost WebSocket server (loopback only, random port) and writes a discovery file (`Library/<YourIDE>/bridge.json`: port + auth token + Unity PID + project path). The IDE watches for this file and connects automatically. Token required on every connection; regenerate per Editor session.
- Survive domain reloads: the bridge must re-establish its server after Unity's domain reload (use `[InitializeOnLoad]` + serialized session state) and the IDE client must auto-reconnect with backoff. Surface bridge state in the status bar: Connected / Unity open but bridge reloading / Not connected.
- Versioned JSON-RPC style protocol. The IDE refuses mismatched major versions and offers "Update bridge package."
- One-click install: IDE writes the package into `Packages/manifest.json` as a scoped/git/local dependency (user choice) and instructs the user to refocus Unity. Detect and support the case where the user instead/also uses **Unity's official MCP server** — abstract the bridge client behind a trait so both transports can back the same features where capabilities overlap.
- **Acceptance:** Kill Unity, reopen it → IDE reconnects within 5s of Unity finishing load, no user action. Two Unity projects open simultaneously → IDE connects to the one matching the open workspace.

### F-4.2 Console stream (P0)
- Stream Unity console entries (log/warning/error/exception, message, stack trace, timestamp, frame count if playing) into a dedicated **Unity Console panel** in the IDE.
- Stack-trace lines are parsed and clickable → jump to file:line. Collapse duplicates with a count, filter by severity/text, "errors only while playing" toggle, clear-on-play (respect Unity's own setting).
- Compile errors get special treatment: shown in the Problems panel *and* as inline diagnostics in the relevant files, deduplicated against LSP diagnostics where they overlap (prefer the LSP's richer version; show Unity's only if the LSP missed it — e.g. Unity-version-specific define differences).
- **Acceptance:** A `Debug.LogError` in play mode appears in the IDE in <300ms with a clickable stack trace.

### F-4.3 Engine state & scene context (P0)
Bridge RPCs the IDE (and the AI agent, F-5) can call:
- `getEditorState` → playing/paused/compiling/version, active scene list.
- `getSceneHierarchy(sceneOrPrefab)` → GameObject tree (name, active, tag, layer, components by type, instance IDs).
- `getGameObject(idOrPath)` → full component list with serialized property values (respect a payload cap; paginate large objects).
- `getSelection` → what's selected in the Editor right now.
- `findReferencesToScript(guid)` → which loaded GameObjects use this MonoBehaviour.
- `getProjectAssets(query)` → asset search (name/type/label) without filesystem scanning.
- UI: a **Hierarchy panel** in the IDE mirroring the live Editor hierarchy (read-only tree, refresh + live-update via change events). Clicking a MonoBehaviour component jumps to its script; right-click → "Ask AI about this object."
- **Acceptance:** With a scene open in Unity, the IDE hierarchy panel matches it; selecting an object in Unity highlights it in the IDE panel within 500ms.

### F-4.4 Editor commands (P0/P1)
- P0: `play`, `pause`, `step`, `stop`; `refreshAssets` (trigger recompile/asset import after external file changes — call automatically after IDE saves a `.cs` file if Unity is connected, configurable); `generateSolution`; `runTests` (see F-8).
- P1: `executeMenuItem(path)` (with an allowlist + confirmation UX); `openAsset(guid)` in Unity; `focusUnity`.
- Destructive or scene-mutating operations require explicit per-action user confirmation in the IDE — the AI agent must never call mutating bridge RPCs without a visible approval step (see F-5.6).
- **Acceptance:** Pressing the IDE's Play button enters play mode in Unity; saving a script triggers Unity recompile and the IDE shows "Compiling…" then surfaces any compile errors.

### F-4.5 Play-mode telemetry (P2)
- Lightweight stats stream while playing: FPS, frame time, total allocated/reserved memory, GC collections per interval, draw calls/batches if cheaply available. Render as a compact sparkline strip in the status bar with a detail popover. Strictly opt-in and throttled (≤ 4Hz) to avoid taxing the Editor.

---

## 5. AI Agent — Unity-grounded behavior (P0)

The agent must be *measurably better at Unity tasks than generic Cursor/Copilot*, and the mechanism is **context + tools**, not prompt vibes. (Model choice/inference plumbing is out of scope here; this section defines the Unity-specific behavior contract.)

### F-5.1 Context assembly rules
For every agent request, the context builder includes (budget-permitting, in priority order):
1. Active file + selection, plus semantic neighbors (types referenced in the selection, resolved via LSP).
2. **Unity project facts header** (always): Unity version, render pipeline (detect URP/HDRP/Built-in from packages + quality settings), input system (new/legacy/both, from player settings), scripting backend if known, key packages + versions (Netcode, Addressables, DOTS/Entities, Cinemachine, etc.), target platforms.
3. Owning asmdef and its references (so the agent doesn't suggest APIs from unreferenced assemblies).
4. If bridge connected and the request plausibly concerns runtime behavior: editor state, selection, recent console errors (last N, deduped), and on-demand hierarchy/object data via tools (F-5.2).
5. Project conventions file: support a `.ai/unity-rules.md` (or similar) the user/team writes; always include it. Ship a good default template (naming, null-check style, coroutine vs UniTask vs Awaitable preference, etc.).

### F-5.2 Agent tools (function-calling surface)
Expose to the model, each with strict JSON schemas and the permission tiers from F-5.6:
- Read-only, auto-approved: `lsp_find_references`, `lsp_get_type_info`, `search_project(query, type)`, `read_file`, `get_console_errors`, `get_editor_state`, `get_scene_hierarchy`, `get_game_object`, `find_asset_references(guid)` (YAML index), `get_unity_docs(symbol)` — version-matched API doc lookup from a local docs index.
- Write, per-action approved: `edit_file` (diff-based), `create_file`, `edit_asmdef_reference`, `update_manifest_package`.
- Editor-mutating, per-action approved + bridge required: `unity_play/stop`, `unity_refresh`, `unity_run_tests`, `unity_execute_menu_item`.

### F-5.3 Unity-correct generation policy
Encode these as part of the agent's standing instructions and verify with eval fixtures:
- Match the project's Unity version and pipeline: no `Camera.main` advice that's version-wrong, no Built-in shader code for a URP project, no legacy `Input.GetAxis` when only the new Input System package is active (and vice versa).
- Generated MonoBehaviours: class name == intended file name; serialized tuning fields exposed via `[SerializeField] private` + `[Tooltip]` rather than public, unless project rules say otherwise; correct message signatures; no allocation-heavy patterns in Update-family methods (the agent must pass the F-2.4 analyzers on its own output — run analyzers on agent diffs before presenting, and auto-iterate once on violations).
- Asynchrony: prefer the project's established pattern (detect UniTask/Awaitable/coroutines from existing code) instead of imposing one.
- When the agent's change affects serialized fields, it must apply `[FormerlySerializedAs]` per F-2.3.
- When asked to create assets/components ("add a script to the Player object"), the agent does the C# part itself and uses bridge tools for the Editor part **only with approval**, otherwise it outputs precise manual steps.

### F-5.4 Flagship workflow: "Fix this console error" (P0)
One-click action on any console error/exception entry:
1. Agent receives the full entry + stack trace, resolves each frame to file/line, pulls those code regions.
2. If runtime exception and bridge connected: optionally fetch the involved GameObject's component/property state (e.g. for NullReference on a serialized field, check whether the field is actually unassigned in the scene — *this is the magic moment generic tools can't do*).
3. Distinguish code-level fixes (produce a diff) from scene/inspector-level fixes (produce instructions or an approved bridge action) from "both."
4. Output: root-cause explanation in 2–3 sentences, then the fix.
- **Acceptance (eval fixtures):** NullReference from unassigned `[SerializeField]` → agent identifies "the field is unassigned on object X in scene Y" rather than wrapping code in a null check. Case-typo'd `update()` → agent finds the silent-message bug.

### F-5.5 Flagship workflow: scene-aware chat (P0)
- `@scene`, `@selection`, `@hierarchy`, `@console`, `@object(name/path)` mentions in chat pull live bridge data into context. `@asset(name)` pulls YAML-derived structure for a prefab/ScriptableObject.
- "Why doesn't my character jump?"-class questions should trigger the agent to inspect: the relevant script, the object's actual component values (Rigidbody constraints, mass), input configuration, and console — and reason across them.

### F-5.6 Safety & approval model (P0)
- Three tiers: **read** (auto), **workspace write** (diff preview, per-file approve, batch-approve allowed), **engine mutate** (always individually approved, never batched, clearly labeled with what will happen in Unity).
- All agent actions logged to a session timeline panel with undo for workspace writes (use a shadow git stash/snapshot if the project isn't a git repo).
- Agent must refuse to edit `Library/`, `Temp/`, `.meta` GUID values, and Unity-generated csproj/sln.

---

## 6. Asset & Reference Intelligence (P1, with F-6.1 at P0)

### F-6.1 GUID index (P0 — many features depend on it)
- Rust-side persistent index mapping: GUID ↔ asset path (from `.meta` files) and reverse-reference map: which scenes/prefabs/assets/materials reference which GUIDs (from Unity YAML parsing, F-3.2). Incremental updates on file change; full rebuild only on first open or corruption. Store under `Library/<YourIDE>/index/` (gets ignored by VCS for free) with the project path + Unity version as cache keys.
- **Meta-file hygiene engine:** detect and warn on (a) asset without `.meta`, (b) orphan `.meta` without asset, (c) file operations performed in the IDE — **every rename/move/delete of an asset done through the IDE's file explorer must move/rename/delete the paired `.meta` identically and atomically.** This is non-negotiable; breaking it destroys references. Deleting a `.meta` independently requires a typed confirmation.
- **Acceptance:** Renaming `Player.cs` via the IDE explorer renames `Player.cs.meta` in the same operation; the GUID is unchanged; Unity picks it up with no lost references.

### F-6.2 "Find usages in assets" (P1)
- On any MonoBehaviour/ScriptableObject class (or any asset in the explorer): **Find Asset References** → lists every scene, prefab, and asset whose YAML references its GUID, with the GameObject path within each. Render in the references panel alongside code references ("Code (12) | Assets (7)").
- Inverse: a subtle CodeLens-style annotation on MonoBehaviour classes: "Used in 3 prefabs, 2 scenes" (click to list). Warn ("0 asset usages") is a P2 dead-asset hint, off by default.
- **Acceptance:** Works without Unity running (pure index); results match Unity's own reference behavior on the fixture project.

### F-6.3 Safe-delete & impact preview (P2)
- Deleting a script/asset shows impacted scenes/prefabs first ("This script is on 4 GameObjects across 2 scenes — deleting will leave Missing Script components").

---

## 7. Debugging (P0 — hard, ship in stages)

Unity's scripting runtime is debugged via the **Mono soft debugger protocol** (even on IL2CPP *players* there's a variant; scope to Editor debugging first). This is not netcoredbg/vsdbg territory — do not attempt to attach a CoreCLR debugger to the Unity Editor.

### F-7.1 Stage 1 — Attach to Unity Editor (P0)
- Implement (or port) a Mono Soft Debugger client. Reference implementations to study: Mono's `debugger-libs` (MIT), the VS Code Unity debugging lineage (`vscode-unity-debug` / MonoDevelop.Debugger.Soft). Recommended architecture: a sidecar process implementing the **Debug Adapter Protocol** that translates DAP ↔ Mono soft debugger wire protocol; the IDE frontend implements a DAP client UI. This keeps the debugger swappable and testable independent of the UI.
- Discovery: the Editor's debugger port is derived from the Unity process (56000 + pid%1000 historically) — but **prefer asking the bridge** (`getDebuggerEndpoint`) when connected; fall back to player-broadcast/port scan when not.
- P0 feature set: attach/detach, breakpoints (incl. conditional + hit count), step in/over/out, call stacks for all threads, locals/watch with Unity-type-aware rendering (Vector3 shown as `(x, y, z)`, Color swatch, GameObject shown by name with instanceID, UnityEngine.Object "null-but-not-null" destroyed state rendered honestly as `<destroyed>`), exception breakpoints (break on thrown/user-unhandled), `Debug.Log` continues streaming to the console panel while paused.
- Domain reload handling: breakpoints must survive Unity recompiles (rebind after reload; show "rebinding…" state).
- One-click flows: "Attach to Unity" (status bar button when bridge sees a Unity instance), "Attach and Play" (attach, then bridge-play).
- **Acceptance:** Set a breakpoint in `Update`, click Attach and Play → breakpoint hits; inspect a Vector3 local; step; recompile a script while attached → breakpoints still hit afterward.

### F-7.2 Stage 2 — Players & tests (P1/P2)
- P1: attach to development **PlayMode tests** runs (same Editor attach, coordinated with F-8 so "Debug test" works).
- P2: attach to local development builds/players (player connection discovery via multicast), incl. mobile over USB stretch goal.

---

## 8. Test Runner Integration (P1)

- Discover Unity Test Framework tests (EditMode + PlayMode) via source analysis (`[Test]`, `[UnityTest]`, asmdef test assemblies referencing `nunit.framework`).
- Run via bridge RPC wrapping `TestRunnerApi`; stream per-test progress and results into a Test panel (tree by assembly → fixture → test, with pass/fail/duration, failure message + stack with clickable frames).
- Gutter run/debug icons per test; "run tests in file/fixture"; re-run failed. CodeLens "Run | Debug" above test methods. Debug = attach (F-7) then run filtered.
- Headless fallback when Unity isn't open: offer to run via `Unity -batchmode -runTests -testResults <xml>` and parse the result XML (clearly slower; label it).
- **Acceptance:** Failing PlayMode test shows red in-gutter within the run; clicking the failure jumps to the assertion line.

---

## 9. Version Control, Unity-aware (P1)

- Built-in git support is assumed baseline; these are the Unity-specific layers:
- **Smart merge:** detect merge conflicts in `.unity`/`.prefab`/`.asset` and offer to resolve via Unity's bundled **UnityYAMLMerge** tool (resolve its path from the detected Editor installation); fall back to "pick ours/theirs" with the structured viewer (F-3.2) for context. Offer one-click setup writing the proper `[merge]` driver entries to the repo's git config + `.gitattributes`.
- **Meta-file pairing checks in the commit UI:** block-by-default warning when a commit includes an asset without its `.meta` (or vice versa), or deletes one half of a pair.
- `.gitignore` doctor: on first open of a Unity project repo, validate ignore rules against the canonical Unity gitignore (Library, Temp, Logs, UserSettings, csproj/sln, etc.); offer a fix-up diff. Detect large binary assets without Git LFS and suggest LFS patterns (P2).
- Diff view for Unity YAML uses the structured model where possible: show "Player prefab: `speed` 5 → 7 on component PlayerController" alongside raw text diff (P2 for the semantic diff; raw diff with Unity YAML highlighting is P1).
- **Acceptance:** A conflicted prefab can be resolved through UnityYAMLMerge from inside the IDE; committing `Foo.cs` without `Foo.cs.meta` triggers the warning.

---

## 10. Editor UX details that make it feel Unity-native (P1)

- **Status bar Unity cluster:** Unity version • bridge state • play state (with play/pause/stop micro-controls) • compile status • current platform target.
- **Compile-feedback loop:** on save of any `.cs`, if bridge connected, show "Unity compiling…" then either "✓" or jump-to-first-error affordance. Optional setting: auto-save + auto-refresh on focus loss (mirroring how devs alt-tab to Unity).
- **Open in Unity / Open in IDE round-trip:** register the IDE as Unity's external script editor (write the EditorPrefs/registration the way Rider/VS do, or via bridge), so double-clicking a script or console line in Unity opens the IDE at file:line via deep link (`youride://open?file=…&line=…` + a local listener). This is how Unity devs actually open their editor — without it, adoption dies.
- **Command palette verbs:** "Unity: Play", "Unity: Run All Tests", "Unity: Open Scene…", "Unity: Find Asset…", "Unity: Show Hierarchy", "Unity: Attach Debugger".
- **Docs on hover, version-matched:** hovers for `UnityEngine.*` symbols link to `docs.unity3d.com/<major.minor>/...` matching the project version, not latest.
- **Project explorer Unity mode:** optional Assets-first tree (Assets, Packages, ProjectSettings pinned top; Library/Temp hidden), icons by Unity asset type, `.meta` files hidden by default but operations keep them paired (F-6.1).

---

## 11. Performance & Scale Requirements (applies across features)

- Cold open of a 10k-file Unity project: editor interactive <3s; full GUID/YAML index may finish in background (progress in status bar) but must not block editing.
- Memory: Rust index for a large project (5k assets, 100 scenes/prefabs) under ~300MB; webview under control — virtualize all large trees (hierarchy, console, test results).
- Console panel must handle log floods (1k+ entries/sec in a bad loop) via batching + ring buffer (cap with "older entries dropped" notice).
- All bridge calls have timeouts; a hung Unity (import, compile) must never freeze the IDE — degrade to "Unity busy" state.

---

## 12. Suggested build order (dependency-aware)

1. **F-1.x** project model + **F-2.1** LSP (the IDE must be a credible C# editor first)
2. **F-6.1** GUID/meta engine (everything references it; meta-pairing safety is a trust issue)
3. **F-4.1–4.4** Editor bridge core + console + state + commands
4. **F-2.2–2.5** Unity language features + analyzers
5. **F-5.x** AI agent context/tools/workflows (now it has something real to stand on)
6. **F-7.1** Attach-to-Editor debugging
7. **F-3.x** Shader + YAML viewers, **F-8** tests, **F-9** VCS, **F-10** UX polish
8. P2 items as differentiators post-launch

---

## 13. Per-task prompt template for Claude Code

When implementing any feature from this spec, use this framing:

```
Read SPEC.md sections 0 (constraints) and <feature id>.

Implement <feature id> in this repo.

Requirements:
- Follow every hard rule in section 0 (Rust backend for heavy work, graceful degradation without Unity, never write Unity-generated files, debounced watching with default ignores, cross-platform paths, per-feature disable setting).
- Match the acceptance criteria in the spec exactly; add automated tests that encode them where feasible (Rust unit tests for parsers/indexes, fixture Unity project files under /fixtures for analyzer and YAML tests).
- If the spec under-specifies something, choose the option that matches how Unity itself or JetBrains Rider behaves, and note the decision in a comment + the PR description.
- Do not stub with TODOs on the critical path; if a dependency feature (by F-id) is missing, implement the minimal real version of the dependency interface and flag it.

Before writing code: list the files you'll create/modify and the protocol/schema additions (bridge RPCs, settings keys, events), then proceed.
```
