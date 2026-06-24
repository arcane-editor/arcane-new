// RpcDispatcher.cs — inbound rpc_request → handler → rpc_response.
//
// Handlers are registered into a name→func map. Each handler takes the request
// `params` JsonValue and returns a result JsonValue. EVERY handler runs on the
// MAIN THREAD (via MainThreadDispatcher.EnqueueAndWait) because handlers touch
// Unity APIs. The dispatch itself is invoked from the socket read loop
// (background thread).
//
// Error mapping (payload.error.code):
//   unknown method     → -32601 (MethodNotFound)
//   handler exception  → -32000 (InternalError) with the exception message
//
// The reply (rpc_response) carries the SAME id as the request.

using System;
using System.Collections.Generic;
using UnityEngine;

namespace Arcane.Bridge
{
    /// <summary>A single RPC handler: maps request params to a result value.</summary>
    internal delegate JsonValue RpcHandler(JsonValue @params);

    internal static class RpcDispatcher
    {
        private static readonly Dictionary<string, RpcHandler> Handlers =
            new Dictionary<string, RpcHandler>(StringComparer.Ordinal);

        // How long an RPC handler may run on the main thread before we give up
        // and return an error (keeps a hung handler from wedging the socket
        // thread forever; the IDE also has its own 10s RPC timeout).
        private const int HandlerTimeoutMs = 8000;

        public static void Register(string method, RpcHandler handler)
        {
            if (string.IsNullOrEmpty(method) || handler == null) return;
            Handlers[method] = handler;
        }

        public static void Clear() => Handlers.Clear();

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
                Debug.LogWarning("[ArcaneBridge] rpc_request missing id; method=" + method);
                return;
            }

            if (string.IsNullOrEmpty(method) || !Handlers.TryGetValue(method, out var handler))
            {
                send(Protocol.RpcErrorResult(id, RpcError.MethodNotFound,
                    "Unknown method: " + (method ?? "<null>")));
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
                Debug.LogError("[ArcaneBridge] RPC '" + method + "' failed: " + e);
            }

            send(reply);
        }
    }
}
