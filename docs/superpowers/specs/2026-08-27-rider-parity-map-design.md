# Rider → UnityIDE Parity Map

> **Date:** 2026-08-27 · **Author:** research session
> **Question answered:** *As an IDE for Unity developers, what does JetBrains Rider have that UnityIDE does not?*
> **Compared:** Rider 2026.2.1 + the open-source `resharper-unity` plugin **vs.** UnityIDE `v0.3.3` (`f88aaa5`)
> **Status:** Inventory. **No roadmap, no build recommendations** — that filtering was deliberately excluded.

---

## Read this first

**What this is.** A row-by-row diff of Rider's Unity-developer feature surface against UnityIDE's, across 16 domains — **152 rows**. Every row is scored for how much it hurts and what it would cost. Nothing was dropped for being unrealistic: an `XL` row nobody will ever build is still on the map, because knowing it is there is the point.

**What this is not.** Not a roadmap. Rows are not ordered by what to build, and there is no recommendation column. `STANDOUT-FEATURES.md` holds the strategy; this document holds the facts that strategy should be argued from.

**How UnityIDE's side was established.** From the code, not the docs — every feature barrel, every registered Monaco provider, every LSP method actually sent, the analyzer rule directory, the DAP client's request surface, the git command surface, and the generated `.csproj`. Where `SPEC.md` and the code disagreed, **the code won**. Full list in Appendix C.

### The shape of the gap, in one paragraph

UnityIDE is **ahead of Rider on everything that touches the running Unity Editor and the AI agent**, and **behind on everything that requires a semantic model of C#**. Its Unity bridge, GUID index, scene diff, impact preview and grounded agent have no Rider equivalent. But it cannot navigate to a symbol, format a C# file, report an error in a file you have not opened, or refactor anything beyond a rename — because it has no project-wide symbol index and its compilation model is a single hardcoded `.csproj`. Nearly every 🔴 below traces back to one of those two roots.

### Legend

**Status** — the first column of every table.

| | Meaning |
|---|---|
| ❌ | Nothing here. |
| 🟡 | Partial — the cell says exactly what exists and what is missing. |
| ✅ | At parity, or close enough that a Rider user would not notice. |
| ⭐ | UnityIDE is ahead → Appendix A. |

**Severity** — how fast a professional Unity developer notices.

| | Meaning |
|---|---|
| 🔴 | **Blocker** — hit in the first hour of real work. A reason not to switch. |
| 🟠 | **Major** — hit weekly. Costs real time, or real trust. |
| 🟢 | **Minor** — noticed, worked around, grumbled about. |
| ⚪ | **Cosmetic** — nobody switches IDE over it. |

**Effort** — order of magnitude, not an estimate.

| | Meaning |
|---|---|
| **S** | Days. Existing subsystem, new surface. |
| **M** | Weeks. New subsystem, known shape. |
| **L** | Months. New subsystem plus a data source we do not have. |
| **XL** | Needs a Roslyn-class semantic engine, a graphics debugger, or a profiler backend. Not a sprint. |

### Two honesty markers

| | Meaning |
|---|---|
| **†** | **Built here, never run against a live Unity Editor.** `SPEC.md` §0.5 lists eight such items. A ✅ carrying a † is weaker than Rider's shipped equivalent, which has been in the field for a decade. |
| **‡** | **Depends on csharp-ls behaviour never probed.** `verify:intellisense` asserts completion and hover only — it says nothing about code actions, refactorings or symbols. Effort estimates marked ‡ could shrink substantially, or not. |

### How severity was judged

From the daily loop of a **professional / studio Unity developer** — audience B in `STANDOUT-FEATURES.md`: open a large project, read unfamiliar code, change it safely, find out why something is null, hit a frame budget, review someone else's scene change. Features inside that loop score high however small they are; features outside it score low however impressive. **The `Sev` column is the only thing that moves if you reweight for beginners.**

---

## Scoreboard

