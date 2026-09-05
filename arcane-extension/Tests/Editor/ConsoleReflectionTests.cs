// ConsoleReflectionTests.cs — proves the reflected UnityEditor.LogEntries
// surface actually resolves and behaves on the Unity version running these
// tests, and that a snapshot read leaves the user's own Console window exactly
// as it found it.
//
// NOTE: these are Editor-mode NUnit tests that touch a REAL Unity Console
// (LogEntries is a live singleton, not something these tests can fake) — they
// need Unity's test runner and cannot execute headless. `csharp-compile.sh`
// proves they compile; running them requires opening this project in the
// Unity Editor and using the Test Runner window.

using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.TestTools;
using UnityIDE.Bridge;
using NUnit.Framework;

namespace UnityIDE.Tests
{
    public class ConsoleReflectionTests
    {
        /// <summary>
        /// Canary: if this fails, `ConsoleReflection` cannot resolve
        /// `UnityEditor.LogEntries` on the Unity version running the test —
        /// `getConsoleSnapshot` will silently degrade to `source: "hookRing"`
        /// for every caller, and the reflected member names in this file need
        /// updating for whatever changed.
        /// </summary>
        [Test]
        public void LogEntriesResolvesOnThisUnityVersion()
        {
            Assert.IsTrue(ConsoleReflection.TryResolve(),
                "ConsoleReflection could not resolve UnityEditor.LogEntries on this Unity version.");
        }

        [Test]
        public void SnapshotContainsAnErrorLoggedBeforeReading()
        {
            Assume.That(ConsoleReflection.TryResolve(), Is.True,
                "reflection must resolve on this Unity version for this test to be meaningful");

            string marker = "ConsoleReflectionTests-marker-" + Guid.NewGuid().ToString("N");
            LogAssert.Expect(LogType.Error, marker);
            Debug.LogError(marker);

            List<JsonValue> entries;
            int total;
            bool truncated;
            bool ok = ConsoleReflection.TrySnapshot(0, 200, 0, true, "newest", out entries, out total, out truncated);

            Assert.IsTrue(ok, "TrySnapshot must succeed once resolved");
            bool found = false;
            foreach (JsonValue e in entries)
            {
                string msg = e["message"].AsString;
                if (msg != null && msg.Contains(marker)) { found = true; break; }
            }
            Assert.IsTrue(found, "the error logged just before reading must appear in the snapshot");
        }

        /// <summary>
        /// Pins the priority-ordered Mode→wire-type classification against the
        /// REAL `UnityEditor.ConsoleWindow+Mode` enum on this Unity version —
        /// independent of `ConsoleReflection`'s own resolved fields, so a
        /// silent mismatch between the two cannot hide behind a shared bug.
        /// </summary>
        [Test]
        public void ModeFlagsMatchTheReflectedEnum()
        {
            Assume.That(ConsoleReflection.TryResolve(), Is.True);

            var modeType = typeof(UnityEditor.Editor).Assembly.GetType("UnityEditor.ConsoleWindow+Mode");
            Assume.That(modeType, Is.Not.Null,
                "this Unity version must expose ConsoleWindow+Mode for the test to be meaningful");
            Assume.That(modeType.IsEnum, Is.True);

            int scriptCompileError = Convert.ToInt32(Enum.Parse(modeType, "ScriptCompileError"));
            int scriptCompileWarning = Convert.ToInt32(Enum.Parse(modeType, "ScriptCompileWarning"));
            int scriptingException = Convert.ToInt32(Enum.Parse(modeType, "ScriptingException"));
            int scriptingWarning = Convert.ToInt32(Enum.Parse(modeType, "ScriptingWarning"));
            int scriptingAssertion = Convert.ToInt32(Enum.Parse(modeType, "ScriptingAssertion"));
            int log = Convert.ToInt32(Enum.Parse(modeType, "Log"));

            Assert.AreEqual("CompileError", ConsoleReflection.MapMode(scriptCompileError));
            Assert.AreEqual("CompileWarning", ConsoleReflection.MapMode(scriptCompileWarning));
            Assert.AreEqual("Exception", ConsoleReflection.MapMode(scriptingException));
            Assert.AreEqual("Warning", ConsoleReflection.MapMode(scriptingWarning));
            Assert.AreEqual("Assert", ConsoleReflection.MapMode(scriptingAssertion));
            Assert.AreEqual("Log", ConsoleReflection.MapMode(log));
        }

        [Test]
        public void ConsoleFlagsAreRestoredAfterSnapshot()
        {
            Assume.That(ConsoleReflection.TryResolve(), Is.True);

            var logEntriesType = typeof(UnityEditor.Editor).Assembly.GetType("UnityEditor.LogEntries");
            Assume.That(logEntriesType, Is.Not.Null);
            var flagsProp = logEntriesType.GetProperty("consoleFlags",
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic |
                System.Reflection.BindingFlags.Static);
            Assume.That(flagsProp, Is.Not.Null,
                "this Unity version must expose LogEntries.consoleFlags for the test to be meaningful");

            int before = Convert.ToInt32(flagsProp.GetValue(null, null));

            List<JsonValue> entries;
            int total;
            bool truncated;
            ConsoleReflection.TrySnapshot(0, 50, 0, true, "newest", out entries, out total, out truncated);

            int after = Convert.ToInt32(flagsProp.GetValue(null, null));
            Assert.AreEqual(before, after,
                "a snapshot read must restore the console's own display flags exactly — the agent " +
                "must never leave the user's Console window looking different than it found it");
        }

        [Test]
        public void ClearEmptiesTheConsoleAndBumpsEpoch()
        {
            Assume.That(ConsoleReflection.TryResolve(), Is.True);

            string marker = "ConsoleReflectionTests-clear-" + Guid.NewGuid().ToString("N");
            LogAssert.Expect(LogType.Warning, marker);
            Debug.LogWarning(marker);

            int epochBefore = ConsoleHook.ClearEpoch;

            bool cleared = ConsoleReflection.TryClear();
            // Mirrors ConsoleHandlers.ClearConsole, which always clears the ring
            // alongside a reflected clear.
            ConsoleHook.ClearRing();

            Assert.IsTrue(cleared, "TryClear must succeed once reflection has resolved");

            int errors, warnings, logs;
            Assert.IsTrue(ConsoleReflection.TryCounts(out errors, out warnings, out logs));
            Assert.AreEqual(0, errors + warnings + logs, "the console must be empty after Clear()");
            Assert.AreEqual(epochBefore + 1, ConsoleHook.ClearEpoch, "clearing must bump the epoch");
        }
    }
}
