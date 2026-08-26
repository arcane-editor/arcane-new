using System;
using System.IO;
using System.Threading;
using UnityIDE.Bridge;
using NUnit.Framework;

namespace UnityIDE.Tests
{
    /// <summary>
    /// Thread-affinity guarantees of the bridge worker.
    ///
    /// Regression cover for: "UnityException: GetBool can only be called from the
    /// main thread" thrown out of BridgeBootstrap.OnConnectionStateChanged. The
    /// handler legitimately wants SessionState (to dedupe the "Connected" log
    /// across domain reloads), but ConnectionStateChanged was raised straight from
    /// the worker thread, where every Unity API throws.
    /// </summary>
    public class BridgeThreadingTests
    {
        private string _root;
        private string _bridgeDir;

        [SetUp]
        public void SetUp()
        {
            _root = Path.Combine(Path.GetTempPath(), "unityide-thread-" + Path.GetRandomFileName());
            _bridgeDir = Discovery.BridgeDir(_root);
            Directory.CreateDirectory(_bridgeDir);
            MainThreadDispatcher.Clear();
            MainThreadDispatcher.CaptureMainThread();
        }

        [TearDown]
        public void TearDown()
        {
            MainThreadDispatcher.Clear();
            try { Directory.Delete(_root, true); } catch { }
        }

        /// <summary>Stand in for the IDE: publish bridge.json and create the journal it owns.</summary>
        private void SimulateIdeSession(string ideSessionId)
        {
            File.WriteAllText(
                Discovery.BridgeJsonPath(_root),
                "{\"transport\":\"journal\",\"protocolVersion\":2,\"ideSessionId\":\"" +
                ideSessionId + "\",\"ideVersion\":\"test\",\"idePid\":1}");
            // The IDE owns to-unity.jsonl; BridgeClient waits for it to exist.
            File.WriteAllBytes(Discovery.ToUnityJournalPath(_root), new byte[0]);
        }

        [Test]
        public void ConnectionStateChangedIsRaisedOnTheMainThread()
        {
            SimulateIdeSession("ide-session-1");

            int mainThreadId = Thread.CurrentThread.ManagedThreadId;
            int handlerThreadId = -1;
            var raised = new ManualResetEventSlim(false);

            var client = new BridgeClient(_root, () => JsonValue.NewObject());
            client.ConnectionStateChanged += connected =>
            {
                if (!connected) return;
                handlerThreadId = Thread.CurrentThread.ManagedThreadId;
                raised.Set();
            };

            try
            {
                client.Start();

                // Stand in for EditorApplication.update, which is what drives the
                // dispatcher in the real editor.
                var deadline = DateTime.UtcNow.AddSeconds(10);
                while (!raised.IsSet && DateTime.UtcNow < deadline)
                {
                    MainThreadDispatcher.Pump();
                    Thread.Sleep(10);
                }
                MainThreadDispatcher.Pump();

                Assert.IsTrue(raised.IsSet, "the bridge never reported a connection");
                Assert.AreEqual(mainThreadId, handlerThreadId,
                    "ConnectionStateChanged must be raised on the main thread — subscribers " +
                    "call SessionState, which throws UnityException off it");
            }
            finally
            {
                client.Stop(StopReason.Quit);
            }
        }

