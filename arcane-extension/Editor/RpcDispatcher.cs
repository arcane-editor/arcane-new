// RpcDispatcher.cs — inbound rpc_request → handler → rpc_response.
//
// Handlers are registered into a name→func map. Each handler body runs on the
// MAIN THREAD (via MainThreadDispatcher) because handlers touch Unity APIs. The
// dispatch itself is invoked from the journal poll loop (background thread).
//
// TWO DELIVERY MODES:
//
//   Register        — blocking. The worker waits up to HandlerTimeoutMs for the
//                     main thread to produce a result, then replies with it.
//                     Right for a query: the caller wants the answer.
//
//   RegisterQueued  — non-blocking. The work is queued for the main thread and
//                     the worker replies `{queued:true}` immediately.
//
// Why the second mode exists. Unity parks its main thread while its window is
// unfocused, which is the normal state when the user is looking at the IDE. A
// blocking refreshAssets in that state does not merely run late — it fails: the
// worker times out at HandlerTimeoutMs, the IDE sees an RPC rejection, and the
// action it queued used to stay in the queue and fire much later, so a dozen
// already-failed refreshes all ran the instant the user clicked into Unity.
//
// VERSION GATE: queueing changes what an rpc_response MEANS, so it is only used
// with an IDE that advertises protocol >= 3. An older IDE reads the reply as
// "the import finished" and would report a clean no-op compile for a file Unity
// has not touched, so it keeps the blocking path — slower, but honest.
//
// A command whose value is the SIDE EFFECT, not the return value, has no reason
// to make the caller wait for a thread that is asleep. Queued commands are
// coalesced by key (ten refreshes collapse to one), expire if the editor stays
// asleep long enough for them to be moot, and announce their real completion
// with their own message — `refresh_completed` — rather than lying about it in
// an rpc_response that returns before the work has happened.
//
// Error mapping (payload.error.code):
//   unknown method     → -32601 (MethodNotFound)
//   handler exception  → -32000 (InternalError) with the exception message

using System;
using System.Collections.Generic;
using UnityEngine;

namespace UnityIDE.Bridge
{
    /// <summary>A single RPC handler: maps request params to a result value.</summary>
    internal delegate JsonValue RpcHandler(JsonValue @params);

    internal static class RpcDispatcher
    {
        private static readonly Dictionary<string, RpcHandler> Handlers =
            new Dictionary<string, RpcHandler>(StringComparer.Ordinal);

        /// <summary>method → coalescing key, for handlers registered as queued.</summary>
        private static readonly Dictionary<string, string> QueuedMethods =
            new Dictionary<string, string>(StringComparer.Ordinal);

        // How long an RPC handler may run on the main thread before we give up
        // and return an error (keeps a hung handler from wedging the worker
        // thread forever; the IDE also has its own 10s RPC timeout).
        private const int HandlerTimeoutMs = 8000;

        /// <summary>
        /// How long a queued command stays worth running. Past this the editor
        /// has been asleep long enough that Unity's own focus-triggered refresh
        /// will cover the same ground the moment the user tabs over, so running
        /// ours too is duplicated import work for nothing.
        /// </summary>
        private const int QueuedTtlMs = 120000;

        /// <summary>
        /// The IDE protocol version from which a caller understands a queued
        /// ack. See Discovery.ProtocolVersion.
        /// </summary>
        private const int MinQueuedProtocol = 3;

        /// <summary>
        /// What the connected IDE advertised in bridge.json. 0 until the first
        /// EnsureSession, which always runs before any inbound message is
        /// handled.
        ///
        /// Deliberately NOT reset by Clear(): handler registration and session
        /// negotiation are independent lifecycles, and forgetting the version on
        /// a re-Install would silently demote a current IDE to the blocking
        /// path.
        /// </summary>
        private static volatile int _ideProtocolVersion;

        /// <summary>Record the connected IDE's wire-protocol version.</summary>
        public static void SetIdeProtocolVersion(int version)
        {
            _ideProtocolVersion = version;
        }

        /// <summary>
        /// What the connected IDE advertised in bridge.json (0 until the first
        /// EnsureSession). Read-only counterpart to <see cref="SetIdeProtocolVersion"/>,
        /// for callers that need to gate on the negotiated version themselves
        /// rather than through <see cref="QueuedRepliesUnderstood"/>.
        /// </summary>
        public static int IdeProtocolVersion
        {
            get { return _ideProtocolVersion; }
        }

