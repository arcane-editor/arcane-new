// BridgeBootstrap.cs — single entry point. [InitializeOnLoad] runs this static
// constructor on editor launch AND after every domain reload (script recompile,
// enter/exit playmode with reload). That re-run is exactly how we survive domain
// reloads: the old client was disposed in beforeAssemblyReload, and the new
// static ctor spins up a fresh one and reconnects automatically.
//
// Responsibilities:
//   * Capture the main thread + install the EditorApplication.update pump.
//   * Build the connection_init UnityProjectInfo payload (main-thread only).
//   * Construct + start the BridgeClient.
//   * Wire all hooks (console, playstate, compilation) and register all RPC
//     handler groups.
//   * Clean disconnect on beforeAssemblyReload and EditorApplication.quitting so
//     we never leak the socket fd or worker thread across reloads.
//   * Use SessionState to suppress duplicate "connected" log spam across reloads.
//
// HARD RULE: never throw out of the static ctor or the update pump — both are
// wrapped in try/catch with Debug.LogError. A throw here would break the whole
// editor's InitializeOnLoad chain.

using System;
using System.Diagnostics;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace Arcane.Bridge
{
    [InitializeOnLoad]
    internal static class BridgeBootstrap
    {
        // SessionState survives domain reloads (but not editor restart). We use it
        // only to avoid logging "connected" on every reload while a session stays up.
        private const string SessionConnectedKey = "Arcane.Bridge.AnnouncedConnected";

        private static BridgeClient _client;
        private static bool _started;

        static BridgeBootstrap()
        {
            // Defer the actual startup by one tick. Touching some Unity APIs (and
            // PlayerSettings) directly inside an InitializeOnLoad static ctor can be
            // fragile during the editor's own initialization; a single delayCall
            // lands us safely on the main thread after init completes.
            EditorApplication.delayCall += SafeStart;
        }

        private static void SafeStart()
        {
            try
            {
                Start();
            }
            catch (Exception e)
            {
                Debug.LogError("[ArcaneBridge] startup failed: " + e);
            }
        }

        private static void Start()
        {
            if (_started) return;
            _started = true;

            MainThreadDispatcher.CaptureMainThread();

            string projectRoot = Discovery.ProjectRoot(Application.dataPath);

            _client = new BridgeClient(projectRoot, BuildConnectionInitPayload);
            _client.ConnectionStateChanged += OnConnectionStateChanged;

            // Hooks + RPC handlers. (Hooks buffer/emit; handlers serve requests.)
            ConsoleHook.Install(_client);
            PlayStateHook.Install(_client);
            CompilationHook.Install(_client);
            PlayModeStatsHook.Install(_client);
            EditorStateHandlers.Register(_client);
            HierarchyHandlers.Register(_client);
            DebuggerHandlers.Register(_client);
            TestRunnerHandlers.Register(_client);

            // Main-thread pump: drains the dispatcher and ticks the timed flushers.
            EditorApplication.update += Pump;

            // Lifecycle teardown.
            AssemblyReloadEvents.beforeAssemblyReload += OnBeforeAssemblyReload;
            EditorApplication.quitting += OnQuitting;

            _client.Start();
        }

        // ── Main-thread pump ─────────────────────────────────────────────────

        private static void Pump()
        {
            try
            {
                MainThreadDispatcher.Pump();   // run queued Unity work (RPC handlers, controls)
                ConsoleHook.Tick();            // flush buffered logs as log_batch (~100ms)
                HierarchyHandlers.Tick();      // debounced hierarchy_changed
                TestRunnerHandlers.Tick();     // (no-op; TestRunnerApi fires on the main thread)
                PlayModeStatsHook.Tick();      // ≤4Hz play-mode telemetry
            }
            catch (Exception e)
            {
                // Never let the pump throw — it would stop ALL EditorApplication.update
                // subscribers. Log and keep going.
                Debug.LogError("[ArcaneBridge] update pump error: " + e);
            }
        }

        // ── connection_init payload (UnityProjectInfo) ───────────────────────
        //
        // Built on the MAIN THREAD (reads PlayerSettings/Application). Shape MUST
        // match the spec / the IDE's connection_init consumer:
        //   { projectName, projectPath, unityVersion, companyName, productName,
        //     scriptingBackend: "Mono"|"IL2CPP", protocolVersion: 1, pid }

        private static JsonValue BuildConnectionInitPayload()
        {
            var p = JsonValue.NewObject();
            string projectRoot = Discovery.ProjectRoot(Application.dataPath);

            p["projectName"] = PlayerSettings.productName ?? "";
            p["projectPath"] = projectRoot ?? "";
            p["unityVersion"] = Application.unityVersion ?? "";
            p["companyName"] = PlayerSettings.companyName ?? "";
            p["productName"] = PlayerSettings.productName ?? "";
            p["scriptingBackend"] = ScriptingBackendString();
            p["protocolVersion"] = Discovery.ProtocolVersion;
            p["pid"] = Process.GetCurrentProcess().Id;
            return p;
        }

        private static string ScriptingBackendString()
        {
            // Editor-side reads the *active* build target's scripting backend.
            try
            {
                BuildTargetGroup group = BuildPipeline.GetBuildTargetGroup(
                    EditorUserBuildSettings.activeBuildTarget);
                ScriptingImplementation impl = PlayerSettings.GetScriptingBackend(group);
                return impl == ScriptingImplementation.IL2CPP ? "IL2CPP" : "Mono";
            }
            catch
            {
                return "Mono";
            }
        }

        // ── Connection state logging (dedup across reloads) ──────────────────

        private static void OnConnectionStateChanged(bool connected)
        {
            // Fires on the worker thread — only do thread-safe work here.
            if (connected)
            {
                bool announced = SessionState.GetBool(SessionConnectedKey, false);
                if (!announced)
                {
                    SessionState.SetBool(SessionConnectedKey, true);
                    Debug.Log("[ArcaneBridge] Connected to Arcane IDE.");
                }
            }
            else
            {
                // Reset so the next genuine (re)connect logs once again.
                SessionState.SetBool(SessionConnectedKey, false);
            }
        }

        // ── Teardown ─────────────────────────────────────────────────────────

        private static void OnBeforeAssemblyReload()
        {
            // A domain reload is imminent: dispose cleanly so the socket fd and
            // worker thread don't leak. The static ctor re-runs after the reload
            // and reconnects automatically.
            Shutdown();
        }

        private static void OnQuitting()
        {
            Shutdown();
            // Editor is closing — clear the session marker so a fresh launch logs.
            SessionState.EraseBool(SessionConnectedKey);
        }

        private static void Shutdown()
        {
            try
            {
                EditorApplication.update -= Pump;
                AssemblyReloadEvents.beforeAssemblyReload -= OnBeforeAssemblyReload;
                EditorApplication.quitting -= OnQuitting;

                ConsoleHook.Uninstall();
                PlayStateHook.Uninstall();
                CompilationHook.Uninstall();
                PlayModeStatsHook.Uninstall();
                EditorStateHandlers.UninstallSelectionHook();
                HierarchyHandlers.UninstallHierarchyHook();
                TestRunnerHandlers.Shutdown();
                RpcDispatcher.Clear();
                MainThreadDispatcher.Clear();

                if (_client != null)
                {
                    _client.ConnectionStateChanged -= OnConnectionStateChanged;
                    _client.Stop();
                    _client = null;
                }
            }
            catch (Exception e)
            {
                Debug.LogError("[ArcaneBridge] shutdown error: " + e);
            }
            finally
            {
                _started = false;
            }
        }
    }
}
