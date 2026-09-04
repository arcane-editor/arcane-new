#if UNITYIDE_HAS_TEST_FRAMEWORK
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor.TestTools.TestRunner.Api;
using UnityIDE.Bridge;
using NUnit.Framework;

namespace UnityIDE.Tests
{
    /// <summary>
    /// `runTests` going from a blocking "immediate ack, stream the rest" RPC to
    /// a QUEUED command whose real completion is `test_run_completed` (B3) —
    /// the same shape as `refreshAssets`/`requestCompile`'s `refresh_completed`,
    /// and for the same reason: Unity parks its main thread while its window is
    /// unfocused, and blocking a reply on that thread never made a test run
    /// start sooner, it just failed the wait.
    ///
    /// `RpcProtocolGateTests` already pins the generic queued-vs-blocking gate;
    /// these tests are about `runTests` specifically — that it really is
    /// registered queued, and that `BridgeTestCallbacks` stamps every push with
    /// the run's id (surviving the PlayMode domain reload that recreates the
    /// callbacks instance) and caps the failures it keeps verbatim.
    ///
    /// `BridgeTestCallbacks` is `internal` and takes an injectable sender
    /// precisely so these can run against fakes — no live Unity Editor, no real
    /// BridgeClient/journal — even though Unity's own Test Runner is the only
    /// thing that can actually EXECUTE them (see the class remarks below).
    /// </summary>
    public class TestRunProtocolTests
    {
        [SetUp]
        public void SetUp()
        {
            RpcDispatcher.Clear();
            MainThreadDispatcher.Clear();
            // Registering the test thread as "main" makes the blocking fallback
            // path (an IDE older than protocol 3) run its handler inline.
            MainThreadDispatcher.CaptureMainThread();
            TestRunnerHandlers.ClearActiveRun();
        }

        [TearDown]
        public void TearDown()
        {
            RpcDispatcher.Clear();
            MainThreadDispatcher.Clear();
            RpcDispatcher.SetIdeProtocolVersion(0);
            TestRunnerHandlers.ClearActiveRun();
            TestRunnerHandlers.SendOverrideForTests = null;
            TestRunnerHandlers.Shutdown();
        }

        private static JsonValue RunTestsRequest(string id, string mode, string filter, string runId)
        {
            var @params = JsonValue.NewObject();
            @params["mode"] = mode;
            if (filter != null) @params["filter"] = filter;
            if (runId != null) @params["runId"] = runId;

            var payload = JsonValue.NewObject();
            payload["method"] = "runTests";
            payload["params"] = @params;
            var msg = Protocol.Envelope(MsgType.RpcRequest, payload);
            msg["id"] = id;
            return msg;
        }

        [Test]
        public void RunTestsIsQueuedForACurrentIde()
        {
            // Register() creates the real TestRunnerApi if the Editor allows it,
            // and swallows the failure otherwise (EnsureCallbacks' own
            // try/catch) — either way, `runTests` must reach RpcDispatcher via
            // RegisterQueued, which is what this test actually pins. The queued
            // handler is never PUMPED here, so its body (SessionState,
            // TestRunnerApi.Execute) never runs.
            TestRunnerHandlers.Register(null);
            RpcDispatcher.SetIdeProtocolVersion(Discovery.ProtocolVersion);

            JsonValue reply = null;
            RpcDispatcher.Dispatch(
                RunTestsRequest("1", "EditMode", null, "run-1"),
                r => reply = r);

            Assert.IsNotNull(reply);
            Assert.IsTrue(reply["payload"]["result"]["queued"].AsBool,
                "runTests must be queued, not blocking — Unity's main thread may be parked when this arrives");
        }

        [Test]
        public void ActiveRunIdSurvivesReload()
        {
            TestRunnerHandlers.SetActiveRun("run-xyz", "PlayMode");

            // Simulate the domain reload a PlayMode run triggers: a BRAND NEW
            // BridgeTestCallbacks instance (exactly what EnsureCallbacks builds
            // after Register() runs again), holding none of the state the run
            // started with. It must recover the run's identity from
            // SessionState — the one thing built to survive this reload — not
            // from anything on the instance.
            var sent = new List<JsonValue>();
            var callbacks = new TestRunnerHandlers.BridgeTestCallbacks((Action<JsonValue>)(env => sent.Add(env)));

            callbacks.TestStarted(new FakeTestAdaptor { FullName = "Foo.Bar", IsSuite = false });

            Assert.AreEqual(1, sent.Count);
            Assert.AreEqual("run-xyz", sent[0]["payload"]["runId"].AsString,
                "the runId must survive reconstruction across the reload, not just within one instance's lifetime");
        }