        /// <summary>
        /// Whether the connected IDE can be answered with a queued ack. An older
        /// IDE reads any rpc_response as completion, so it gets the pre-queue
        /// blocking behaviour — slow against a parked editor, but never a lie.
        /// </summary>
        private static bool QueuedRepliesUnderstood
        {
            get { return _ideProtocolVersion >= MinQueuedProtocol; }
        }

        public static void Register(string method, RpcHandler handler)
        {
            if (string.IsNullOrEmpty(method) || handler == null) return;
            Handlers[method] = handler;
            QueuedMethods.Remove(method);
        }

        /// <summary>
        /// Register a fire-and-forget command: queued for the main thread,
        /// answered immediately with `{queued:true}`.
        /// </summary>
        /// <param name="coalesceKey">
        /// Commands sharing a key collapse to one pending action. Pass the same
        /// key for two methods that do overlapping work (refreshAssets and
        /// requestCompile both end in an AssetDatabase import). Defaults to the
        /// method name.
        /// </param>
        public static void RegisterQueued(string method, RpcHandler handler, string coalesceKey = null)
        {
            if (string.IsNullOrEmpty(method) || handler == null) return;
            Handlers[method] = handler;
            QueuedMethods[method] = string.IsNullOrEmpty(coalesceKey) ? method : coalesceKey;
        }

        public static void Clear()
        {
            Handlers.Clear();
            QueuedMethods.Clear();
        }

        /// <summary>
        /// Handle one inbound rpc_request envelope. Computes the reply envelope
        /// (result or error) and sends it via <paramref name="send"/>. Safe to call
        /// from a background thread; the handler body is marshaled to the main thread.
        /// </summary>
        public static void Dispatch(JsonValue request, Action<JsonValue> send)
        {
            string id = request["id"].AsString;
            string method = request["payload"]["method"].AsString;
            JsonValue @params = request["payload"]["params"];
            if (@params == null || @params.IsNull)
                @params = JsonValue.NewObject();

            if (string.IsNullOrEmpty(id))
            {
                // No id → we cannot correlate a response; drop with a log.
                Debug.LogWarning("[UnityIDEBridge] rpc_request missing id; method=" + method);
                return;
            }

            RpcHandler handler;
            if (string.IsNullOrEmpty(method) || !Handlers.TryGetValue(method, out handler))
            {
                send(Protocol.RpcErrorResult(id, RpcError.MethodNotFound,
                    "Unknown method: " + (method ?? "<null>")));
                return;
            }

            string coalesceKey;
            if (QueuedMethods.TryGetValue(method, out coalesceKey) && QueuedRepliesUnderstood)
            {
                DispatchQueued(id, method, coalesceKey, handler, @params, send);
                return;
            }

            JsonValue reply;
            try
            {
                // Run the handler on the main thread and wait for its result.
                JsonValue result = MainThreadDispatcher.EnqueueAndWait(
                    () => handler(@params) ?? JsonValue.Null, HandlerTimeoutMs);
                reply = Protocol.RpcResult(id, result);
            }
            catch (Exception e)
            {
                // Unwrap to the most informative message (TimeoutException, or the
                // handler's own exception captured by EnqueueAndWait).
                string msg = e.Message;
                reply = Protocol.RpcErrorResult(id, RpcError.InternalError, msg);
                Debug.LogError("[UnityIDEBridge] RPC '" + method + "' failed: " + e);
            }

            send(reply);
        }

        /// <summary>
        /// Queue the handler and answer straight away. The reply says only that
        /// the ask was accepted — never that it ran. `accepted:false` means an
        /// identical command was already waiting, which is a normal, successful
        /// outcome for the caller, not an error.
        /// </summary>
        private static void DispatchQueued(
            string id, string method, string coalesceKey,
            RpcHandler handler, JsonValue @params, Action<JsonValue> send)
        {
            bool accepted = MainThreadDispatcher.EnqueueCoalesced(
                coalesceKey,
                () =>
                {
                    try { handler(@params); }
                    catch (Exception e)
                    {
                        // Nobody is waiting on this reply, so the console is the
                        // only place the failure can surface.
                        Debug.LogError("[UnityIDEBridge] queued RPC '" + method + "' failed: " + e);
                    }
                },
                QueuedTtlMs);

            var result = JsonValue.NewObject();
            result["queued"] = true;
            result["accepted"] = accepted;
            result["editorIdleMs"] = MainThreadDispatcher.MsSincePump;
            send(Protocol.RpcResult(id, result));
        }
    }
}
