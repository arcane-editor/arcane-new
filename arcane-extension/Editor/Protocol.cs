// Protocol.cs — message-type constants and envelope helpers.
//
// ENVELOPE (every message): { "type": string, "id"?: string, "payload": object,
// "timestamp": number }. timestamp is Unix epoch SECONDS as a double. `id` is
// present ONLY on rpc_request / rpc_response (correlation).
//
// These constants and shapes mirror the Rust IDE router (unity_ipc.rs::route_message)
// and the TypeScript protocol types (src/types/unity.ts). Keep them in lockstep.

using System;

namespace UnityIDE.Bridge
{
    /// <summary>Outbound (C# → IDE) and inbound (IDE → C#) message type strings.</summary>
    internal static class MsgType
    {
        // ── C# → IDE (we send) ───────────────────────────────────────────────
        public const string ConnectionInit = "connection_init";
        public const string Heartbeat = "heartbeat";
        /// <summary>Clean shutdown. With no socket to close, this is what saves the
        /// IDE from waiting out the heartbeat timeout when Unity quits. Sent ONLY
        /// when the editor is really going away — never for a domain reload, which
        /// resumes the same session mid-stream.</summary>
        public const string Disconnect = "disconnect";
        /// <summary>
        /// A domain reload is starting: this AppDomain is about to be torn down and
        /// the journal will go quiet, but the session survives and resumes at its
        /// persisted offset. The IDE widens its liveness deadline instead of
        /// declaring a disconnect, which is what keeps a recompile from dropping
        /// the connection. Additive — an IDE that does not know this type ignores
        /// it and simply falls back to the heartbeat timeout.
        /// </summary>
        public const string Reloading = "reloading";
        public const string Log = "log";
        public const string LogBatch = "log_batch";
        public const string PlaystateChanged = "playstate_changed";
        /// <summary>
        /// A queued asset refresh (or compile request) has actually RUN on the
        /// main thread. Payload: { compileRequested: bool }.
        ///
        /// Queued commands answer their rpc_response the moment they are
        /// accepted, which is deliberately not the same as done — the editor may
        /// be asleep and the work may not run for a while. Without a real
        /// completion signal the IDE has to guess, and it used to guess wrong in
        /// the worst direction: it started a "nothing needed compiling" timer
        /// from the ACK, so an unfocused Unity reported a clean no-op compile for
        /// a file it had not looked at yet.
        ///
        /// Additive — an IDE that does not know this type ignores it.
        /// </summary>
        public const string RefreshCompleted = "refresh_completed";
        public const string CompilationStarted = "compilation_started";
        public const string CompilationFinished = "compilation_finished";
        /// <summary>
        /// Open a script in the IDE that has this project open. Payload:
        /// { path: string, line?: number, column?: number } — 1-based, and both
        /// positions optional so an IDE older than the package that started
        /// sending them still opens the file.
        ///
        /// This is the warm half of double-clicking a script in Unity's Project
        /// window: when the IDE is already up on this project, sending it here
        /// beats relaunching the executable — no throwaway process, no dock
        /// bounce, and no need to know where the app is installed.
        /// </summary>
        public const string OpenFile = "open_file";
        /// <summary>
        /// Ask the IDE to bring itself to the front. Sent alongside OpenFile,
        /// because nothing else will: on the warm path no process is launched,
        /// so without this the file opens in a window that stays behind Unity.
        /// Payload is empty.
        /// </summary>
        public const string FocusWindow = "focus_window";
        public const string RpcResponse = "rpc_response";
        public const string SelectionChanged = "selection_changed";
        public const string HierarchyChanged = "hierarchy_changed";
        public const string TestEvent = "test_event";
        public const string PlayModeStats = "playmode_stats";

        // ── IDE → C# (we receive) ────────────────────────────────────────────
        public const string HeartbeatAck = "heartbeat_ack";
        public const string EnterPlaymode = "enter_playmode";
        public const string ExitPlaymode = "exit_playmode";
        public const string Pause = "pause";
        public const string Step = "step";
        public const string RpcRequest = "rpc_request";
    }

    /// <summary>JSON-RPC-ish error codes used in rpc_response payload.error.code.</summary>
    internal static class RpcError
    {
        public const int MethodNotFound = -32601; // unknown method
        public const int InternalError = -32000;  // handler threw
    }

    internal static class Protocol
    {
        private static readonly DateTime UnixEpoch =
            new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        /// <summary>Unix epoch seconds as a double (matches the wire `timestamp`).</summary>
        public static double NowUnixSeconds() =>
            (DateTime.UtcNow - UnixEpoch).TotalSeconds;

        /// <summary>
        /// Build a fire-and-forget envelope: { type, payload, timestamp }.
        /// </summary>
        public static JsonValue Envelope(string type, JsonValue payload)
        {
            var msg = JsonValue.NewObject();
            msg["type"] = type;
            msg["payload"] = payload ?? JsonValue.NewObject();
            msg["timestamp"] = NowUnixSeconds();
            return msg;
        }

        /// <summary>
        /// Build an rpc_response envelope carrying the original request id.
        /// payload is { "result": ... } on success.
        /// </summary>
        public static JsonValue RpcResult(string id, JsonValue result)
        {
            var payload = JsonValue.NewObject();
            payload["result"] = result ?? JsonValue.Null;
            var msg = Envelope(MsgType.RpcResponse, payload);
            msg["id"] = id;
            return msg;
        }

        /// <summary>
        /// Build an rpc_response error envelope: payload = { error: { code, message } }.
        /// </summary>
        public static JsonValue RpcErrorResult(string id, int code, string message)
        {
            var err = JsonValue.NewObject();
            err["code"] = code;
            err["message"] = message ?? "";
            var payload = JsonValue.NewObject();
            payload["error"] = err;
            var msg = Envelope(MsgType.RpcResponse, payload);
            msg["id"] = id;
            return msg;
        }
    }
}
