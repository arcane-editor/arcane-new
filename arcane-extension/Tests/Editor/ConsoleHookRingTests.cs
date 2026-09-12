// ConsoleHookRingTests.cs — the hook ring's own contract, independent of
// whether `ConsoleReflection` resolves on the running Unity version: bounded
// capacity (oldest evicted first), a monotonic `Seq` starting at 1, and a
// persist/restore round-trip through SessionState across a simulated domain
// reload (Uninstall → Install).
//
// Uses `ConsoleHook.IngestForTests`/`ResetForTests` — deterministic seams that
// bypass `Application.logMessageReceivedThreaded` and its ~100ms flush timer,
// so these do not depend on Unity's real log-event timing. NOTE: `SessionState`
// itself is a real Unity Editor API, so these are Editor-mode NUnit tests that
// need Unity's test runner and cannot execute headless — see
// `ConsoleReflectionTests.cs`'s header for the same caveat.

using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityIDE.Bridge;
using NUnit.Framework;

namespace UnityIDE.Tests
{
    public class ConsoleHookRingTests
    {
        private string _root;

        [SetUp]
        public void SetUp()
        {
            _root = Path.Combine(Path.GetTempPath(), "unityide-consolering-" + Path.GetRandomFileName());
            Directory.CreateDirectory(_root);
            SessionState.EraseString(ConsoleHook.RingSessionKey);
            ConsoleHook.ResetForTests();
        }

        [TearDown]
        public void TearDown()
        {
            ConsoleHook.ResetForTests();
            SessionState.EraseString(ConsoleHook.RingSessionKey);
            try { Directory.Delete(_root, true); } catch { /* best-effort cleanup */ }
        }

        [Test]
        public void SeqIsMonotonicAndStartsAtOne()
        {
            long a = ConsoleHook.IngestForTests("one", "Log");
            long b = ConsoleHook.IngestForTests("two", "Log");
            long c = ConsoleHook.IngestForTests("three", "Log");

            Assert.AreEqual(1, a, "Seq must start at 1");
            Assert.Greater(b, a);
            Assert.Greater(c, b);
            Assert.AreEqual(c, ConsoleHook.CurrentSeq);
        }

        [Test]
        public void RingIsCappedAtTwoThousandEntriesDroppingOldestFirst()
        {
            const int total = 2500;
            for (int i = 0; i < total; i++)
            {
                ConsoleHook.IngestForTests("msg " + i, "Log");
            }

            List<JsonValue> entries;
            int ringTotal;
            ConsoleHook.Snapshot(0, total, null, false, "oldest", out entries, out ringTotal);

            Assert.AreEqual(2000, ringTotal, "the ring must cap at 2000 entries");
            Assert.AreEqual("msg 500", entries[0]["message"].AsString,
                "capping must drop the OLDEST entries first, keeping the most recent");
            Assert.AreEqual("msg 2499", entries[entries.Count - 1]["message"].AsString);
        }

        [Test]
        public void RingRoundTripsThroughSessionStateAcrossASimulatedReload()
        {
            var client = new BridgeClient(_root, () => JsonValue.NewObject());
            ConsoleHook.Install(client);
            try
            {
                ConsoleHook.IngestForTests("alpha", "Log");
                ConsoleHook.IngestForTests("beta", "Error");
                long seqBefore = ConsoleHook.CurrentSeq;

                // Simulates beforeAssemblyReload: persists the ring to SessionState.
                ConsoleHook.Uninstall();

                // Simulates the domain tear-down that follows — every in-memory
                // static is gone in the new AppDomain; SessionState is what survives.
                ConsoleHook.ResetForTests();
                Assert.AreEqual(0, ConsoleHook.CurrentSeq, "test premise: in-memory state was wiped");

                var resumed = new BridgeClient(_root, () => JsonValue.NewObject());
                ConsoleHook.Install(resumed); // restores from SessionState

                Assert.AreEqual(seqBefore, ConsoleHook.CurrentSeq,
                    "Seq must survive a persist/restore round-trip across a simulated reload");

                List<JsonValue> entries;
                int total;
                ConsoleHook.Snapshot(0, 10, null, true, "oldest", out entries, out total);
                Assert.AreEqual(2, total);
                Assert.AreEqual("alpha", entries[0]["message"].AsString);
                Assert.AreEqual("beta", entries[1]["message"].AsString);
            }
            finally
            {
                ConsoleHook.Uninstall();
            }
        }

        [Test]
        public void ClearRingBumpsEpochAndEmptiesTheRing()
        {
            ConsoleHook.IngestForTests("one", "Log");
            ConsoleHook.IngestForTests("two", "Error");
            int epochBefore = ConsoleHook.ClearEpoch;

            ConsoleHook.ClearRing();

            Assert.AreEqual(epochBefore + 1, ConsoleHook.ClearEpoch);
            List<JsonValue> entries;
            int total;
            ConsoleHook.Snapshot(0, 10, null, false, "newest", out entries, out total);
            Assert.AreEqual(0, total, "clearing the ring must empty it");
        }
    }
}
