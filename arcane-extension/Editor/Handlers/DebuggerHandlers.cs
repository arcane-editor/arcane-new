// DebuggerHandlers.cs — debugger discovery RPC.
//
//   getDebuggerEndpoint → { host:"127.0.0.1", port: 56000 + (pid % 1000), pid }
//
// The Mono soft-debugger that ships in the Unity Editor listens for the IDE
// debugger to attach. The conventional port derivation used by Unity tooling is
// 56000 + (editorProcessId % 1000); we report that plus the pid so the IDE's DAP
// host (task T6) can attach. Runs on the main thread via the dispatcher (it only
// reads the process id, but we keep the contract uniform).

using System.Diagnostics;

namespace UnityIDE.Bridge
{
    internal static class DebuggerHandlers
    {
        public static void Register(BridgeClient client)
        {
            RpcDispatcher.Register("getDebuggerEndpoint", GetDebuggerEndpoint);
        }

        private static JsonValue GetDebuggerEndpoint(JsonValue p)
        {
            int pid = Process.GetCurrentProcess().Id;
            var result = JsonValue.NewObject();
            result["host"] = "127.0.0.1";
            result["port"] = 56000 + (pid % 1000);
            result["pid"] = pid;
            return result;
        }
    }
}
