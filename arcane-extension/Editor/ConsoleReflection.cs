// ConsoleReflection.cs — read Unity's REAL console history (LogEntries) via
// reflection, so `getConsoleSnapshot` can answer with everything Unity logged
// since the Editor opened, not just what streamed to the IDE after the bridge
// connected.
//
// `UnityEditor.LogEntries` / `UnityEditor.LogEntry` are internal Editor APIs —
// no public surface exists for "give me the console's history" — so this talks
// to them entirely by reflection, resolved once per AppDomain and cached
// (`TryResolve`). The exact member set has been stable across Unity's editor
// releases for years, but nothing here is guaranteed by Unity, which is why
// EVERY entry point is a `Try*` that returns false rather than throwing: a
// failure here must degrade the caller to the hook ring (`ConsoleHook`), never
// take the bridge down.
//
// Mode-flag values (`UnityEditor.ConsoleWindow+Mode`) and the console's own
// display flags (`UnityEditor.ConsoleWindow+ConsoleFlags`) are ALSO resolved by
// name where possible, with hardcoded fallbacks verified against a real Unity
// 6000.3 install (see the constants below) — a version whose enum resolves
// keeps working automatically if Unity ever renumbers the bits; a version that
// doesn't falls back to the numbers this package shipped with.
//
// consoleFlags handling: every read SAVES the current flags, forces the three
// LogLevel bits on and Collapse off (so a user's console filter never hides
// rows from the agent), and restores the saved value in a `finally` — the
// agent must never leave the user's own Console window looking different.

using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;

namespace UnityIDE.Bridge
{
    internal static class ConsoleReflection
    {
        // Hard cap on rows scanned per snapshot. Each row costs a handful of
        // reflection calls; this keeps a console with tens of thousands of
        // entries from blowing the RPC handler's timeout budget.
        private const int MaxScanRows = 5000;

        private const int MaxMessageBytes = 2048; // 2 KB
        private const int MaxStackBytes = 4096;    // 4 KB

        private static readonly Regex StackFrameLine =
            new Regex(@"\(at .+:\d+\)", RegexOptions.Compiled);

        private static bool _attempted;
        private static bool _resolved;

        private static Type _logEntriesType;
        private static Type _logEntryType;
        private static MethodInfo _startGettingEntries;
        private static MethodInfo _endGettingEntries;
        private static MethodInfo _getEntryInternal;
        private static MethodInfo _clearMethod;
        private static MethodInfo _getCountsByType;
        private static MethodInfo _getEntryCount;
        private static PropertyInfo _consoleFlagsProp;
        private static MethodInfo _setConsoleFlag;

        private static FieldInfo _msgField;
        private static FieldInfo _fileField;
        private static FieldInfo _lineField;
        private static FieldInfo _modeField;
        private static FieldInfo _callstackStartField;

        // ── Mode flags (UnityEditor.ConsoleWindow+Mode), resolved by name with
        // hardcoded fallbacks verified against Unity 6000.3.5f2. ─────────────
        private static int _mError = 1;
        private static int _mAssert = 2;
        private static int _mLog = 4;
        private static int _mFatal = 16;
        private static int _mAssetImportError = 64;
        private static int _mAssetImportWarning = 128;
        private static int _mScriptingError = 256;
        private static int _mScriptingWarning = 512;
        private static int _mScriptingLog = 1024;
        private static int _mScriptCompileError = 2048;
        private static int _mScriptCompileWarning = 4096;
        private static int _mScriptingException = 131072;
        private static int _mScriptingAssertion = 2097152;

        // ── Console display flags (UnityEditor.ConsoleWindow+ConsoleFlags),
        // resolved by name with hardcoded fallbacks verified against Unity
        // 6000.3.5f2. ─────────────────────────────────────────────────────────
        private static int _cfCollapse = 1;
        private static int _cfLogLevelLog = 128;
        private static int _cfLogLevelWarning = 256;
        private static int _cfLogLevelError = 512;

