// Static seed list of common Unity (UPM) packages.
//
// This is the OFFLINE FALLBACK and the primary completion/hover source when the
// registry fetch (`unity_fetch_registry_index`) returns nothing — which is the
// normal case until/unless an HTTP client is wired into the Rust backend.
//
// `latestVersion` values are a reasonable recent snapshot (Unity 2022 LTS era).
// They are intentionally approximate: the manifest "newer version available"
// hint is informational only, never an error, and the live registry (when
// available) overrides these. Do NOT treat these as authoritative pins.

export interface UnityPackageInfo {
  /** Full package id, e.g. `com.unity.render-pipelines.universal`. */
  name: string;
  /** One-line human description. */
  description?: string;
  /** Latest version known to this seed snapshot (semver-ish string). */
  latestVersion?: string;
}

export const COMMON_UNITY_PACKAGES: readonly UnityPackageInfo[] = [
  // ── Render pipelines & rendering ──────────────────────────────────────────
  { name: 'com.unity.render-pipelines.universal', description: 'Universal Render Pipeline (URP).', latestVersion: '14.0.11' },
  { name: 'com.unity.render-pipelines.high-definition', description: 'High Definition Render Pipeline (HDRP).', latestVersion: '14.0.11' },
  { name: 'com.unity.render-pipelines.core', description: 'Shared core library for the Scriptable Render Pipelines.', latestVersion: '14.0.11' },
  { name: 'com.unity.shadergraph', description: 'Visual node-based shader authoring.', latestVersion: '14.0.11' },
  { name: 'com.unity.visualeffectgraph', description: 'Node-based GPU particle / VFX authoring.', latestVersion: '14.0.11' },
  { name: 'com.unity.postprocessing', description: 'Post-processing stack v2 (built-in pipeline).', latestVersion: '3.4.0' },

  // ── Input ─────────────────────────────────────────────────────────────────
  { name: 'com.unity.inputsystem', description: 'The new Input System package.', latestVersion: '1.7.0' },

  // ── Assets & content ────────────────────────────────────────────────────────
  { name: 'com.unity.addressables', description: 'Addressable Asset System for content loading.', latestVersion: '1.21.19' },
  { name: 'com.unity.scriptablebuildpipeline', description: 'Scriptable Build Pipeline (used by Addressables).', latestVersion: '1.21.21' },
  { name: 'com.unity.localization', description: 'Localization workflows for strings and assets.', latestVersion: '1.4.5' },

  // ── Cameras & sequencing ──────────────────────────────────────────────────
  { name: 'com.unity.cinemachine', description: 'Procedural, smart camera system.', latestVersion: '2.9.7' },
  { name: 'com.unity.timeline', description: 'Cinematic and gameplay sequencing.', latestVersion: '1.7.6' },
  { name: 'com.unity.recorder', description: 'Capture and save in-game data (video, image sequences).', latestVersion: '4.0.1' },

  // ── Networking & multiplayer ──────────────────────────────────────────────
  { name: 'com.unity.netcode.gameobjects', description: 'Netcode for GameObjects (high-level multiplayer).', latestVersion: '1.7.1' },
  { name: 'com.unity.netcode', description: 'Netcode for Entities (DOTS multiplayer).', latestVersion: '1.0.17' },
  { name: 'com.unity.transport', description: 'Low-level networking transport layer.', latestVersion: '1.4.0' },
  { name: 'com.unity.multiplayer.tools', description: 'Tools for debugging and profiling multiplayer.', latestVersion: '1.1.0' },
  { name: 'com.unity.services.relay', description: 'Unity Relay service (NAT punch-through).', latestVersion: '1.0.5' },
  { name: 'com.unity.services.lobby', description: 'Unity Lobby service.', latestVersion: '1.1.0' },
  { name: 'com.unity.services.authentication', description: 'Unity Authentication service.', latestVersion: '2.7.1' },
  { name: 'com.unity.services.core', description: 'Core for Unity Gaming Services.', latestVersion: '1.12.0' },

  // ── DOTS / ECS ────────────────────────────────────────────────────────────
  { name: 'com.unity.entities', description: 'Entity Component System (ECS) core.', latestVersion: '1.0.16' },
  { name: 'com.unity.entities.graphics', description: 'Rendering for ECS entities (Hybrid Renderer successor).', latestVersion: '1.0.16' },
  { name: 'com.unity.physics', description: 'Stateless, deterministic DOTS physics.', latestVersion: '1.0.16' },
  { name: 'com.unity.burst', description: 'Burst compiler for high-performance C# jobs.', latestVersion: '1.8.9' },
  { name: 'com.unity.mathematics', description: 'SIMD-friendly math library for jobs/Burst.', latestVersion: '1.2.6' },
  { name: 'com.unity.collections', description: 'Unmanaged native container collections.', latestVersion: '2.1.4' },
  { name: 'com.unity.jobs', description: 'C# Job System utilities.', latestVersion: '0.70.0-preview.7' },

  // ── Text & UI ─────────────────────────────────────────────────────────────
  { name: 'com.unity.textmeshpro', description: 'Advanced text rendering (TextMesh Pro).', latestVersion: '3.0.6' },
  { name: 'com.unity.ugui', description: 'Unity UI (uGUI) and TextMesh Pro integration.', latestVersion: '1.0.0' },
  { name: 'com.unity.ui', description: 'UI Toolkit runtime/editor controls.', latestVersion: '1.0.0-preview.18' },
  { name: 'com.unity.ui.builder', description: 'Visual authoring tool for UI Toolkit (UXML/USS).', latestVersion: '1.0.0-preview.18' },

  // ── AI & navigation ───────────────────────────────────────────────────────
  { name: 'com.unity.ai.navigation', description: 'NavMesh components and runtime baking.', latestVersion: '1.1.5' },
  { name: 'com.unity.ml-agents', description: 'Machine Learning Agents toolkit.', latestVersion: '2.3.0-exp.3' },

  // ── 2D ────────────────────────────────────────────────────────────────────
  { name: 'com.unity.2d.animation', description: '2D skeletal animation.', latestVersion: '9.1.1' },
  { name: 'com.unity.2d.sprite', description: 'Sprite Editor and sprite tooling.', latestVersion: '1.0.0' },
  { name: 'com.unity.2d.tilemap', description: '2D tilemap system.', latestVersion: '1.0.0' },
  { name: 'com.unity.2d.tilemap.extras', description: 'Extra tilemap brushes and helpers.', latestVersion: '3.1.2' },
  { name: 'com.unity.2d.pixel-perfect', description: 'Pixel Perfect camera for crisp 2D.', latestVersion: '5.0.3' },
  { name: 'com.unity.2d.psdimporter', description: 'Photoshop (.psb) importer for 2D.', latestVersion: '8.0.5' },
  { name: 'com.unity.2d.spriteshape', description: 'Spline-based 2D sprite shapes.', latestVersion: '9.0.3' },
  { name: 'com.unity.2d.aseprite', description: 'Aseprite (.ase/.aseprite) importer.', latestVersion: '1.0.1' },
  { name: 'com.unity.feature.2d', description: '2D feature set (bundles 2D packages).', latestVersion: '2.0.0' },

  // ── Testing & quality ─────────────────────────────────────────────────────
  { name: 'com.unity.test-framework', description: 'Unity Test Framework (NUnit-based).', latestVersion: '1.1.33' },
  { name: 'com.unity.testtools.codecoverage', description: 'Code coverage reporting for tests.', latestVersion: '1.2.4' },
  { name: 'com.unity.performance.profile-analyzer', description: 'Analyze and compare Profiler captures.', latestVersion: '1.2.2' },
  { name: 'com.unity.memoryprofiler', description: 'Detailed memory capture and analysis.', latestVersion: '1.0.0' },

  // ── Editor tooling & workflow ─────────────────────────────────────────────
  { name: 'com.unity.ide.visualstudio', description: 'Visual Studio editor integration.', latestVersion: '2.0.22' },
  { name: 'com.unity.ide.rider', description: 'JetBrains Rider editor integration.', latestVersion: '3.0.27' },
  { name: 'com.unity.ide.vscode', description: 'Visual Studio Code editor integration.', latestVersion: '1.2.5' },
  { name: 'com.unity.editorcoroutines', description: 'Run coroutines in the Editor.', latestVersion: '1.0.0' },
  { name: 'com.unity.settings-manager', description: 'Settings management framework.', latestVersion: '2.0.1' },
  { name: 'com.unity.searcher', description: 'Generic searcher UI control.', latestVersion: '4.9.2' },
  { name: 'com.unity.nuget.newtonsoft-json', description: 'Newtonsoft Json.NET, packaged for Unity.', latestVersion: '3.2.1' },
  { name: 'com.unity.ext.nunit', description: 'NUnit assembly (used by the Test Framework).', latestVersion: '1.0.6' },
  { name: 'com.unity.purchasing', description: 'In-App Purchasing.', latestVersion: '4.10.0' },
  { name: 'com.unity.ads', description: 'Unity Ads / monetization.', latestVersion: '4.4.2' },
  { name: 'com.unity.analytics', description: 'Unity Analytics (legacy).', latestVersion: '3.8.1' },
  { name: 'com.unity.remote-config', description: 'Remote configuration service.', latestVersion: '3.3.2' },
  { name: 'com.unity.cloud.gltfast', description: 'glTF import/export (glTFast).', latestVersion: '6.0.1' },
  { name: 'com.unity.formats.fbx', description: 'FBX exporter.', latestVersion: '4.2.1' },
  { name: 'com.unity.probuilder', description: 'In-editor 3D modeling and level design.', latestVersion: '5.1.1' },
  { name: 'com.unity.polybrush', description: 'Mesh sculpting, texture blending and scattering.', latestVersion: '1.1.5' },
  { name: 'com.unity.splines', description: 'Spline authoring and evaluation.', latestVersion: '2.4.0' },
  { name: 'com.unity.terrain-tools', description: 'Additional terrain sculpting tools.', latestVersion: '5.0.2' },
  { name: 'com.unity.toolchain.macos-x86_64-linux-x86_64', description: 'Cross-compile toolchain (macOS → Linux).', latestVersion: '2.0.0' },

  // ── Modules (built-in, but commonly referenced) ───────────────────────────
  { name: 'com.unity.modules.ai', description: 'Built-in AI (NavMesh) module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.animation', description: 'Built-in Animation module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.physics', description: 'Built-in 3D Physics module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.physics2d', description: 'Built-in 2D Physics module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.particlesystem', description: 'Built-in Particle System module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.ui', description: 'Built-in UI module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.uielements', description: 'Built-in UIElements / UI Toolkit module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.audio', description: 'Built-in Audio module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.video', description: 'Built-in Video module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.terrain', description: 'Built-in Terrain module.', latestVersion: '1.0.0' },
  { name: 'com.unity.modules.imgui', description: 'Built-in IMGUI module.', latestVersion: '1.0.0' },
];