| # | Domain | ❌ | 🟡 | ✅ | ⭐ | The headline |
|---|---|---:|---:|---:|---:|---|
| 1 | [Unity project model](#1-unity-project-model--asset-navigation) | 4 | 3 | 3 | — | One hardcoded `.csproj` for the whole project |
| 2 | [C# language intelligence](#2-c-language-intelligence) | **9** | 2 | 1 | — | No symbols, no formatter, no solution-wide analysis |
| 3 | [Navigation & search](#3-navigation--search) | 6 | 1 | 2 | 1 | Asset usages are file-level, never method-level |
| 4 | [Refactoring](#4-refactoring) | 4 | 2 | — | — | 46 refactorings vs. rename, and no refactoring UI |
| 5 | [Inspections](#5-inspections--quick-fixes) | 5 | 4 | 1 | 1 | 13 rules against Rider's 69 |
| 6 | [ProjectSettings intelligence](#6-unity-string-literal--projectsettings-intelligence) | **9** | — | — | — | Nothing reads `TagManager` or build settings |
| 7 | [Performance & profiling](#7-performance-tooling--profiling) | 6 | 1 | — | — | No profiler integration of any kind |
| 8 | [Shaders](#8-shaders) | 8 | 1 | 2 | — | Highlighting without semantics |
| 9 | [Debugging](#9-debugging) | **10** | 2 | 2 | — | Editor-only, values read-only, never live-validated |
| 10 | [Testing & coverage](#10-testing--coverage) | 3 | 2 | 2 | — | No coverage |
| 11 | [Unity Editor integration](#11-unity-editor-integration) | 2 | 1 | 5 | 2 | Unity cannot open UnityIDE on double-click |
| 12 | [Version control](#12-version-control) | 8 | — | 4 | 2 | Whole-file staging; no local history |
| 13 | [DOTS / ECS / Burst](#13-dots--ecs--burst) | 5 | — | — | — | The entire domain is absent |
| 14 | [AI & agents](#14-ai--agents) | 2 | 1 | 2 | **3** | Ahead — but Rider now ships its engine to agents |
| 15 | [Editor UX generics](#15-editor-ux-generics) | 7 | 1 | 4 | — | You cannot see two files at once |
| 16 | [Scale & indexing](#16-scale-indexing--platform) | 1 | 3 | 1 | 1 | No symbol index; never load-tested at scale |
| | **Total** | **89** | **24** | **29** | **10** | **152 rows** |

**Severity spread across the 111 scored rows:** 🔴 16 · 🟠 50 · 🟢 39 · ⚪ 6

---

## The day-one list

The 16 rows scored 🔴, in document order. This is a **navigation aid derived from the `Sev` column** — not a priority order and not a recommendation. Effort is carried over unchanged.

| § | Blocker | Effort |
|---|---|---|
| 1 | Per-assembly compilation model — one `.csproj` means runtime code sees `UnityEditor` | L |
| 1 | Scripting defines from the project — every `#if MY_FLAG` block reads as dead code | M |
| 2 | Go to Symbol in file / Structure view | S ‡ |
| 2 | Go to Symbol in project — you cannot navigate to a type or method by name | S ‡ |
| 2 | Code formatter — `shift+alt+f` is inert on `.cs` | M ‡ |
| 2 | Solution-wide analysis — close a file and its errors vanish | L |
| 3 | Find Usages in scenes and prefabs, at method level | M |
| 4 | The other 45 refactorings — and any refactoring UI at all | L · XL |
| 7 | Unity Profiler integration | L |
| 9 | Attach to Players — editor-only today | L |
| 9 | Modify values at runtime — variables are read-only | S |
| 11 | External-editor registration and deep link — double-click in Unity does nothing | M |
| 12 | Hunk and line-level staging | M |
| 14 | Engine-backed agent skills — blocked on §4 | L |
| 15 | Split editor — you cannot see two files at once | M |
| 16 | Project-wide symbol index — the root cause of §2 and §3 | L |

> Three of these are cheap (`S`) and two of those three unlock a domain each. Four are `L` or worse and share a single dependency: a semantic model of the project. That clustering is the most useful thing on this page.

---
## 1. Unity project model & asset navigation

Rider's model of a Unity project is *the compilation model Unity itself would produce*. UnityIDE's is a single synthetic project built from the Unity install. That one difference generates most of this section.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ✅ | Unity project detection & version | Detects the project, reads the Unity version | `unity.rs detect_unity_project` + Hub editor resolution, nested depth 1–2 | — | — |
| 🟡 | **Unity Explorer** | Dedicated asset-centric tool window listing every asset in the project, a `Packages` node showing `manifest.json` and each resolved package, and a toggle to a Solution view that shows only scripts | Assets-first file tree with `.meta` hiding — `explorer/services/unity-tree-view.ts`. No Packages node, no scripts-only view, no asset-type grouping | 🟠 | M |
| ❌ | **Per-assembly compilation model** | The `Rider Editor` package regenerates one `.csproj` **per assembly definition**, so Editor-only code cannot see runtime-only code and reference rules are enforced by the compiler | One `.unityide.csproj` for everything — `AssemblyName unityide`, `unity.rs:985`. `UnityEditor` APIs autocomplete inside runtime assemblies; `defineConstraints` do nothing. Partly mitigated by the text-level `editor-api-in-runtime` rule | 🔴 | L |
| ✅ | **Scripting defines from the project** | Propagates Unity's real defines per assembly, including asmdef `versionDefines`, `defineConstraints` and `*.rsp` files | **Shipped 2026-08-28.** Real defines from `ProjectSettings.asset`; version ladder + LangVersion derived from the installed Unity; `ENABLE_INPUT_SYSTEM` from the package manifest. <br>_Was:_ Hardcoded list at `unity.rs:997`: version defines pinned at `UNITY_2022_3_OR_NEWER`, `ENABLE_INPUT_SYSTEM` always on, **no user defines at all**. Every `#if MY_FLAG` block is analyzed as dead code; a legacy-input project gets the wrong branch | 🔴 | M |
| ✅ | LangVersion tracks Unity | Sets the C# language version from the installed Unity | **Shipped 2026-08-28.** Derived from the Unity version (`unity_lang_version`). <br>_Was:_ Hardcoded `<LangVersion>9.0</LangVersion>` and `v4.7.1` | 🟢 | S |
| 🟡 | asmdef tooling | Schema validation, completion, **Find Usages on an assembly**, **Rename** for assembly names, navigation from a reference to its defining asmdef, self-reference and filename-mismatch inspections | `asmdef.rs` dependency graph, owning assembly in the status bar, conservative missing-reference quick-fix keyed off LSP `CS0246`. No find-usages, no rename, no navigation, neither inspection | 🟢 | S |
| 🟡 | Package manifest intelligence | Packages surfaced in the Unity Explorer | Richer editing — completion, hover, newer-version hints, read-only PackageCache banner — but the registry index is a **static seed list** (`unity-packages/data/common-packages.ts`) with no live query | 🟢 | S |
| ✅† | `.meta` co-operations | Auto-syncs `.meta` on create, delete, rename and refactor | `explorer/services/meta-file-manager.ts`, plus a typed-confirm for deleting a lone `.meta` and an impact preview Rider has no equivalent for → **A.3** | — | — |
| ✅ | Churn excluded from index & search | `Library` and `Temp` excluded from full-text search | `walk_policy.rs UNITY_CHURN_DIRS` = `Library, Temp, Logs, obj, Build, Builds`, root-level only | — | — |
| ❌ | Asset serialization mode check | Warns when the project is not set to Force Text | No check — yet every YAML feature here silently depends on it | 🟠 | S |

---

## 2. C# language intelligence

UnityIDE sends **14 distinct LSP methods** and registers **10 kinds of Monaco provider**. The rows below are what is not in either list.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ✅ | Completion, hover, signature help, go-to-definition | Roslyn + ReSharper | csharp-ls; asserted live by `verify:intellisense` | — | — |
| ✅ | **Go to Symbol in file / Structure view** | File Structure window, Go to File Member | **Shipped 2026-08-28.** `documentSymbol` provider + `editor.gotoSymbol` (`mod+shift+o`). <br>_Was:_ `textDocument/documentSymbol` is never sent. `SearchOutlinePanel` is a *search-results* outline, not a symbol outline | 🔴 | S ‡ |
| ✅ | **Go to Symbol in project** | Go to Symbol, Go to Type | **Shipped 2026-08-28.** `workspace/symbol` + `#` palette mode + `palette.gotoSymbolInProject` (`mod+t`). <br>_Was:_ `workspace/symbol` is never sent. Quick-open is `fuzzy_search_files` — filenames only. **You cannot navigate to a type or method by name** | 🔴 | S ‡ |
| ✅ | **Semantic highlighting** | Colours by resolved symbol | **Shipped 2026-08-28.** Per-client provider using the server's real legend, plus `semanticHighlighting` on the theme. <br>_Was:_ Monaco's regex tokenizer. `semanticTokens` appears once, in a refresh-notification switch that does nothing. Fields, locals, types and methods all render alike | 🟠 | M ‡ |
| ✅ | **Code formatter** | Full C# formatter, EditorConfig-driven, Code Cleanup, reformat-on-save, `CleanupCode` CLI | **Shipped 2026-08-28.** Document + range formatting providers; `shift+alt+f` now works on `.cs`. <br>_Was:_ `editor.formatDocument` (`shift+alt+f`) dispatches an event and **no C# formatting provider is registered** — the command is inert on `.cs` | 🔴 | M ‡ |
| ✅ | **Solution-wide analysis** | Continuously reports errors and warnings in files you have never opened, with a status-bar monitor | **Shipped 2026-08-28.** `workspace/diagnostic` — csharp-ls serves it, so no Roslyn host was needed. <br>_Was:_ The Problems panel renders the diagnostics map, which LSP populates per *open* document. Close a file and its errors vanish | 🔴 | L |
| ❌ | Call hierarchy / type hierarchy | Incoming and outgoing calls, type hierarchy, plus a Unity-specific *Incoming Calls* action on hot methods | Neither method is sent | 🟠 | M ‡ |
| ✅ | Inlay hints | Parameter names, inferred types | **Shipped 2026-08-28.** `registerInlayHintsProvider`; handles both string and array-of-parts labels. <br>_Was:_ Not requested | 🟢 | S ‡ |
| ❌ | Folding by structure | `foldingRange` from the server | Monaco folds by indentation | ⚪ | S |
| ❌ | **Decompiler** | Decompiles `UnityEngine.dll` so F12 on an engine symbol lands in readable C#; plus Assembly Explorer and an IL viewer | Go-to-definition on an engine type has nowhere to land | 🟠 | XL |
| 🟡 | External annotations & nullability | Hand-written annotations for the engine assemblies: `Component.gameObject` and `Object.name` are not-null, `Debug.Assert` is an assertion method, `Debug.LogFormat` gets format-string checking, `[CustomEditor]` base classes validated, engine attributes mark members implicitly used | Only the implicit-use half, as gutter decorations — `csharp/services/csharp-decorations.ts`, three kinds | 🟢 | M |
| 🟡 | Quick documentation | Unity docs for event functions and parameters in tooltips | Version-matched docs on hover (`editor/services/unity-docs-hover.ts`) — **ahead on version matching**, but keyed off a static index, not the installed API surface | 🟢 | S |

---

## 3. Navigation & search

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ✅ | Go to File | Fuzzy file navigation | `fuzzy_search_files`, plus a Unity asset picker (`unity.findAsset`) | — | — |
| ✅ | Find References in code | Find Usages | `textDocument/references` into Monaco peek | — | — |
| ✅ | **Find Usages in scenes and prefabs** | Resolves the *specific method* wired to a UnityEvent and groups results by type, component name and parent GameObject | **Shipped 2026-08-28.** `extract_persistent_calls` + `unity_method_usages`; the CodeLens now names the wired methods. <br>_Was:_ **File-level GUID references only.** The CodeLens reads `Used in 3 prefabs, 2 scenes`; nothing parses `m_PersistentCalls` or `m_MethodName`. You learn the file is referenced, never which method or which GameObject | 🔴 | M |
| ❌ | Search Everywhere | One entry point across files, types, symbols, actions, settings and text | A command palette and a file palette, no unified search — and no symbol source to feed one | 🟠 | M |
| ✅ | Go to Implementation / Go to Base | Both, plus derived-symbol gutter marks | **Shipped 2026-08-28.** `implementation` + `typeDefinition` providers. <br>_Was:_ `implementation` and `typeDefinition` are declared in client capabilities but never sent | 🟠 | S ‡ |
| ❌ | Recent Files / Recent Locations | `Ctrl+E` and `Ctrl+Shift+E` | `file.openRecent` is recent *folders*; `tab.reopenClosed` is undo-close | 🟢 | S |
| ❌ | Bookmarks | Numbered and anonymous bookmarks with a tool window | No occurrence in `src/` | 🟢 | S |
| ❌ | TODO explorer | Indexes `TODO`/`FIXME` solution-wide, including inside ShaderLab | Absent | 🟢 | S |
| ❌ | Structural Search & Replace | Matches on syntax-tree patterns, not text | Absent | 🟢 | XL |
| ⭐ | Project-wide text search | Standard Find in Files | Zed-style multi-tab search with **editable results** and Unity noise excludes → **A.11** | — | — |

---

## 4. Refactoring

This is the widest gap on the map, and the one where wording matters most. Rider's ~20-year ReSharper engine is the single most cited reason professionals choose it. Its main set contains **46 named refactorings**.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| 🟡 | **Rename** | Conflict detection, a preview of every affected usage, and updates inside comments, strings and Unity string-literal APIs | `textDocument/rename` + `prepareRename`, with a `[FormerlySerializedAs]` post-processor and class↔file rename sync — **Unity-safer than Rider on serialized fields** (→ A.5) — but no preview, no conflict UI, no string-literal awareness | 🟠 | M |
| 🟡 | **The other 45 refactorings** | Extract Method / Class / Interface / Superclass · Inline (5 kinds) · Introduce Field / Parameter / Variable · Change Signature · Move Type to File / Namespace / Folder · Pull Members Up · Push Members Down · Encapsulate Field · Transform Parameters · ~30 more | **Shipped 2026-08-28.** Roslyn refactorings PROVED reachable (Extract Method, Introduce constant/parameter) and now bound to `mod+alt+r`. Still missing: a preview and conflict UI. <br>_Was:_ `lsp/services/code-actions.ts:309` forwards `refactor.*` kinds to csharp-ls, so whatever Roslyn refactorings it exposes *may* already appear in the lightbulb — **this has never been probed**. What certainly does not exist: a Refactor This menu, any refactoring dialog, conflict detection, or a preview | 🔴 | L (UI + wiring) · XL (own engine) |
| ❌ | Safe Delete for code symbols | Searches usages before deleting a type or member | The *asset* equivalent exists (`ImpactDeleteDialog` → A.3); nothing for code | 🟠 | M |
| ❌ | Refactoring preview & conflict resolution | The dialog that makes a large refactor survivable | Absent | 🟠 | M |
| ❌ | Code Cleanup profiles | Batch formatting, member ordering and redundancy removal over a file, folder or solution | Absent | 🟢 | M |
| ❌ | Move to Folder with namespace fix-up | Offers to correct namespaces on move; `Assets` and `Assets/Scripts` are excluded from namespace providers so the offer is right by default | Absent | 🟢 | M |

---

## 5. Inspections & quick-fixes

Rider ships **69 Unity-specific inspections** — 47 Unity, 17 Burst, 5 Unity-performance — on top of ReSharper's general C# set. UnityIDE ships **13 rules**, all regex/text-level, in `unity-analyzers/rules/`.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| 🟡 | **Performance-critical context** | Marks `Update`, `LateUpdate`, `FixedUpdate` and coroutines as a hot context and **propagates it transitively through the call graph**, flagging costly calls anywhere downstream: `AddComponent`, `Find*`, `GetComponent*`, `Debug.Log`, string-based invocation, `Camera.main`, null comparison against a `UnityEngine.Object` | `getcomponent-in-update`, `alloc-in-update`, `camera-main`, `null-propagation-unity-object` — same idea, **no propagation**. `body-analysis.ts` is per-body, so a costly call one method deep from `Update` is invisible | 🟠 | M |
| 🟡 | Event-function correctness | Incorrect signature, incorrect return type, duplicate event function, redundant empty event function, `base.OnGUI()` in a `PropertyDrawer`, `InitializeOnLoad` signature | `near-miss-messages` (casing, params, static) and `empty-messages` | 🟢 | S |
| 🟡 | Lifetime-check bypass | Three inspections — `?.`, `??` and pattern matching against a destroyed `UnityEngine.Object`: the classic "not null but destroyed" bug | `null-propagation-unity-object` covers `?.` only | 🟠 | S |
| ❌ | Instantiation rules | `MonoBehaviour` must use `AddComponent<T>()`; `ScriptableObject` must use `CreateInstance<T>()`; both with quick-fixes | Absent | 🟠 | S |
| ❌ | Attribute redundancy family | Redundant `[SerializeField]`, `[HideInInspector]`, `[FormerlySerializedAs]`, `[InitializeOnLoad]`, plus misapplied-attribute-on-multiple-fields | Absent | 🟢 | S |
| ❌ | Allocation & inefficiency family | Non-allocating alternative available · repeated access of a built-in component property · setting `parent` immediately after `Instantiate` · inefficient multiplication order · jagged over multidimensional arrays | Absent | 🟠 | M |
| 🟡 | String-API family | `CompareTag` over string comparison · Animator string setters rewritten to a cached `StringToHash` id, reusing or introducing a static field · string-based component lookup · string-based graphics property lookup | `string-apis` covers `Invoke`/`SendMessage` → `nameof()` and flags Animator string setters, but has **no hash-caching fix** and **no `CompareTag` rule** | 🟢 | S |
| ❌ | Odin Inspector support | Group path validation, group attribute type, member in multiple UI groups | Absent | ⚪ | M |
| ❌ | **Hosting third-party Roslyn analyzers** | Runs analyzers shipped in the project, including Microsoft's Unity analyzers | The engine is TypeScript and cannot host a Roslyn analyzer at all | 🟠 | L |
| ✅ | Quick-fix delivery | Alt+Enter | Local rules merge into the same lightbulb via `registerLocalCodeActionSource` | — | — |
| ⭐ | Analyzer-gated AI writes | None | `withUnityAnalyzerGate` feeds findings back to the agent so it self-corrects → **A.1** | — | — |

---

## 6. Unity string-literal & ProjectSettings intelligence

The most cleanly-bounded absent family on the map: **eight inspection groups sharing one data source**. Nothing in UnityIDE reads `TagManager.asset`, `EditorBuildSettings.asset` or `InputManager.asset` — they appear nowhere outside test fixtures.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ✅ | Tag is not defined | Validates `CompareTag`, `FindWithTag` and `tag ==` comparisons against Tags & Layers | **Shipped 2026-08-28.** `project-settings-literals` rule, code UNITY0301. <br>_Was:_ Absent | 🟠 | S |
| ✅ | Layer is not defined | Validates layer names and indices | **Shipped 2026-08-28.** code UNITY0302; blank layer slots preserved positionally. <br>_Was:_ Absent | 🟠 | S |
| ✅ | Scene checks (4 inspections) | Scene does not exist · scene disabled in build settings · index missing from build settings · short scene name is not unique | **Shipped 2026-08-28.** codes UNITY0303/0304 — distinguishes missing from present-but-disabled. <br>_Was:_ Absent | 🟠 | S |
| ✅ | Input axis is not defined | Validates `Input.GetAxis("...")` against the Input Manager | **Shipped 2026-08-28.** code UNITY0305. <br>_Was:_ Absent | 🟠 | S |
| ❌ | Animator state does not exist | Validates state names against the project's controllers | Absent | 🟢 | M |
| 🟡 | Resource is not defined | Validates `Resources.Load("...")` paths | **Shipped 2026-08-28.** Malformed paths flagged (leading slash, file extension, UNITY0306). Existence checking still needs the asset index. <br>_Was:_ Absent | 🟠 | S |
| ❌ | Duplicate menu-item shortcut | Two `[MenuItem]`s claiming one chord | Absent | ⚪ | S |
| ❌ | **Strings as real references** | The string argument of `Invoke`, `StartCoroutine`, `SyncVar(hook=)` and friends participates in completion, Find Usages, and **is rewritten when the method is renamed** | Flagged (suggest `nameof()`) but never resolved | 🟠 | M |
| ❌ | Type name in a string literal | Checks the name resolves and derives from the right base — Component, Behaviour or ScriptableObject | Absent | 🟢 | M |

---

## 7. Performance tooling & profiling

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ❌ | **Unity Profiler integration** | Pulls the snapshot from Unity's Profiler and renders **CPU cost as gutter marks beside the declarations that produced it**, updating as the selected frame changes; double-click in either Unity's Hierarchy view or Rider's Profiler window to jump to source; switch threads. *(CPU only — no GPU or memory.)* | No profiler surface at all | 🔴 | L |
| ❌ | dotTrace | Timeline profiling, hot spots, flame graphs, back traces, from the run widget; attaches to the Standalone Player | Absent | 🟠 | XL |
| ❌ | dotMemory | Memory profiling and snapshot comparison | Absent | 🟠 | XL |
| ❌ | Dynamic Program Analysis | Background allocation-issue detection while the app runs | Absent | 🟢 | XL |
| ❌ | Monitoring tool window | Live CPU, memory and GC while running | Absent | 🟢 | M |
| ❌ | **Profiler data as agent context** | `dottrace-analyze`, a bundled skill that reads `.dtp` snapshots so an agent reasons over *measured* cost | Absent — and directly adjacent to UnityIDE's AI wedge → **B** | 🟠 | L |
| 🟡 | Play-mode telemetry | — | Opt-in FPS / memory / GC status-bar sparkline (`unity-telemetry/`, ≤4 Hz). A live **gauge**, not a profiler: no per-method attribution, no call stacks, no snapshots | — | — |

---

## 8. Shaders

UnityIDE has shader *text* support. Rider has a shader *language*.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ✅ | ShaderLab / HLSL / CG highlighting | Syntax highlighting, brace matching, comment toggling, folding | Monarch grammars — `shader-languages/`, 1,240 LOC | — | — |
| ✅ | `#include` go-to-definition | Resolves includes | Relative, `Packages/`, PackageCache and built-in CGIncludes | — | — |
| 🟡 | Completion | Semantic, from a resolved model | Keyword and word-based | 🟢 | L |
| ❌ | **Semantic model** | Resolves ShaderLab and its CG/HLSL blocks into a real model, powering Ctrl+Click on symbols, Find Usages and **Rename inside shaders** | Absent | 🟠 | XL |
| ❌ | **Shader keywords / variants widget** | Enable or disable `#pragma shader_feature` and `multi_compile` keywords, choose the graphics API (D3D11 / Vulkan / Metal / OpenGL) and desktop-vs-mobile symbols, and watch `#if` branches grey out — with four keyword states: enabled, implicitly enabled, disabled, and suppressed by precedence | Absent | 🟠 | L |
| ❌ | Include context switching | For an `.hlsl` included from several programs, choose *which* inclusion point's preprocessor context to analyze | Absent | 🟢 | L |
| ❌ | **Source-level shader debugging** | Breakpoints in ShaderLab source through the bundled Frame Viewer, stepping vertex and fragment stages. *(Windows only, Unity only, needs `#pragma enable_d3d11_debug_symbols`)* | Absent | 🟢 | XL |
| ❌ | Frame Viewer | Draw-call tree, per-draw-call vertex and pixel inspection, texture viewing, RenderDoc snapshot loading — in-IDE | Absent | 🟢 | XL |
| ❌ | Compute shaders as a first-class kind | Full support | Highlighting only | 🟢 | M |
| ❌ | Live shader compile errors | Surfaced through the Unity log | SPEC F-3.1 lists this as unbuilt (P2) | 🟠 | M |
| ❌ | Colour swatches in ShaderLab | Inline colour preview and picker | No colour provider is registered anywhere | ⚪ | S |

---

## 9. Debugging

UnityIDE has a real DAP debugger. Rider has a *Unity* debugger. The distance between those two sentences is this table — and note that **every ✅ here carries a †**: the whole breakpoint → hit → step → inspect loop has never been run against a live Unity Editor (SPEC §0.5, item 2).

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ✅† | Attach to Unity Editor | "Attach to Unity Editor" and "Attach to Unity Editor & Play" run configurations | `dap.rs` + `vscode-mono-debug` under system Mono; `unity.attachDebugger`, `unity.attachDebuggerAndPlay` | — | — |
| ✅† | Conditions and hit counts | Conditions, hit counts, dependencies, temporary breakpoints | `stores/debug.ts` carries `condition` and `hitCondition`, persisted per workspace | — | — |
| ❌ | **Attach to Players** | The Attach to Unity Process dialog lists every Unity instance on the network — editor, helper processes, standalone players, device players | Editor only. SPEC F-7.2 = **not started** | 🔴 | L |
| ❌ | Android over USB (adb), iOS devices | Both, from the same dialog | Absent | 🟠 | L |
| ❌ | IL2CPP player debugging | Attaches like any remote player when built with Script Debugging | Absent | 🟠 | L |
| ❌ | **Pausepoints** | A Unity-only breakpoint kind that pauses **the Editor** at the end of the current frame *without* suspending managed execution — so the Editor stays responsive and you inspect state in the **Inspector**, not only the debugger. Nothing else on the market has this | Absent — though the bridge already owns play/pause, so this is mostly wiring | 🟠 | M |
| ❌ | Tracepoints / logpoints | Log to the Unity Console without stopping | Absent | 🟠 | S |
| ❌ | Exception breakpoints | Break on thrown or uncaught; 2025.2 added low-level exception suppression for game debugging | `setExceptionBreakpoints` is never sent | 🟠 | S |
| ✅ | **Modify values at runtime** | Change a counter, health, state or flag and resume into an otherwise unreachable branch | **Shipped 2026-08-28.** `setVariable` + inline edit; adapter capabilities are now captured instead of discarded. NOT live-verified — the mono-debug adapter is still unvendored. <br>_Was:_ `setVariable` is never sent — variables are read-only | 🔴 | S |
| 🟡 | Evaluate expression | Watches **and** an interactive evaluate window backed by the full expression evaluator | Watch list only (`watches`, `watchResults`) | 🟠 | S |
| ❌ | **Unity-aware visualizers** | A `GameObject` renders as its scene hierarchy with children and components · collections as a filterable, sortable table · `Texture2D` and `RenderTexture` as an **actual image preview** with zoom and pan · a DOTS `Entity` as its component data | "Unity-aware value rendering" — `value-rendering.ts`, ~100 LOC of string formatting, not visualizers | 🟠 | M–L |
| ❌ | Mixed-mode managed/native | Step from C# into a native plugin *(2026.1, Windows only)* | Absent | 🟢 | XL |
| ❌ | Run/Debug configurations | "Attach to Unity Editor", "Attach to Unity Editor & Play", and an auto-created "Standalone Player" whose Run launches the player, Debug attaches, and Profile attaches the timeline profiler | Two palette commands; no configuration concept | 🟢 | M |
| 🟡 | Breakpoint rebinding across domain reloads | Handled, if imperfectly — a known Unity/Rider friction point | Listed in SPEC §0.5 as unvalidated | 🟠 | M |

---

## 10. Testing & coverage

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ✅† | Discovery and run | Unity Test Framework integration | `unity_tests.rs` asmdef-based discovery, headless `-runTests`, NUnit3 parsing, `TestRunnerApi` streaming, panel + Run/Debug CodeLens | — | — |
| ✅† | Edit Mode and Play Mode | Both | Both | — | — |
| ❌ | **Coverage** | dotCover statement-level coverage for Unity tests, **no Unity restart required** since 2025.x, coverage highlighting in the editor, "Cover Selected Unit Tests" | Absent | 🟠 | L |
| ❌ | Test sessions | Named, re-runnable sessions with history | A flat list | 🟢 | M |
| 🟡 | Debugging a test | Attaches to the test run | A Debug CodeLens exists; end-to-end unvalidated † | 🟢 | S |
| ❌ | Continuous testing | Auto-run affected tests on change | Absent | ⚪ | M |
| 🟡 | Result navigation | Jumps to the failing assertion | Same, through the NUnit parse — unvalidated † | — | — |

---

## 11. Unity Editor integration

The one domain where UnityIDE was designed to lead. It mostly does — with two real holes.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ✅ | Live console stream | Unity tool window, Log tab | `unity-console/` over the bridge | — | — |
| ✅ | **Console filtering** | Filters by **play mode vs edit mode** and by warnings / errors / messages; entries navigate to the file, class, method or property named in them | **Shipped 2026-08-28.** Play/edit mode filter added; text filter and collapse already existed. <br>_Was:_ Error / Warning / Log toggles only — no play/edit split, no collapse-duplicates, no text filter | 🟠 | S |
| ✅ | Clickable stack traces | Yes | Yes | — | — |
| ✅ | Play / Pause / Step from the IDE | Unity toolbar in the top-right | `unity-toolbar/` | — | — |
| ⭐ | Refresh assets on save | Manual refresh action | Auto `refreshAssets` on `.cs` save, gated by `unity.bridge.refreshOnSave` → **A.9** | — | — |
| ✅ | Compile errors in the Problems list | Through the Unity log | `unity-compiler/` maps `compilation_finished.messages` to inline markers, with read-time dedup against LSP | — | — |
| ⭐ | Scene hierarchy in the IDE | **None** — this lives in RiderFlow, a separate product | `HierarchyPanel` — but thin in absolute terms: GameObjects and *project scripts* only, read-only, no component values, no selection sync back | — | M |
| ✅ | **External-editor registration & deep link** | Registers itself with Unity; double-clicking a script opens Rider at the right line | **Shipped 2026-08-28.** Already built — `cli.rs` → `PendingGoto` → consumed in `App.tsx` and `WelcomeApp.tsx`. This row was stale, copied from SPEC F-10. <br>_Was:_ SPEC F-10 T10.1, **not started** — needs the Tauri deep-link plugin and a packaged build. Until it ships, double-clicking a script in Unity does not open UnityIDE | 🔴 | M |
| ✅ | Connection status indicator | Yes | `UnityBridgeStatusItem` | — | — |
| ❌ | Editor-side preference pane | A Rider settings pane inside Unity | The package is bridge + editor integration only | ⚪ | S |

---

## 12. Version control

`git.rs` exposes **39 commands** — the base is solid. The gaps are in granularity and history.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ✅ | Status, stage, commit, amend | Yes | Yes | — | — |
| ✅ | Branches, stash, worktrees, blame, log, diff | Yes | Yes — including `git_worktree_*` and a blame hover provider | — | — |
| ✅† | UnityYAMLMerge for scene conflicts | Default merge tool, configurable | `git_run_unityyamlmerge` + `git_setup_unityyamlmerge`; CLI invocation unvalidated | — | — |
| ✅ | `.meta` pairing pre-commit check | Unity pre-commit checks | `unity-git.ts` blocks committing a `.cs` without its `.meta` | — | — |
| ⭐ | Semantic scene/prefab diff | **None** — scene PRs are reviewed as raw YAML | `SceneDiffViewer` + `unity_diff.rs` → **A.2** | — | — |
| ⭐ | `.gitignore` doctor | None | Runs on opening a Unity repo | — | — |
| ❌ | **Hunk and line-level staging** | Stage individual hunks or lines | No `stageHunk` anywhere — staging is whole-file | 🔴 | M |
| ❌ | **Local History** | Records every change to every file independently of git, with labels and a diff viewer | AI-turn checkpoints (`stores/checkpoints.ts`) — a restore point per *agent turn*, not a timeline of your own edits | 🟠 | M |
| ❌ | Interactive rebase, cherry-pick, revert commit | Full VCS operations | Absent | 🟠 | M |
| ❌ | File history with per-revision diff | Plus history for a selection | Absent | 🟠 | S |
| ❌ | Shelves and changelists | Yes | Absent | 🟢 | M |
| ❌ | Compare with branch or revision | Yes | Absent | 🟢 | S |
| ❌ | Three-way merge editor for text | Yes | Ours/theirs resolution and UnityYAMLMerge only | 🟠 | M |
| ❌ | Tag and remote management | Yes | Absent | 🟢 | S |

---

## 13. DOTS / ECS / Burst

Rider ships **17 Burst inspections and 5 DOTS inspections**. UnityIDE has zero. This is the largest wholly-absent domain on the map.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ❌ | **Burst compilation warnings (17)** | Boxing unsupported · managed method, indexer and type access · `foreach` unsupported · `try` unsupported · `typeof` prohibited · static-field write · non-readonly static load · `String.Format` restrictions · `SharedStatic` constraints · Debug-log argument rules · signatures must be unmanaged | Absent | 🟠 | L |
| ❌ | Burst context visualisation | Line markers and Code Vision showing which methods compile under Burst | Absent | 🟢 | M |
| ❌ | **DOTS inspections (5)** | `IAspect` field types · inconsistent type keywords · must-be-struct · `ComponentLookup` must be updated before use · `GetSingleton` requires `RequireForUpdate` in `OnCreate` | Absent | 🟠 | L |
| ❌ | DOTS-aware suppressions | Suppresses "make method static" on DOTS systems; correct handling of ECS injected fields | Absent — generic analyzers would misfire on ECS code | 🟢 | S |
| ❌ | Entity debugger visualizer | An `Entity` renders as its component data | Absent → §9 | 🟢 | M |

---

## 14. AI & agents

The only domain where UnityIDE leads. It is also the fastest-moving one against it — see **Appendix B**.

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ⭐ | Unity-grounded agent | AI Assistant and Junie have **no scene graph, no live editor state, no version-matched API surface** | 24.8k LOC `ai-panel` with scene, console and hierarchy context → **A.1** | — | — |
| 🟡 | External agents | **ACP Registry** (2026.1): one-click install of Copilot, Cursor "and dozens of external agents"; Copilot went native in 2026.2 | Claude Code over ACP — a real implementation, but a catalogue of one | 🟠 | M |
| ✅ | MCP | Supported | `ai-panel/services/mcp-config.ts` | — | — |
| ❌ | **Engine-backed agent skills** | `refactoring-code` (2026.2.1) hands an agent the ReSharper refactoring engine and self-activates when an agent is asked to refactor C#. JetBrains measures **−83% task time, −64% cost, −63% tool calls** versus text editing | The agent edits C# as text, gated by the analyzer. Note the dependency: **you cannot expose a refactoring engine you do not have** → §4 | 🔴 | L |
| ❌ | Profiler-backed agent skill | `dottrace-analyze` reads `.dtp` snapshots | Absent → §7 | 🟠 | L |
| ✅ | In-IDE chat, agent mode, model choice | Yes | Yes | — | — |
| ⭐ | Checkpoint / restore-this-turn | Relies on git and Local History | Per-turn checkpoints with a restore plan → **A.6** | — | — |
| ⭐ | Pricing | AI credits, metered; free tier is non-commercial only | Flat / BYOK, no per-action metering → **A.13** | — | — |

---

## 15. Editor UX generics

The IntelliJ platform tax. Individually small; collectively the texture of "a real IDE".

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| ❌ | **Split editor / editor groups** | Arbitrary splits and tab groups | No `splitEditor`, `editorGroups` or pane-group concept in `stores/workspace.ts`. **You cannot see two files at once** | 🔴 | M |
| ✅ | Diff viewer | Yes | Monaco diff editor, used by git | — | — |
| ✅ | Breadcrumbs, go to line, zoom, tabs, multi-window | Yes | Yes | — | — |
| ✅ | **Live and postfix templates** | Unity's own — `sfield` (serialized field), `sprop` (serialized property) — plus the general C# set and postfix (`.var`, `.foreach`, `.notnull`) | **Shipped 2026-08-28.** `sfield`, `sprop`, `srange`, `reqcomp`, `coroutine`, `createasset`. <br>_Was:_ *File* templates only (`NewScriptModal`); no in-editor snippet expansion beyond LSP completion | 🟠 | S |
| ❌ | **Generate members (`Alt+Insert`)** | Generate Code includes **Unity event functions** via a picker dialog, plus constructors, properties, equality members, `ToString` | Lifecycle *completion* exists; there is no generate menu | 🟠 | S |
| ❌ | Colour preview and picker | `UnityEngine.Color`, `Color32`, named colours and `Color.HSVToRGB` get an inline swatch and a palette editor, in C# and ShaderLab | No colour provider registered | 🟢 | S |
| 🟡 | Code Vision | Usage counts, implicit-Unity-usage, "used in N assets", and navigation to the Unity Editor from the lens | Two CodeLens providers (asset usages, test run/debug) plus gutter decorations | 🟢 | S |
| ❌ | Extend / shrink selection by syntax | `selectionRange` from the server | Absent | 🟢 | S ‡ |
| ❌ | Local History | → §12 | → §12 | 🟠 | M |
| ❌ | Bookmarks, TODO view | → §3 | → §3 | 🟢 | S |
| ✅ | Multi-caret, column selection, indent folding | Yes | Monaco built-ins | — | — |
| ✅ | Themes, terminal, markdown preview | Yes | Present; the theme system is deeper than a parity question | — | — |

---

## 16. Scale, indexing & platform

| St | Gap | Rider | UnityIDE today | Sev | Eff |
|---|---|---|---|---|---|
| 🟡 | **Project-wide symbol index** | Indexes the whole solution | **Shipped 2026-08-28.** `workspace/symbol` delivers the user-visible capability. Still no persistent Rust index, so it does not work with the server down. <br>_Was:_ Indexes **files** (`file_index.rs`) and **GUIDs** (`unity_index.rs`) — **not symbols**. This is the root cause of §2 and §3 | 🔴 | L |
| ⭐ | Asset index with Unity closed | Needs the project loaded | Find-usages-in-assets works with the Editor shut → **A.4** | — | — |
| 🟡 | Large-project behaviour | A known weakness: asset indexing drives RAM high enough that users disable it — which switches off the scene/prefab Find Usages exactly when a big project needs it | Never load-tested at 10k files (SPEC F-11). An **untested** advantage, not a demonstrated one | 🟠 | M (a load test) |
| ✅ | Resilience while Unity recompiles | The IDE is external too | Out-of-process by design → **A.14** | — | — |
| ❌ | Linux | Shipped | The release matrix in `release.yml` is macOS arm64, macOS x64 and Windows x64 — there is no Linux runner. `DISTRIBUTION.md` lists `ubuntu-latest` as a *recommended* matrix, not a built one | 🟢 | M |
| 🟡 | Unity version coverage | Unity API 5.0 onward | The grounding corpus is **Unity 6000.3 only, with no version fallback**; the generated csproj pins version defines at `UNITY_2022_3_OR_NEWER` | 🟠 | M |

---

## Appendix A — Where UnityIDE is ahead

A parity map with one column is propaganda. These are rows where Rider is the one with the gap.

| # | Capability | Why Rider does not have it |
|---|---|---|
| A.1 | **Unity-grounded AI agent** — scene, console, hierarchy and selection as first-class context; version-matched docs; analyzer-gated writes; engine-mutate tools behind per-action approval | AI Assistant and Junie have no scene graph and no live editor state; they hallucinate deprecated APIs like any raw LLM |
| A.2 | **Semantic scene/prefab diff** (`SceneDiffViewer`, `unity_diff.rs`) — component-grouped, property-level | Rider reviews scene PRs as flat YAML. Third-party products exist solely to fill this |
| A.3 | **Impact preview before deleting a referenced asset** (`ImpactDeleteDialog`) — blast radius across scenes and prefabs | Rider has Safe Delete for *code*, not for assets |
| A.4 | **GUID index that works with Unity closed** | Rider's asset analysis is tied to the loaded project and is the first thing users disable for RAM |
| A.5 | **`[FormerlySerializedAs]` auto-insertion on serialized-field rename** | JetBrains has a long-open request to automate exactly this |
| A.6 | **Checkpoint / restore-this-turn for AI edits** | Rider leans on git and Local History; neither is turn-scoped |
| A.7 | **Structured asset viewer** — GameObject → component → property trees for scenes, prefabs and ScriptableObjects, with clickable `{guid}` references; plus `.inputactions` and UXML/USS | Rider shows the YAML |
| A.8 | **Live hierarchy panel** | Rider has none; that capability lives in RiderFlow, a separate product |
| A.9 | **Auto `refreshAssets` on `.cs` save** | Manual in Rider |
| A.10 | **`.gitignore` doctor on opening a Unity repo** | Not a Rider feature |
| A.11 | **Zed-style multi-tab project search with editable results** and Unity noise excludes | Rider's Find in Files is not editable in place |
| A.12 | **Play-mode telemetry strip** (FPS / memory / GC, ≤4 Hz) | Cruder than a profiler, but always-on and zero-setup |
| A.13 | **Flat / BYOK pricing, no per-action metering** | Rider's AI is credit-metered; its free tier is non-commercial only, which excludes every studio |
| A.14 | **Stays responsive while Unity recompiles, enters play, or crashes** | True of Rider too — but not of any in-Editor AI panel it competes with |

---

## Appendix B — The moving target

What JetBrains shipped in the last three releases, and why it matters here.

| Release | Shipped | Why it matters |
|---|---|---|
| **2025.2** | Source-level shader debugging via a bundled Frame Viewer; low-level exception suppression for game debugging | Shader debugging moves from "nobody has it" to "the incumbent has it" |
| **2026.1** | Redesigned Unity Profiler integration; **ACP Registry** — one-click install of Copilot, Cursor and dozens of external agents; git worktrees as a first-class agent handoff; mixed-mode managed/native debugging (Windows) | The ACP wedge (§14) is now table stakes, and Rider's catalogue is larger |
| **2026.2 / .2.1** | Bundled **`refactoring-code`** agent skill over the ReSharper engine; **`dottrace-analyze`** profiling skill; native Copilot; explicitly "opens the IDE's own intelligence to AI coding agents" | The strategic point of this whole document |
| **dotCover** | Unity test coverage without restarting Unity | Removes the last friction from a feature UnityIDE does not have at all |

**The read.** UnityIDE's stated moat is an agent that *understands* Unity and an agent that *edits safely*. JetBrains cannot easily copy the first — grounding needs a live bridge, a GUID index and a version-matched API surface (A.1–A.5). It already owns the second, and as of 2026.2.1 it is handing that engine to agents with measured wins. The asymmetry is worth stating plainly: **UnityIDE's differentiator is the half Rider cannot buy; Rider’s new reach is the half UnityIDE has not built.**

---

## Appendix C — Evidence base

**UnityIDE — read from the repository at `v0.3.3` (`f88aaa5`), not from its docs:**
every `src/features/*/index.ts` barrel · all `monaco.languages.register*` call sites · every `textDocument/*` method sent · `unity-analyzers/rules/` · `features/debugger/` and the DAP client's request surface · `src-tauri/src/{unity,git,dap,unity_index,walk_policy,asmdef}.rs` · the generated `.csproj` at `unity.rs:975–1015` · the command registry in `App.tsx` · `stores/{debug,workspace,settings}.ts` · `SPEC.md` §0.5 for live-validation debt.

Where `SPEC.md` and the code disagreed, the code won.

**Rider — JetBrains documentation and blogs, current to 2026.2.1:**
[Unity features](https://www.jetbrains.com/help/rider/Features_Unity.html) · [Game development for Unity](https://www.jetbrains.com/help/rider/Unity.html) · [Unity code inspections](https://www.jetbrains.com/help/rider/Unity_code_inspections.html) (the 47 / 17 / 5 counts) · [Main set of refactorings](https://www.jetbrains.com/help/rider/Main_Set_of_Refactorings.html) (the 46 count) · [Debug Unity applications](https://www.jetbrains.com/help/rider/Debugging_Unity_Applications.html) · [Unity Profiler assistance](https://www.jetbrains.com/help/rider/Unity_Profiler_Assistance.html) · [Shader keywords and variants](https://www.jetbrains.com/help/rider/Enabling-shader-keywords.html) · [Unity test coverage with dotCover](https://www.jetbrains.com/help/rider/Analyzing_Coverage_Unity.html) · [Performance-critical context](https://github.com/JetBrains/resharper-unity/wiki/Performance-critical-context-and-costly-methods) · [resharper-unity](https://github.com/JetBrains/resharper-unity) · [Rider 2026.1 release](https://blog.jetbrains.com/dotnet/2026/03/30/rider-2026-1-released/) · [Refactoring engine for AI agents](https://blog.jetbrains.com/dotnet/2026/08/19/rider-refactoring-code-skill/) · [Profiling skill for AI agents](https://blog.jetbrains.com/dotnet/2026/06/25/performance-profiling-agent-skill-in-rider/) · [Solution-wide analysis](https://www.jetbrains.com/help/rider/Code_Analysis__Solution-Wide_Analysis.html)

**Related documents in this repo:** `STANDOUT-FEATURES.md` (strategy — this document is the fact base it should argue from) · `editor/SPEC.md` §0.5 (implementation status and live-validation debt) · `editor/CLAUDE.md` (architecture invariants).