        [Test]
        public void RunFinishedEmitsTestRunCompletedWithRunIdAndCappedFailures()
        {
            TestRunnerHandlers.SetActiveRun("run-42", "EditMode");
            var sent = new List<JsonValue>();
            var callbacks = new TestRunnerHandlers.BridgeTestCallbacks((Action<JsonValue>)(env => sent.Add(env)));

            callbacks.RunStarted(new FakeTestAdaptor { IsSuite = false, FullName = "Suite" });

            const int failCount = 60;
            for (int i = 0; i < failCount; i++)
            {
                var test = new FakeTestAdaptor { FullName = "Fixture.Test" + i, IsSuite = false };
                var result = new FakeTestResult
                {
                    Test = test,
                    TestStatus = TestStatus.Failed,
                    Duration = 0.01,
                    Message = "assertion failed " + i,
                    StackTrace = "at Fixture.Test" + i + "() (at Assets/Fixture.cs:" + i + ")",
                };
                callbacks.TestFinished(result);
            }

            var final = new FakeTestResult
            {
                Test = new FakeTestAdaptor { IsSuite = true, FullName = "Suite" },
                PassCount = 5,
                FailCount = failCount,
                SkipCount = 1,
                InconclusiveCount = 0,
                Duration = 3.4,
            };
            callbacks.RunFinished(final);

            var completed = sent.FirstOrDefault(e => e["type"].AsString == MsgType.TestRunCompleted);
            Assert.IsNotNull(completed, "RunFinished must push test_run_completed");
            var p = completed["payload"];

            Assert.AreEqual("run-42", p["runId"].AsString);
            Assert.IsTrue(p["ok"].AsBool);
            Assert.AreEqual("EditMode", p["mode"].AsString);
            Assert.AreEqual(5, p["passed"].AsInt);
            Assert.AreEqual(failCount, p["failed"].AsInt);
            Assert.AreEqual(1, p["skipped"].AsInt);
            Assert.AreEqual(5 + failCount + 1, p["total"].AsInt);
            Assert.AreEqual(50, p["failures"].Count, "failures are capped at 50, even though 60 tests failed");
            Assert.IsTrue(p["failuresTruncated"].AsBool,
                "more tests failed than were kept verbatim — the caller must not read the list as exhaustive");
            Assert.AreEqual("Fixture.Test0", p["failures"][0]["fullName"].AsString);

            Assert.IsNull(TestRunnerHandlers.GetActiveRun(),
                "RunFinished must erase the active-run marker so it cannot leak into the next run's early pushes");
        }

        [Test]
        public void SecondAskWhileActiveDoesNotDisturbTheFirstRunsKey()
        {
            // Fix-round-1 review finding F2: SetActiveRun used to run
            // unconditionally, so a second `runTests` arriving while run A was
            // still active would stomp A's key with B's — and when A actually
            // finished, RunFinished would read B's runId back out of
            // SessionState and push completion under the WRONG id, so A's
            // waiter burned its whole timeout waiting for a match that could
            // never come. `RunTests` must now bail out for the SECOND ask
            // before ever touching the key.
            var sent = new List<JsonValue>();
            TestRunnerHandlers.SendOverrideForTests = env => sent.Add(env);
            TestRunnerHandlers.Register(null);
            RpcDispatcher.SetIdeProtocolVersion(Discovery.ProtocolVersion);

            TestRunnerHandlers.SetActiveRun("run-A", "EditMode");

            JsonValue reply = null;
            RpcDispatcher.Dispatch(RunTestsRequest("2", "EditMode", null, "run-B"), r => reply = r);
            MainThreadDispatcher.Pump(); // actually run RunTests for the second ask

            var active = TestRunnerHandlers.GetActiveRun();
            Assert.IsNotNull(active, "run A's key must survive a second ask arriving while it is active");
            Assert.AreEqual("run-A", active["runId"].AsString);

            var completed = sent.FirstOrDefault(e => e["type"].AsString == MsgType.TestRunCompleted);
            Assert.IsNotNull(completed,
                "the second ask must get its OWN test_run_completed — RunFinished will never fire for it");
            Assert.AreEqual("run-B", completed["payload"]["runId"].AsString);
            Assert.IsFalse(completed["payload"]["ok"].AsBool);
            Assert.AreEqual("runner-unavailable", completed["payload"]["reason"].AsString);
        }

        [Test]
        public void BlockingDowngradeGetsAnHonestFailureReplyNotOkTrue()
        {
            // F3: an IDE older than protocol 3 takes the BLOCKING dispatch
            // path, so RunTests' own RETURN VALUE becomes the RPC reply — it
            // used to return a bare Ok() on every failure branch (framework
            // missing, Execute() threw, another run active), so a refused ask
            // read as success to that IDE.
            TestRunnerHandlers.SetActiveRun("run-already-active", "EditMode");
            TestRunnerHandlers.Register(null);
            RpcDispatcher.SetIdeProtocolVersion(2); // predates queued acks (MinQueuedProtocol = 3)

            JsonValue reply = null;
            RpcDispatcher.Dispatch(RunTestsRequest("1", "EditMode", null, "run-new"), r => reply = r);

            Assert.IsNotNull(reply);
            var result = reply["payload"]["result"];
            Assert.IsFalse(result["ok"].AsBool, "a refused ask must not read as ok:true to an old IDE");
            Assert.AreEqual("runner-unavailable", result["reason"].AsString);
        }