        /// <summary>Resolve every reflected member once per AppDomain. Never throws.</summary>
        public static bool TryResolve()
        {
            if (_attempted) return _resolved;
            _attempted = true;
            try { _resolved = Resolve(); }
            catch { _resolved = false; }
            return _resolved;
        }

        private static bool Resolve()
        {
            Assembly asm = typeof(UnityEditor.Editor).Assembly;

            _logEntriesType = asm.GetType("UnityEditor.LogEntries") ?? asm.GetType("UnityEditorInternal.LogEntries");
            if (_logEntriesType == null) return false;

            _logEntryType = asm.GetType("UnityEditor.LogEntry") ?? asm.GetType("UnityEditorInternal.LogEntry");
            if (_logEntryType == null) return false;

            const BindingFlags SB = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;
            const BindingFlags IB = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

            _startGettingEntries = _logEntriesType.GetMethod("StartGettingEntries", SB, null, Type.EmptyTypes, null);
            _endGettingEntries = _logEntriesType.GetMethod("EndGettingEntries", SB, null, Type.EmptyTypes, null);
            _getEntryInternal = _logEntriesType.GetMethod("GetEntryInternal", SB);
            _clearMethod = _logEntriesType.GetMethod("Clear", SB, null, Type.EmptyTypes, null);
            _getCountsByType = _logEntriesType.GetMethod("GetCountsByType", SB);
            _getEntryCount = _logEntriesType.GetMethod("GetEntryCount", SB);
            _consoleFlagsProp = _logEntriesType.GetProperty("consoleFlags", SB);
            _setConsoleFlag = _logEntriesType.GetMethod("SetConsoleFlag", SB);

            if (_startGettingEntries == null || _endGettingEntries == null || _getEntryInternal == null ||
                _clearMethod == null || _getCountsByType == null)
                return false;
            // Need at least one way to change the console's display flags.
            if (_consoleFlagsProp == null && _setConsoleFlag == null) return false;

            _msgField = _logEntryType.GetField("message", IB) ?? _logEntryType.GetField("condition", IB);
            _fileField = _logEntryType.GetField("file", IB);
            _lineField = _logEntryType.GetField("line", IB);
            _modeField = _logEntryType.GetField("mode", IB);
            _callstackStartField = _logEntryType.GetField("callstackTextStartUTF8", IB);

            if (_msgField == null || _modeField == null) return false;

            ResolveModeFlags(asm);
            ResolveConsoleFlags(asm);
            return true;
        }

        private static void ResolveModeFlags(Assembly asm)
        {
            Type modeType = asm.GetType("UnityEditor.ConsoleWindow+Mode");
            _mError = ResolveFlag(modeType, "Error", _mError);
            _mAssert = ResolveFlag(modeType, "Assert", _mAssert);
            _mLog = ResolveFlag(modeType, "Log", _mLog);
            _mFatal = ResolveFlag(modeType, "Fatal", _mFatal);
            _mAssetImportError = ResolveFlag(modeType, "AssetImportError", _mAssetImportError);
            _mAssetImportWarning = ResolveFlag(modeType, "AssetImportWarning", _mAssetImportWarning);
            _mScriptingError = ResolveFlag(modeType, "ScriptingError", _mScriptingError);
            _mScriptingWarning = ResolveFlag(modeType, "ScriptingWarning", _mScriptingWarning);
            _mScriptingLog = ResolveFlag(modeType, "ScriptingLog", _mScriptingLog);
            _mScriptCompileError = ResolveFlag(modeType, "ScriptCompileError", _mScriptCompileError);
            _mScriptCompileWarning = ResolveFlag(modeType, "ScriptCompileWarning", _mScriptCompileWarning);
            _mScriptingException = ResolveFlag(modeType, "ScriptingException", _mScriptingException);
            _mScriptingAssertion = ResolveFlag(modeType, "ScriptingAssertion", _mScriptingAssertion);
        }

