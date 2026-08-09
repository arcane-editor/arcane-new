using System;
using System.IO;
using System.Threading;
using Arcane.Bridge;
using NUnit.Framework;

namespace Arcane.Tests
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
            _root = Path.Combine(Path.GetTempPath(), "arcane-thread-" + Path.GetRandomFileName());
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
                client.Stop();
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
                client.Stop();
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
    }
}
