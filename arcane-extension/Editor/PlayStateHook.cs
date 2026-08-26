// PlayStateHook.cs — report play/pause state to the IDE and apply inbound
// engine-control commands (enter/exit playmode, pause toggle, step).
//
// Outbound: EditorApplication.playModeStateChanged + pauseStateChanged →
// `playstate_changed` { state: "Stopped"|"Playing"|"Paused", isCompiling }.
//
// Inbound (routed here by BridgeClient.HandleInbound): enter_playmode,
// exit_playmode, pause, step — each marshaled to the MAIN THREAD because they
// mutate EditorApplication.
//
// All Unity API access is main-thread only. The playModeStateChanged /
// pauseStateChanged callbacks already fire on the main thread, so we can send
// directly from them.

using UnityEditor;
using UnityEngine;

namespace UnityIDE.Bridge
{
    internal static class PlayStateHook
    {
        private static BridgeClient _client;
        private static bool _installed;

        public static void Install(BridgeClient client)
        {
            if (_installed) return;
            _installed = true;
            _client = client;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            EditorApplication.pauseStateChanged += OnPauseChanged;
        }

        public static void Uninstall()
        {
            if (!_installed) return;
            _installed = false;
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            EditorApplication.pauseStateChanged -= OnPauseChanged;
            _client = null;
        }

        /// <summary>Send the current play state on connect (so the IDE seeds its UI).</summary>
        public static void SendCurrentState()
        {
            SendState();
        }

        private static void OnPlayModeChanged(PlayModeStateChange change)
        {
            // Any transition → recompute and send the current coarse state.
            SendState();
        }

        private static void OnPauseChanged(PauseState state)
        {
            SendState();
        }

        private static void SendState()
        {
            if (_client == null) return;

            string state;
            if (EditorApplication.isPlaying)
                state = EditorApplication.isPaused ? "Paused" : "Playing";
            else
                state = "Stopped";

            var payload = JsonValue.NewObject();
            payload["state"] = state;
            payload["isCompiling"] = EditorApplication.isCompiling;
            _client.Send(Protocol.Envelope(MsgType.PlaystateChanged, payload));
        }

        /// <summary>
        /// Apply an inbound engine-control message. Called from the socket worker
        /// thread; every mutation is marshaled onto the main thread.
        /// </summary>
        public static void HandleInboundControl(string type)
        {
            MainThreadDispatcher.Enqueue(() =>
            {
                switch (type)
                {
                    case MsgType.EnterPlaymode:
                        EditorApplication.isPlaying = true;
                        break;
                    case MsgType.ExitPlaymode:
                        EditorApplication.isPlaying = false;
                        break;
                    case MsgType.Pause:
                        EditorApplication.isPaused = !EditorApplication.isPaused;
                        break;
                    case MsgType.Step:
                        EditorApplication.Step();
                        break;
                }
            });
        }
    }
}