        private static void ResolveConsoleFlags(Assembly asm)
        {
            Type cfType = asm.GetType("UnityEditor.ConsoleWindow+ConsoleFlags");
            _cfCollapse = ResolveFlag(cfType, "Collapse", _cfCollapse);
            _cfLogLevelLog = ResolveFlag(cfType, "LogLevelLog", _cfLogLevelLog);
            _cfLogLevelWarning = ResolveFlag(cfType, "LogLevelWarning", _cfLogLevelWarning);
            _cfLogLevelError = ResolveFlag(cfType, "LogLevelError", _cfLogLevelError);
        }

        private static int ResolveFlag(Type enumType, string name, int fallback)
        {
            if (enumType == null || !enumType.IsEnum) return fallback;
            try
            {
                if (!Enum.IsDefined(enumType, name)) return fallback;
                return Convert.ToInt32(Enum.Parse(enumType, name));
            }
            catch { return fallback; }
        }

        /// <summary>
        /// Classify a raw `LogEntry.mode` bitmask into the bridge's wire log
        /// type. Priority-ordered: the first matching bit family wins, mirroring
        /// how ConsoleWindow itself picks one icon per row.
        /// </summary>
        internal static string MapMode(int mode)
        {
            if ((mode & _mScriptCompileError) != 0) return "CompileError";
            if ((mode & _mScriptCompileWarning) != 0) return "CompileWarning";
            if ((mode & _mScriptingException) != 0) return "Exception";
            if ((mode & (_mScriptingAssertion | _mAssert)) != 0) return "Assert";
            if ((mode & (_mScriptingError | _mError | _mFatal | _mAssetImportError)) != 0) return "Error";
            if ((mode & (_mScriptingWarning | _mAssetImportWarning)) != 0) return "Warning";
            return "Log";
        }

        /// <summary>
        /// The OR of every Mode bit that can produce the given wire type name
        /// (the inverse of <see cref="MapMode"/>), for building a row filter
        /// mask from the RPC's `types` param. Unknown names contribute nothing.
        /// </summary>
        public static int ModeMaskForWireType(string wireType)
        {
            switch (wireType)
            {
                case "CompileError": return _mScriptCompileError;
                case "CompileWarning": return _mScriptCompileWarning;
                case "Exception": return _mScriptingException;
                case "Assert": return _mScriptingAssertion | _mAssert;
                case "Error": return _mScriptingError | _mError | _mFatal | _mAssetImportError;
                case "Warning": return _mScriptingWarning | _mAssetImportWarning;
                case "Log": return _mLog | _mScriptingLog;
                default: return 0;
            }
        }

        private static bool TryGetConsoleFlags(out int flags)
        {
            flags = 0;
            if (_consoleFlagsProp == null || !_consoleFlagsProp.CanRead) return false;
            try
            {
                flags = Convert.ToInt32(_consoleFlagsProp.GetValue(null, null));
                return true;
            }
            catch { return false; }
        }

        private static void SetConsoleFlags(int flags)
        {
            if (_consoleFlagsProp != null && _consoleFlagsProp.CanWrite)
            {
                try { _consoleFlagsProp.SetValue(null, flags, null); return; }
                catch { /* fall through to per-bit toggling */ }
            }
            SetFlagBit(_cfCollapse, (flags & _cfCollapse) != 0);
            SetFlagBit(_cfLogLevelLog, (flags & _cfLogLevelLog) != 0);
            SetFlagBit(_cfLogLevelWarning, (flags & _cfLogLevelWarning) != 0);
            SetFlagBit(_cfLogLevelError, (flags & _cfLogLevelError) != 0);
        }

        private static void SetFlagBit(int bit, bool value)
        {
            if (_setConsoleFlag == null) return;
            try { _setConsoleFlag.Invoke(null, new object[] { bit, value }); }
            catch { /* best-effort */ }
        }

