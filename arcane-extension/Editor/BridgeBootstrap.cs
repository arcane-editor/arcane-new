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
using System.Globalization;
using UnityEditor;
using UnityEditor.Build;
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

        // Identity + read position, persisted across domain reloads so a script
        // recompile resumes the journal mid-stream instead of re-handshaking.
        // This is what removes the disconnect flicker the socket transport had on
        // every recompile. The epoch travels with the offset: if the IDE rotated
        // its journal while we were reloading, the offset alone would be a lie.
        private const string SessionUnityIdKey = "Arcane.Bridge.UnitySessionId";
        private const string SessionIdeIdKey = "Arcane.Bridge.IdeSessionId";
        private const string SessionOffsetKey = "Arcane.Bridge.ReadOffset";
        private const string SessionEpochKey = "Arcane.Bridge.ReadEpoch";

        /// <summary>
        /// Mirrors "version" in package.json. Reported in connection_init so the
        /// IDE can tell an outdated package from a missing one. Keep in lockstep.
        /// </summary>
        private const string PackageVersion = "0.1.0";

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

            // Empty ids mean a cold start, which is exactly what triggers a fresh
            // handshake inside BridgeClient.
            string unityId = SessionState.GetString(SessionUnityIdKey, "");
            string ideId = SessionState.GetString(SessionIdeIdKey, "");
            long offset, epoch;
            long.TryParse(SessionState.GetString(SessionOffsetKey, "-1"),
                NumberStyles.Integer, CultureInfo.InvariantCulture, out offset);
            long.TryParse(SessionState.GetString(SessionEpochKey, "0"),
                NumberStyles.Integer, CultureInfo.InvariantCulture, out epoch);
            _client.RestoreSession(
                string.IsNullOrEmpty(unityId) ? null : unityId,
                string.IsNullOrEmpty(ideId) ? null : ideId,
                offset,
                epoch);

            _client.Start();

            ReplayPendingCompileResult();
        }

        /// <summary>
        /// Re-announce the last successful compile after the domain reload it
        /// triggered. The live compilation_finished normally survives via the
        /// worker's final outbox drain, but a wedged worker (Stop()'s Join
        /// timing out) loses it with the AppDomain — and the IDE's compile
        /// gate then waits out its full timeout for a report that never comes.
        /// Send() only queues; the worker flushes once the session is live.
        /// Double delivery is harmless: the IDE resolves on the first fresh
        /// report and treats a second as a no-op store update.
        /// </summary>
        private static void ReplayPendingCompileResult()
        {
            try
            {
                string pending = SessionState.GetString(CompilationHook.PendingResultKey, "");
                if (string.IsNullOrEmpty(pending)) return;
                SessionState.EraseString(CompilationHook.PendingResultKey);

                JsonValue payload = JsonValue.TryParse(pending);
                if (payload == null || !payload.IsObject) return;
                payload["replayed"] = true;
                _client.Send(Protocol.Envelope(MsgType.CompilationFinished, payload));
            }
            catch (Exception e)
            {
                Debug.LogWarning("[ArcaneBridge] compile-result replay failed: " + e.Message);
            }
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
            p["packageVersion"] = PackageVersion;
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
                // NamedBuildTarget, not the BuildTargetGroup overload: that one is
                // obsolete from Unity 6. NamedBuildTarget exists since 2021.2, below
                // this package's 2021.3 floor, so no version guard is needed.
                ScriptingImplementation impl = PlayerSettings.GetScriptingBackend(
                    NamedBuildTarget.FromBuildTargetGroup(group));
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
            // Delivered on the MAIN THREAD — BridgeClient.SetConnected marshals it
            // through the dispatcher, so SessionState is safe to touch here. It
            // was not always: raising this straight from the worker thread threw
            // "UnityException: GetBool can only be called from the main thread"
            // on every connect.
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
            // A domain reload is imminent: dispose cleanly so the journal handles
            // and worker thread don't leak. The static ctor re-runs after the
            // reload and resumes the SAME session mid-stream, which is why this is
            // announced as `reloading` and not as a disconnect.
            Shutdown(StopReason.Reload);
        }

        private static void OnQuitting()
        {
            Shutdown(StopReason.Quit);
            // Editor is closing — clear the session markers so the next launch
            // cold-starts and handshakes afresh rather than resuming a dead session.
            SessionState.EraseBool(SessionConnectedKey);
            SessionState.EraseString(SessionUnityIdKey);
            SessionState.EraseString(SessionIdeIdKey);
            SessionState.EraseString(SessionOffsetKey);
            SessionState.EraseString(SessionEpochKey);
        }

        private static void Shutdown(StopReason reason)
        {
            try
            {
                // FIRST, before anything else: release any bridge worker blocked in
                // EnqueueAndWait. The pump is removed two lines below, so a waiter
                // left in place would sit out its full timeout, _client.Stop()'s
                // Join would fail, and the journals would never be closed — handing
                // the next AppDomain a file the old worker can still write to.
                MainThreadDispatcher.BeginShutdown();

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
                    // Capture BEFORE Stop() closes the journals — the reader's
                    // position is gone once it is disposed.
                    SessionState.SetString(SessionUnityIdKey, _client.UnitySessionId ?? "");
                    SessionState.SetString(SessionIdeIdKey, _client.HandshakenIdeSessionId ?? "");
                    SessionState.SetString(SessionOffsetKey,
                        _client.ReadOffset.ToString(CultureInfo.InvariantCulture));
                    SessionState.SetString(SessionEpochKey,
                        _client.ReadEpoch.ToString(CultureInfo.InvariantCulture));

                    _client.ConnectionStateChanged -= OnConnectionStateChanged;
                    _client.Stop(reason);
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
