// CompilationHook.cs — report C# compilation lifecycle to the IDE.
//
//   CompilationPipeline.compilationStarted  → `compilation_started` { }
//   assemblyCompilationFinished (per-asm)    → accumulate CompilerMessage[]
//   CompilationPipeline.compilationFinished  → `compilation_finished`
//        { success, errors, warnings, messages:[{file,line,column,message,type}] }
//
// NOTE ON DOMAIN RELOAD: a successful script compile triggers a domain reload,
// which tears down and re-creates this static state. compilationFinished fires
// BEFORE the reload, so the finished message is sent in time. We also persist a
// lightweight "was compiling" marker is unnecessary because the IDE treats a
// fresh connection_init + a subsequent compilation_finished as authoritative.
//
// All callbacks here fire on the main thread.

using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace UnityIDE.Bridge
{
    internal static class CompilationHook
    {
        /// <summary>
        /// SessionState key holding the serialized payload of the last
        /// SUCCESSFUL compile. A successful compile is immediately followed by
        /// a domain reload that can eat the live compilation_finished message
        /// (worker wedged past Stop()'s Join, journals died with the
        /// AppDomain) — BridgeBootstrap replays this after the reload so the
        /// IDE's compile gate still resolves. Failed compiles don't reload, so
        /// their message flows normally and is never persisted here.
        /// </summary>
        internal const string PendingResultKey = "UnityIDE.Bridge.PendingCompileResult";

        private static BridgeClient _client;
        private static bool _installed;

        // Accumulated across per-assembly callbacks within a single compile cycle.
        private static readonly List<JsonValue> Messages = new List<JsonValue>();
        private static int _errors;
        private static int _warnings;

        public static void Install(BridgeClient client)
        {
            if (_installed) return;
            _installed = true;
            _client = client;
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyFinished;
        }

        public static void Uninstall()
        {
            if (!_installed) return;
            _installed = false;
            CompilationPipeline.compilationStarted -= OnCompilationStarted;
            CompilationPipeline.compilationFinished -= OnCompilationFinished;
            CompilationPipeline.assemblyCompilationFinished -= OnAssemblyFinished;
            _client = null;
        }

        private static void OnCompilationStarted(object context)
        {
            ResetAccumulator();
            // A new compile supersedes any pending post-reload replay.
            SessionState.EraseString(PendingResultKey);
            if (_client == null) return;
            _client.Send(Protocol.Envelope(MsgType.CompilationStarted, JsonValue.NewObject()));
        }

        // Per-assembly results arrive here as we go.
        private static void OnAssemblyFinished(string assemblyPath, CompilerMessage[] messages)
        {
            if (messages == null) return;
            foreach (var m in messages)
            {
                bool isError = m.type == CompilerMessageType.Error;
                if (isError) _errors++;
                else _warnings++;

                var entry = JsonValue.NewObject();
                entry["file"] = m.file ?? "";
                entry["line"] = m.line;
                entry["column"] = m.column;
                entry["message"] = m.message ?? "";
                entry["type"] = isError ? "Error" : "Warning";
                Messages.Add(entry);
            }
        }

        private static void OnCompilationFinished(object context)
        {
            if (_client == null) { ResetAccumulator(); return; }

            var msgArray = JsonValue.NewArray();
            foreach (var m in Messages) msgArray.Add(m);

            var payload = JsonValue.NewObject();
            payload["success"] = _errors == 0;
            payload["errors"] = _errors;
            payload["warnings"] = _warnings;
            payload["messages"] = msgArray;

            // Persist BEFORE sending: only a success reloads the domain (and
            // can therefore lose the live message). See PendingResultKey.
            if (_errors == 0)
            {
                try { SessionState.SetString(PendingResultKey, payload.Serialize()); }
                catch { /* replay is belt-and-braces; the live send below is primary */ }
            }

            _client.Send(Protocol.Envelope(MsgType.CompilationFinished, payload));
            ResetAccumulator();
        }

        private static void ResetAccumulator()
        {
            Messages.Clear();
            _errors = 0;
            _warnings = 0;
        }
    }
}
