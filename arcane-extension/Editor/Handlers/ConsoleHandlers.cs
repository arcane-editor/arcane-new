// ConsoleHandlers.cs — pull-based console RPCs: `getConsoleSnapshot` (Unity's
// real console history via `ConsoleReflection`, falling back to the bridge's
// own `ConsoleHook` ring) and `clearConsole`.
//
// Until this file, Unity console logs were push-ONLY (`ConsoleHook`'s
// `log_batch`): the agent could only ever see what had streamed to the IDE
// since the bridge connected. `getConsoleSnapshot` answers "what does Unity's
// console say right now", including everything logged before the IDE ever
// opened this project.
//
// `ConsoleReflection` is never trusted blindly: every failure — an
// unsupported Editor version, a mid-call exception, anything — falls back to
// `ConsoleHook`'s ring, and the response says so via `source: "hookRing"`
// rather than silently returning a degraded answer that looks the same as the
// real thing (Global Constraint 2).

using System;
using System.Collections.Generic;

namespace UnityIDE.Bridge
{
    internal static class ConsoleHandlers
    {
        private const int DefaultLimit = 100;
        private const int MaxLimit = 200;

        public static void Register(BridgeClient client)
        {
            RpcDispatcher.Register("getConsoleSnapshot", GetConsoleSnapshot);
            RpcDispatcher.Register("clearConsole", ClearConsole);
        }

        private static JsonValue GetConsoleSnapshot(JsonValue p)
        {
            int offset = p["offset"].IsNumber ? Math.Max(0, p["offset"].AsInt) : 0;
            int limit = p["limit"].IsNumber ? p["limit"].AsInt : DefaultLimit;
            if (limit <= 0) limit = DefaultLimit;
            if (limit > MaxLimit) limit = MaxLimit;
            bool includeStack = p.ContainsKey("includeStackTrace") ? p["includeStackTrace"].AsBool : true;
            string order = p["order"].AsStringOr("newest");

            HashSet<string> typeNames = null;
            int typeMask = 0;
            JsonValue typesParam = p["types"];
            if (typesParam != null && typesParam.IsArray && typesParam.Count > 0)
            {
                typeNames = new HashSet<string>(StringComparer.Ordinal);
                foreach (JsonValue t in typesParam.Array)
                {
                    string name = t.AsString;
                    if (string.IsNullOrEmpty(name)) continue;
                    typeNames.Add(name);
                    typeMask |= ConsoleReflection.ModeMaskForWireType(name);
                }
            }

            List<JsonValue> entries;
            int total;
            bool truncated;
            string source;
            bool hasHistory;
            int errors, warnings, logs;

            if (ConsoleReflection.TrySnapshot(offset, limit, typeMask, includeStack, order, out entries, out total, out truncated))
            {
                source = "logEntries";
                hasHistory = true;
                if (!ConsoleReflection.TryCounts(out errors, out warnings, out logs))
                {
                    errors = warnings = logs = 0;
                }
            }
            else
            {
                ConsoleHook.TrySnapshot(offset, limit, typeNames, includeStack, order, out entries, out total);
                truncated = offset + entries.Count < total;
                source = "hookRing";
                hasHistory = false;
                ConsoleHook.CountsInRing(out errors, out warnings, out logs);
            }

            var counts = JsonValue.NewObject();
            counts["errors"] = errors;
            counts["warnings"] = warnings;
            counts["logs"] = logs;

            var arr = JsonValue.NewArray();
            foreach (JsonValue e in entries) arr.Add(e);

            var caps = JsonValue.NewObject();
            // Whether Unity's REAL console can be cleared — the ring can always
            // be cleared, so this is not that; it tells the caller whether
            // "Clear here and in Unity" would do anything to Unity's own console.
            caps["canClear"] = ConsoleReflection.TryResolve();
            caps["hasHistoryBeforeConnect"] = hasHistory;

            var result = JsonValue.NewObject();
            result["source"] = source;
            result["epoch"] = ConsoleHook.ClearEpoch;
            result["total"] = total;
            result["offset"] = offset;
            result["counts"] = counts;
            result["entries"] = arr;
            result["truncated"] = truncated;
            result["capabilities"] = caps;
            return result;
        }

        private static JsonValue ClearConsole(JsonValue p)
        {
            // Resolution and the actual Clear() call are distinguished on purpose:
            // an unsupported Editor version (resolve fails) is reported honestly as
            // `ok:false` — nothing about Unity's console changed. A resolved API
            // whose Clear() call itself misbehaves still leaves the bridge's own
            // ring cleared, which is worth reporting as a (degraded) success rather
            // than a hard error.
            bool resolved = ConsoleReflection.TryResolve();
            bool clearedUnity = resolved && ConsoleReflection.TryClear();

            // Always, regardless of the above — this is the bridge's own memory
            // and it must reflect "the user just cleared the console" either way.
            ConsoleHook.ClearRing();

            var result = JsonValue.NewObject();
            if (clearedUnity)
            {
                result["ok"] = true;
                result["cleared"] = "logEntries";
                result["epoch"] = ConsoleHook.ClearEpoch;
                return result;
            }
            if (!resolved)
            {
                result["ok"] = false;
                result["reason"] = "Clearing Unity's console is not available on this Unity version.";
                return result;
            }

            result["ok"] = true;
            result["cleared"] = "hookRing";
            result["epoch"] = ConsoleHook.ClearEpoch;
            return result;
        }
    }
}