        /// <summary>Force every level visible and collapse off, so a user's own
        /// console filter can never hide rows from the agent.</summary>
        private static void ForceReadableFlags()
        {
            int flags;
            if (TryGetConsoleFlags(out flags))
            {
                SetConsoleFlags((flags | _cfLogLevelLog | _cfLogLevelWarning | _cfLogLevelError) & ~_cfCollapse);
            }
            else
            {
                SetFlagBit(_cfLogLevelLog, true);
                SetFlagBit(_cfLogLevelWarning, true);
                SetFlagBit(_cfLogLevelError, true);
                SetFlagBit(_cfCollapse, false);
            }
        }

        /// <summary>
        /// Read Unity's console counts (ALL entries, not just a page). False on
        /// any reflection failure — callers fall back to counting the hook ring.
        /// </summary>
        public static bool TryCounts(out int errors, out int warnings, out int logs)
        {
            errors = warnings = logs = 0;
            if (!TryResolve()) return false;
            try
            {
                object[] args = { 0, 0, 0 };
                _getCountsByType.Invoke(null, args);
                errors = Convert.ToInt32(args[0]);
                warnings = Convert.ToInt32(args[1]);
                logs = Convert.ToInt32(args[2]);
                return true;
            }
            catch { errors = warnings = logs = 0; return false; }
        }

        /// <summary>Clear Unity's real console. False on any reflection failure.</summary>
        public static bool TryClear()
        {
            if (!TryResolve()) return false;
            try { _clearMethod.Invoke(null, null); return true; }
            catch { return false; }
        }

        /// <summary>
        /// Read a page of Unity's console history, filtered by `typeMask` (an OR
        /// of Mode bits from <see cref="ModeMaskForWireType"/>; 0 = no filter),
        /// ordered newest-first unless `order` is "oldest". False on ANY
        /// reflection failure — the handler falls back to the hook ring, and
        /// `entries`/`total` are reset to empty/zero so a caller that ignores the
        /// return value still sees an honestly empty result rather than partial
        /// data from a failed read.
        /// </summary>
        public static bool TrySnapshot(
            int offset, int limit, int typeMask, bool includeStack, string order,
            out List<JsonValue> entries, out int total, out bool truncated)
        {
            entries = new List<JsonValue>();
            total = 0;
            truncated = false;
            if (!TryResolve()) return false;

            int savedFlags;
            bool hadFlags = TryGetConsoleFlags(out savedFlags);
            ForceReadableFlags();
            try
            {
                int count;
                try { count = Convert.ToInt32(_startGettingEntries.Invoke(null, null)); }
                catch { return false; }

                object entryObj = Activator.CreateInstance(_logEntryType);
                var matched = new List<JsonValue>();
                int scanCount = Math.Min(count, MaxScanRows);
                for (int row = 0; row < scanCount; row++)
                {
                    bool ok;
                    try { ok = (bool)_getEntryInternal.Invoke(null, new object[] { row, entryObj }); }
                    catch { continue; }
                    if (!ok) continue;

                    int mode;
                    try { mode = Convert.ToInt32(_modeField.GetValue(entryObj)); }
                    catch { continue; }
                    if (typeMask != 0 && (mode & typeMask) == 0) continue;

                    matched.Add(BuildEntry(row, mode, entryObj, includeStack));
                }

                total = matched.Count;
                if (!string.Equals(order, "oldest", StringComparison.OrdinalIgnoreCase))
                    matched.Reverse();

                int start = Math.Max(0, offset);
                int end = Math.Min(matched.Count, start + Math.Max(0, limit));
                for (int i = start; i < end; i++) entries.Add(matched[i]);
                truncated = count > scanCount || end < matched.Count;
                return true;
            }
            catch
            {
                entries = new List<JsonValue>();
                total = 0;
                truncated = false;
                return false;
            }
            finally
            {
                try { _endGettingEntries.Invoke(null, null); } catch { /* best-effort */ }
                if (hadFlags) SetConsoleFlags(savedFlags);
            }
        }