        [Test]
        public void HandshakeWritesConnectionInitEchoingTheIdeSessionId()
        {
            SimulateIdeSession("ide-session-abc");

            var client = new BridgeClient(_root, () => JsonValue.NewObject());
            try
            {
                client.Start();

                string journal = Discovery.ToIdeJournalPath(_root);
                var deadline = DateTime.UtcNow.AddSeconds(10);
                string first = null;
                while (first == null && DateTime.UtcNow < deadline)
                {
                    MainThreadDispatcher.Pump();
                    Thread.Sleep(10);
                    if (!File.Exists(journal)) continue;
                    using (var fs = new FileStream(journal, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var sr = new StreamReader(fs))
                    {
                        string line = sr.ReadLine();
                        if (!string.IsNullOrEmpty(line)) first = line;
                    }
                }

                Assert.IsNotNull(first, "no connection_init was written");
                JsonValue msg = JsonValue.TryParse(first);
                Assert.AreEqual("connection_init", msg["type"].AsString);
                Assert.AreEqual("ide-session-abc", msg["payload"]["ideSessionId"].AsString,
                    "the IDE gates all writes on seeing its own session id echoed back");
                Assert.IsFalse(string.IsNullOrEmpty(msg["payload"]["unitySessionId"].AsString));
            }
            finally
            {
                client.Stop(StopReason.Quit);
            }
        }

        [Test]
        public void DispatcherRunsQueuedWorkOnlyWhenPumped()
        {
            // The mechanism the fix rests on: work queued from a background thread
            // must not run until the main thread pumps.
            int ranOnThread = -1;
            var queued = new ManualResetEventSlim(false);

            var t = new Thread(() =>
            {
                MainThreadDispatcher.Enqueue(() => ranOnThread = Thread.CurrentThread.ManagedThreadId);
                queued.Set();
            });
            t.Start();
            Assert.IsTrue(queued.Wait(5000));
            t.Join(5000);

            Assert.AreEqual(-1, ranOnThread, "queued work must not run on the enqueuing thread");

            MainThreadDispatcher.Pump();
            Assert.AreEqual(Thread.CurrentThread.ManagedThreadId, ranOnThread,
                "Pump must run the work on the pumping (main) thread");
        }

        [Test]
        public void PumpKeepsGoingWhenOneActionThrows()
        {
            bool second = false;
            MainThreadDispatcher.Enqueue(() => throw new InvalidOperationException("boom"));
            MainThreadDispatcher.Enqueue(() => second = true);

            MainThreadDispatcher.Pump();

            Assert.IsTrue(second, "one throwing action must not starve the rest of the queue");
        }

        /// <summary>
        /// The guarantee that keeps a domain reload from leaving two writers on
        /// to-ide.jsonl.
        ///
        /// The bridge worker calls EnqueueAndWait to build connection_init. A
        /// reload removes the pump, so without a cancellation signal that call
        /// blocks for its full timeout, Stop()'s Join(1500) times out, the
        /// journals are never closed, and the next AppDomain opens its own writer
        /// on a file the old worker can still append to.
        /// </summary>
        [Test]
        public void BeginShutdownReleasesABlockedEnqueueAndWait()
        {
            Exception thrown = null;
            var returned = new ManualResetEventSlim(false);

            // Deliberately from a background thread: on the main thread
            // EnqueueAndWait runs inline and never waits at all.
            var worker = new Thread(() =>
            {
                try
                {
                    // Never pumped, and a timeout far beyond the assert below —
                    // so returning at all proves cancellation did it.
                    MainThreadDispatcher.EnqueueAndWait(() => JsonValue.NewObject(), 60000);
                }
                catch (Exception e) { thrown = e; }
                finally { returned.Set(); }
            });
            worker.Start();

            Thread.Sleep(100); // let it actually block
            Assert.IsFalse(returned.IsSet, "test premise: the call must be blocked");

            MainThreadDispatcher.BeginShutdown();

            Assert.IsTrue(returned.Wait(5000),
                "BeginShutdown must release waiters — a worker parked here cannot be joined");
            worker.Join(5000);
            Assert.IsTrue(thrown is OperationCanceledException,
                "cancellation must be distinguishable from a genuine timeout");

            // CaptureMainThread re-arms the dispatcher for the next AppDomain.
            MainThreadDispatcher.CaptureMainThread();
            Assert.AreEqual(7, MainThreadDispatcher.EnqueueAndWait(() => 7, 1000),
                "a re-captured dispatcher must serve calls again");
        }

        [Test]
        public void DomainReloadAnnouncesReloadingAndQuittingAnnouncesDisconnect()
        {
            // A recompile is not a disconnect: the same session resumes in the next
            // AppDomain at its persisted offset. Announcing a disconnect for it
            // dropped in-flight RPCs and drove a visible reconnect on every script
            // change, which is exactly what the journal transport exists to avoid.
            Assert.AreEqual("reloading", LastMessageTypeAfterStop(StopReason.Reload));
            Assert.AreEqual("disconnect", LastMessageTypeAfterStop(StopReason.Quit));
        }

        /// <summary>Run one client through a handshake, stop it, return the last line's type.</summary>
        private string LastMessageTypeAfterStop(StopReason reason)
        {
            SimulateIdeSession("ide-session-" + reason);

            var client = new BridgeClient(_root, () => JsonValue.NewObject());
            client.Start();
            PumpUntilHandshake(client);
            client.Stop(reason);

            string[] lines = File.ReadAllLines(Discovery.ToIdeJournalPath(_root));
            Assert.IsTrue(lines.Length > 0, "the journal is empty");
            JsonValue last = JsonValue.TryParse(lines[lines.Length - 1]);
            return last["type"].AsString;
        }

        [Test]
        public void AWarmResumeDoesNotReAnnounce()
        {
            // Sequence C: after a domain reload the restored session resumes
            // mid-stream. Re-announcing would force the IDE to treat it as a new
            // Unity session — truncating its journal and re-handshaking — on every
            // single recompile, and it costs a main-thread round trip at the moment
            // the main thread is busiest.
            SimulateIdeSession("ide-session-warm");

            var first = new BridgeClient(_root, () => JsonValue.NewObject());
            first.Start();
            PumpUntilHandshake(first);
            string unityId = first.UnitySessionId;
            string ideId = first.HandshakenIdeSessionId;
            long offset = first.ReadOffset, epoch = first.ReadEpoch;
            first.Stop(StopReason.Reload);

            Assert.IsFalse(string.IsNullOrEmpty(unityId), "test premise: the first client handshook");
            int before = CountConnectionInits();

            // The next AppDomain restores identity from SessionState and resumes.
            var resumed = new BridgeClient(_root, () => JsonValue.NewObject());
            resumed.RestoreSession(unityId, ideId, offset, epoch);
            try
            {
                resumed.Start();
                var deadline = DateTime.UtcNow.AddSeconds(2);
                while (DateTime.UtcNow < deadline)
                {
                    MainThreadDispatcher.Pump();
                    Thread.Sleep(10);
                }

                Assert.AreEqual(unityId, resumed.UnitySessionId,
                    "a warm resume must keep the session id, not mint a new one");
                Assert.AreEqual(before, CountConnectionInits(),
                    "a warm resume must not write a second connection_init");
            }
            finally
            {
                resumed.Stop(StopReason.Quit);
            }
        }

        private int CountConnectionInits()
        {
            string journal = Discovery.ToIdeJournalPath(_root);
            if (!File.Exists(journal)) return 0;
            int n = 0;
            foreach (string line in File.ReadAllLines(journal))
            {
                if (string.IsNullOrEmpty(line)) continue;
                JsonValue v = JsonValue.TryParse(line);
                if (v != null && v["type"].AsString == "connection_init") n++;
            }
            return n;
        }

        private void PumpUntilHandshake(BridgeClient client)
        {
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (!client.IsConnected && DateTime.UtcNow < deadline)
            {
                MainThreadDispatcher.Pump();
                Thread.Sleep(10);
            }
            MainThreadDispatcher.Pump();
            Assert.IsTrue(client.IsConnected, "the bridge never handshook");
        }
    }
}