        [Test]
        public void RunFinishedWithNoRunIdRecordedEmitsANullRunId()
        {
            // An IDE built before runId existed omits it from the runTests
            // params, so nothing ever calls SetActiveRun for this run. The push
            // must say so honestly (`runId: null`), not fall back to a stale id
            // left over from a previous run.
            var sent = new List<JsonValue>();
            var callbacks = new TestRunnerHandlers.BridgeTestCallbacks((Action<JsonValue>)(env => sent.Add(env)));
            callbacks.RunStarted(new FakeTestAdaptor { IsSuite = false, FullName = "Suite" });

            var final = new FakeTestResult
            {
                Test = new FakeTestAdaptor { IsSuite = true, FullName = "Suite" },
                PassCount = 1,
                FailCount = 0,
                SkipCount = 0,
                InconclusiveCount = 0,
                Duration = 0.1,
            };
            callbacks.RunFinished(final);

            var completed = sent.First(e => e["type"].AsString == MsgType.TestRunCompleted);
            Assert.IsTrue(completed["payload"]["runId"].IsNull);
        }
    }

    // ── Minimal fakes ────────────────────────────────────────────────────────
    //
    // Only the members BridgeTestCallbacks actually reads are given real
    // behaviour; everything else throws so an accidental new dependency on
    // these fakes fails loudly (a wrong default, e.g. IsSuite silently false)
    // instead of quietly asserting nothing.
    //
    // Editor-dependent: these tests compile against the real
    // UnityEditor.TestTools.TestRunner.Api interfaces, but NUnit's Editor test
    // runner is what actually executes them — there is no headless Unity
    // process in this repo's CI, so this file is proven by the C# compile
    // check, not by a green run, here.

    internal sealed class FakeTestAdaptor : ITestAdaptor
    {
        public string FullName { get; set; } = "";
        public bool IsSuite { get; set; }
        public IEnumerable<ITestAdaptor> Children { get; set; } = Array.Empty<ITestAdaptor>();

        public string Id { get { throw new NotImplementedException(); } }
        public string Name { get { throw new NotImplementedException(); } }
        public int TestCaseCount { get { throw new NotImplementedException(); } }
        public bool HasChildren { get { throw new NotImplementedException(); } }
        public ITestAdaptor Parent { get { throw new NotImplementedException(); } }
        public int TestCaseTimeout { get { throw new NotImplementedException(); } }
        public NUnit.Framework.Interfaces.ITypeInfo TypeInfo { get { throw new NotImplementedException(); } }
        public NUnit.Framework.Interfaces.IMethodInfo Method { get { throw new NotImplementedException(); } }
        public object[] Arguments { get { throw new NotImplementedException(); } }
        public string[] Categories { get { throw new NotImplementedException(); } }
        public bool IsTestAssembly { get { throw new NotImplementedException(); } }
        public RunState RunState { get { throw new NotImplementedException(); } }
        public string Description { get { throw new NotImplementedException(); } }
        public string SkipReason { get { throw new NotImplementedException(); } }
        public string ParentId { get { throw new NotImplementedException(); } }
        public string ParentFullName { get { throw new NotImplementedException(); } }
        public string UniqueName { get { throw new NotImplementedException(); } }
        public string ParentUniqueName { get { throw new NotImplementedException(); } }
        public int ChildIndex { get { throw new NotImplementedException(); } }
        public TestMode TestMode { get { throw new NotImplementedException(); } }
    }

    internal sealed class FakeTestResult : ITestResultAdaptor
    {
        public ITestAdaptor Test { get; set; }
        public TestStatus TestStatus { get; set; }
        public double Duration { get; set; }
        public string Message { get; set; } = "";
        public string StackTrace { get; set; } = "";
        public int PassCount { get; set; }
        public int FailCount { get; set; }
        public int SkipCount { get; set; }
        public int InconclusiveCount { get; set; }

        public string Name { get { throw new NotImplementedException(); } }
        public string FullName { get { throw new NotImplementedException(); } }
        public string ResultState { get { throw new NotImplementedException(); } }
        public DateTime StartTime { get { throw new NotImplementedException(); } }
        public DateTime EndTime { get { throw new NotImplementedException(); } }
        public int AssertCount { get { throw new NotImplementedException(); } }
        public bool HasChildren { get { throw new NotImplementedException(); } }
        public IEnumerable<ITestResultAdaptor> Children { get { throw new NotImplementedException(); } }
        public string Output { get { throw new NotImplementedException(); } }

        public NUnit.Framework.Interfaces.TNode ToXml() { throw new NotImplementedException(); }
    }
}
#endif