        private static JsonValue BuildEntry(int row, int mode, object entryObj, bool includeStack)
        {
            string raw = _msgField.GetValue(entryObj) as string ?? "";
            string message, stack;
            SplitMessage(raw, entryObj, out message, out stack);

            string file = "";
            if (_fileField != null)
            {
                try { file = _fileField.GetValue(entryObj) as string ?? ""; } catch { /* best-effort */ }
            }
            int line = 0;
            if (_lineField != null)
            {
                try { line = Convert.ToInt32(_lineField.GetValue(entryObj)); } catch { /* best-effort */ }
            }
            int rowCount = 1;
            if (_getEntryCount != null)
            {
                try { rowCount = Convert.ToInt32(_getEntryCount.Invoke(null, new object[] { row })); }
                catch { rowCount = 1; }
            }
            if (rowCount < 1) rowCount = 1;

            var e = JsonValue.NewObject();
            e["seq"] = row;
            e["logType"] = MapMode(mode);
            e["message"] = CapUtf8(message, MaxMessageBytes);
            e["stackTrace"] = includeStack ? CapUtf8(stack, MaxStackBytes) : "";
            e["file"] = file;
            e["line"] = line;
            e["count"] = rowCount;
            return e;
        }

        /// <summary>
        /// Split a LogEntry's `message` into the visible line(s) and the
        /// appended stack trace. Uses the UTF8 byte offset Unity records
        /// (`callstackTextStartUTF8`) when present; otherwise falls back to the
        /// first line that looks like a Unity stack frame ("(at File.cs:12)").
        /// </summary>
        private static void SplitMessage(string raw, object entryObj, out string message, out string stack)
        {
            message = raw ?? "";
            stack = "";
            if (string.IsNullOrEmpty(raw)) return;

            int utf8Start = -1;
            if (_callstackStartField != null)
            {
                try { utf8Start = Convert.ToInt32(_callstackStartField.GetValue(entryObj)); }
                catch { utf8Start = -1; }
            }

            if (utf8Start > 0)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(raw);
                if (utf8Start < bytes.Length)
                {
                    string head = Encoding.UTF8.GetString(bytes, 0, utf8Start);
                    message = head.TrimEnd('\n', '\r');
                    stack = raw.Substring(Math.Min(head.Length, raw.Length));
                    return;
                }
                // Offset at/past the end: nothing left over — the whole thing is the message.
                message = raw;
                stack = "";
                return;
            }

            string[] lines = raw.Split('\n');
            int splitLine = -1;
            for (int i = 0; i < lines.Length; i++)
            {
                if (StackFrameLine.IsMatch(lines[i])) { splitLine = i; break; }
            }
            if (splitLine <= 0)
            {
                message = raw.TrimEnd('\n', '\r');
                stack = "";
                return;
            }
            message = string.Join("\n", lines, 0, splitLine).TrimEnd('\n', '\r');
            stack = string.Join("\n", lines, splitLine, lines.Length - splitLine);
        }

        /// <summary>Cap a string to `maxBytes` of UTF-8, on a byte boundary that
        /// never splits a multi-byte character. Shared with ConsoleHook's
        /// persisted-ring caps.</summary>
        internal static string CapUtf8(string s, int maxBytes)
        {
            if (string.IsNullOrEmpty(s)) return s ?? "";
            byte[] bytes = Encoding.UTF8.GetBytes(s);
            if (bytes.Length <= maxBytes) return s;
            int len = maxBytes;
            // Back off while sitting mid-way through a multi-byte UTF-8 sequence
            // (continuation bytes are 10xxxxxx).
            while (len > 0 && (bytes[len] & 0xC0) == 0x80) len--;
            return Encoding.UTF8.GetString(bytes, 0, len) + "…";
        }
    }
}
