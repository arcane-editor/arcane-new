// TestRunnerHandlers.cs — run Unity tests via TestRunnerApi and stream results
// to the IDE as `test_event` pushes (F-8), plus a queued `runTests` and an
// awaitable `test_run_completed` (B3).
//
// The Unity Test Framework (com.unity.test-framework) is a default package, but
// to keep the bridge compiling even if a project removed it, all TestRunnerApi
// usage is behind `#if UNITYIDE_HAS_TEST_FRAMEWORK` (set by the asmdef
// versionDefine). The `#else` stub keeps Register/Tick present so
// BridgeBootstrap can call them unconditionally; runTests then returns a clear
// "not installed" result.
//
// test_event payload phases (mirrored by the Rust headless path so the frontend
// has ONE code path): runStarted / testStarted / testFinished / runFinished.
// Every phase now carries the run's `runId` (null for an IDE that predates it).
//
// QUEUED, like refreshAssets/requestCompile: `runTests` used to be a BLOCKING
// RPC that acked `{ok:true}` immediately and left the caller to infer
// completion from the `test_event` stream. Blocking a queued reply on a main
// thread Unity may have parked (its window unfocused, the normal state while
// the user is looking at this IDE) means the caller either times out or is
// left correlating a stream with no explicit "done" — so `runTests` is queued
// exactly like those two, and its REAL completion is reported by its own
// message: `test_run_completed`, carrying the summary and a capped failure
// list so a caller can await one RPC instead of assembling the answer itself
// out of a `test_event` stream.
//
// SURVIVING A DOMAIN RELOAD: a PlayMode run's domain reload tears down and
// re-creates every static field in this file, INCLUDING the BridgeTestCallbacks
// instance (see EnsureCallbacks' remarks) — so the run's identity cannot live
// on that instance. It is persisted to SessionState instead (`ActiveRunKey`),
// which is Unity's own mechanism for surviving exactly this reload, and read
// back fresh on every callback rather than cached at construction time.
#if UNITYIDE_HAS_TEST_FRAMEWORK
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.TestTools.TestRunner.Api;
using UnityEngine;

namespace UnityIDE.Bridge
{
    internal static class TestRunnerHandlers
    {
        private const int MaxMsgLen = 4096;

        /// <summary>
        /// How long to hold a backgrounded editor awake once a test run starts.
        /// A test run is not one tick — Unity has to drive the whole suite (and,
        /// for PlayMode, a domain reload) on the main thread, which an unfocused
        /// editor supplies none of on its own. TestStarted/TestFinished refresh
        /// this on every test, exactly as CompilationHook does per assembly.
        /// </summary>
        private const int TestWakeMs = 120000;

        /// <summary>
        /// SessionState key holding the active run's identity as serialized JSON
        /// `{runId, mode, startedAt}`. See the file header for why this has to be
        /// SessionState rather than an instance field.
        /// </summary>
        internal const string ActiveRunKey = "UnityIDE.Bridge.ActiveTestRun";

        private static BridgeClient _client;
        private static TestRunnerApi _api;
        private static BridgeTestCallbacks _callbacks;

        public static void Register(BridgeClient client)
        {
            _client = client;
            // Queued: see the file header. "testRun" is its own coalescing key
            // (distinct from "assetRefresh") — a test run is not an asset
            // import, and coalescing the two would let a refresh silently eat a
            // queued test run or vice versa.
            RpcDispatcher.RegisterQueued("runTests", RunTests, "testRun");
            EnsureCallbacks();
        }

        /// <summary>
        /// Register the TestRunnerApi callbacks, creating them if needed.
        /// </summary>
        /// <remarks>
        /// This MUST happen at load time, not lazily inside RunTests.
        ///
        /// Entering Play Mode performs a domain reload with default project
        /// settings. That fires beforeAssemblyReload, which calls Shutdown(),
        /// which unregisters the callbacks and nulls them. Creating them only
        /// inside RunTests meant that after the reload nothing re-registered
        /// them — so a PlayMode run's testStarted / testFinished / runFinished
        /// never reached the IDE. The tests really ran in Unity while UnityIDE's
        /// Tests panel sat at "Running 0/12" forever, with no way to clear it,
        /// because run.active is only ever set false by the runFinished branch.
        ///
        /// Register() runs again after every domain reload, so doing it here
        /// is what makes the post-reload half of a PlayMode run observable.
        /// </remarks>
        private static void EnsureCallbacks()
        {
            if (_api != null && _callbacks != null) return;
            try
            {
                _api = UnityEngine.ScriptableObject.CreateInstance<TestRunnerApi>();
                _callbacks = new BridgeTestCallbacks(_client);
                _api.RegisterCallbacks(_callbacks);
            }
            catch
            {
                // A failure here must not take the whole bridge down with it;
                // the Tests panel degrades to "not available" instead.
                _api = null;
                _callbacks = null;
            }
        }

        public static void Tick() { /* TestRunnerApi fires callbacks on the main thread; nothing to pump. */ }

        public static void Shutdown()
        {
            try
            {
                if (_api != null && _callbacks != null) _api.UnregisterCallbacks(_callbacks);
            }
            catch { /* ignore */ }
            _api = null;
            _callbacks = null;
            _client = null;
            SendOverrideForTests = null;
        }

        private static JsonValue RunTests(JsonValue p)
        {
            string mode = p["mode"].AsStringOr("EditMode");
            string filter = p["filter"].AsString;
            // Absent for an IDE built before runId existed — GetActiveRun's
            // consumers (Push, RunFinished) all treat "" the same as missing and
            // emit a null runId, which is the honest answer for that caller.
            string runId = p["runId"].AsString;

            // A run is already in flight — refuse this ask WITHOUT touching the
            // active-run key, which still belongs to that other run. Overwriting
            // it here was the bug: SetActiveRun below would stomp the first
            // run's identity with this ask's, so when the FIRST run finished,
            // RunFinished would read THIS ask's runId back out of SessionState
            // and push completion under the wrong id — the first run's waiter
            // would never see a match and would burn its whole timeout.
            if (GetActiveRun() != null)
            {
                PushRunCompleted(runId, mode, false, "runner-unavailable");
                return Failed("runner-unavailable");
            }

            // Normally already registered by Register(); this covers a bridge
            // that reconnected without a domain reload in between.
            EnsureCallbacks();
            if (_api == null)
            {
                PushRunCompleted(runId, mode, false, "test-framework-missing");
                return Failed("test-framework-missing");
            }

            var f = new Filter
            {
                testMode = mode == "PlayMode" ? TestMode.PlayMode : TestMode.EditMode,
            };
            if (!string.IsNullOrEmpty(filter)) f.testNames = new[] { filter };

            SetActiveRun(runId, mode);
            MainThreadDispatcher.RequestWake(TestWakeMs);

            try
            {
                _api.Execute(new ExecutionSettings(f));
            }
            catch (Exception e)
            {
                // Execute() throws for a run already in progress, among other
                // things — either way nothing is going to call RunFinished for
                // THIS ask, so the caller must be told directly rather than left
                // waiting on a completion that is never coming. Only erase the
                // key if it is still the one THIS ask wrote — never clear an
                // identity another ask did not write (defensive: the early
                // bail-out above is the primary guard, but this must hold even
                // if that guard is ever bypassed).
                var active = GetActiveRun();
                string activeRunId = active != null ? active["runId"].AsString : null;
                if (active != null && string.Equals(activeRunId ?? "", runId ?? "", StringComparison.Ordinal))
                {
                    ClearActiveRun();
                }
                Debug.LogError("[UnityIDEBridge] runTests Execute failed: " + e);
                PushRunCompleted(runId, mode, false, "runner-unavailable");
                return Failed("runner-unavailable");
            }

            // Discarded by the queued dispatcher (see RpcDispatcher.DispatchQueued);
            // kept non-null only for the downgraded blocking path an IDE older
            // than protocol 3 still takes.
            return Ok();
        }

        /// <summary>
        /// Push `test_run_completed` directly — used for the cases where no run
        /// ever starts, so RunFinished is never going to fire for it: another
        /// run is already active, the framework/runner is unavailable, or
        /// Execute() itself threw.
        /// </summary>
        private static void PushRunCompleted(string runId, string mode, bool ok, string reason)
        {
            var payload = JsonValue.NewObject();
            payload["runId"] = string.IsNullOrEmpty(runId) ? JsonValue.Null : JsonValue.Of(runId);
            payload["ok"] = ok;
            if (!string.IsNullOrEmpty(reason)) payload["reason"] = reason;
            if (!string.IsNullOrEmpty(mode)) payload["mode"] = mode;
            SendEnvelope(Protocol.Envelope(MsgType.TestRunCompleted, payload));
        }

        /// <summary>
        /// Test-only override for where pushes go — lets `TestRunProtocolTests`
        /// capture what `RunTests`/`PushRunCompleted` send without a live,
        /// started `BridgeClient` (whose `Send` is a silent no-op until
        /// `Start()` has run a real worker thread). Reset to null in
        /// `Shutdown()`; production always goes through `_client`.
        /// </summary>
        internal static Action<JsonValue> SendOverrideForTests;

        private static void SendEnvelope(JsonValue envelope)
        {
            if (SendOverrideForTests != null)
            {
                try { SendOverrideForTests(envelope); }
                catch { /* never throw on the main thread */ }
                return;
            }
            if (_client == null) return;
            try { _client.Send(envelope); }
            catch { /* never throw on the main thread */ }
        }

        private static JsonValue Ok()
        {
            var r = JsonValue.NewObject();
            r["ok"] = true;
            return r;
        }

        /// <summary>
        /// The same shape `PushRunCompleted` sends, for the RPC reply itself —
        /// so a blocking-downgrade caller (an IDE older than protocol 3) sees
        /// the SAME refusal a current IDE gets via the push, not a bare
        /// `{ok:true}` that reads as success. Discarded by the queued
        /// dispatcher for a current IDE (see RunTests' own comment).
        /// </summary>
        private static JsonValue Failed(string reason)
        {
            var r = JsonValue.NewObject();
            r["ok"] = false;
            r["reason"] = reason;
            return r;
        }

        // ── Active-run identity (SessionState-backed; see file header) ───────

        internal static void SetActiveRun(string runId, string mode)
        {
            var v = JsonValue.NewObject();
            v["runId"] = string.IsNullOrEmpty(runId) ? JsonValue.Null : JsonValue.Of(runId);
            v["mode"] = string.IsNullOrEmpty(mode) ? "EditMode" : mode;
            v["startedAt"] = Protocol.NowUnixSeconds();
            SessionState.SetString(ActiveRunKey, v.Serialize());
        }

        /// <summary>The active run's `{runId, mode, startedAt}`, or null if none.</summary>
        internal static JsonValue GetActiveRun()
        {
            string raw = SessionState.GetString(ActiveRunKey, "");
            if (string.IsNullOrEmpty(raw)) return null;
            return JsonValue.TryParse(raw);
        }

        internal static void ClearActiveRun()
        {
            SessionState.EraseString(ActiveRunKey);
        }

        // ── Streaming callbacks ──────────────────────────────────────────────

        /// <summary>
        /// Internal (not private) so `TestRunProtocolTests` can construct one
        /// directly with an injectable sender, and drive it with fake
        /// `ITestAdaptor`/`ITestResultAdaptor` implementations — no live Unity
        /// Editor (and no real `BridgeClient`/journal) required to exercise the
        /// runId-stamping and failure-capping logic.
        /// </summary>
        internal sealed class BridgeTestCallbacks : ICallbacks
        {
            /// <summary>Failures kept verbatim in `test_run_completed`; past this, only counted.</summary>
            private const int MaxFailures = 50;

            private readonly Action<JsonValue> _send;
            private List<JsonValue> _failures = new List<JsonValue>();
            private int _failCount;

            public BridgeTestCallbacks(BridgeClient c)
                : this(c == null ? (Action<JsonValue>)null : (Action<JsonValue>)(env => c.Send(env)))
            {
            }

            /// <summary>Test-only seam: push envelopes to a captured delegate instead of a live BridgeClient.</summary>
            internal BridgeTestCallbacks(Action<JsonValue> send)
            {
                _send = send;
            }

            private void Push(JsonValue payload)
            {
                payload["runId"] = CurrentRunId();
                if (_send == null) return;
                try { _send(Protocol.Envelope(MsgType.TestEvent, payload)); }
                catch { /* never throw on the main thread */ }
            }

            private static JsonValue CurrentRunId()
            {
                var active = GetActiveRun();
                string id = active != null ? active["runId"].AsString : null;
                return string.IsNullOrEmpty(id) ? JsonValue.Null : JsonValue.Of(id);
            }

            private static string Trunc(string s)
            {
                if (string.IsNullOrEmpty(s)) return "";
                return s.Length > MaxMsgLen ? s.Substring(0, MaxMsgLen) : s;
            }

            public void RunStarted(ITestAdaptor testsToRun)
            {
                _failures = new List<JsonValue>();
                _failCount = 0;
                var o = JsonValue.NewObject();
                o["phase"] = "runStarted";
                o["total"] = CountTests(testsToRun);
                Push(o);
            }

            public void TestStarted(ITestAdaptor test)
            {
                if (test.IsSuite) return;
                MainThreadDispatcher.RequestWake(TestWakeMs);
                var o = JsonValue.NewObject();
                o["phase"] = "testStarted";
                o["fullName"] = test.FullName ?? "";
                Push(o);
            }

            public void TestFinished(ITestResultAdaptor result)
            {
                if (result.Test.IsSuite) return;
                MainThreadDispatcher.RequestWake(TestWakeMs);
                var o = JsonValue.NewObject();
                o["phase"] = "testFinished";
                o["fullName"] = result.Test.FullName ?? "";
                o["status"] = result.TestStatus.ToString(); // Passed|Failed|Skipped|Inconclusive
                o["durationMs"] = (long)(result.Duration * 1000.0);
                o["message"] = Trunc(result.Message);
                o["stackTrace"] = Trunc(result.StackTrace);
                Push(o);

                if (result.TestStatus == TestStatus.Failed)
                {
                    _failCount++;
                    if (_failures.Count < MaxFailures)
                    {
                        var f = JsonValue.NewObject();
                        f["fullName"] = result.Test.FullName ?? "";
                        f["status"] = result.TestStatus.ToString();
                        f["message"] = Trunc(result.Message);
                        f["stackTrace"] = Trunc(result.StackTrace);
                        f["durationMs"] = (long)(result.Duration * 1000.0);
                        _failures.Add(f);
                    }
                }
            }

            public void RunFinished(ITestResultAdaptor result)
            {
                var active = GetActiveRun();
                string runId = active != null ? active["runId"].AsString : null;
                string mode = active != null ? active["mode"].AsStringOr("EditMode") : "EditMode";

                var o = JsonValue.NewObject();
                o["phase"] = "runFinished";
                o["passed"] = result.PassCount;
                o["failed"] = result.FailCount;
                o["skipped"] = result.SkipCount;
                o["durationMs"] = (long)(result.Duration * 1000.0);
                Push(o);

                var completed = JsonValue.NewObject();
                completed["runId"] = string.IsNullOrEmpty(runId) ? JsonValue.Null : JsonValue.Of(runId);
                completed["ok"] = true;
                completed["mode"] = mode;
                completed["total"] = result.PassCount + result.FailCount + result.SkipCount + result.InconclusiveCount;
                completed["passed"] = result.PassCount;
                completed["failed"] = result.FailCount;
                completed["skipped"] = result.SkipCount;
                completed["inconclusive"] = result.InconclusiveCount;
                completed["durationMs"] = (long)(result.Duration * 1000.0);
                var arr = JsonValue.NewArray();
                foreach (var f in _failures) arr.Add(f);
                completed["failures"] = arr;
                // More tests failed than we kept verbatim — the caller must not
                // read the list as exhaustive.
                completed["failuresTruncated"] = _failCount > _failures.Count;

                if (_send != null)
                {
                    try { _send(Protocol.Envelope(MsgType.TestRunCompleted, completed)); }
                    catch { /* never throw on the main thread */ }
                }

                ClearActiveRun();
                MainThreadDispatcher.RequestWake(0);
            }

            private static int CountTests(ITestAdaptor t)
            {
                if (t == null) return 0;
                if (!t.IsSuite) return 1;
                int n = 0;
                if (t.Children != null)
                    foreach (var c in t.Children) n += CountTests(c);
                return n;
            }
        }
    }
}
#else
namespace UnityIDE.Bridge
{
    // Test Framework package absent — keep the shape so BridgeBootstrap compiles.
    internal static class TestRunnerHandlers
    {
        public static void Register(BridgeClient client)
        {
            RpcDispatcher.Register("runTests", _ =>
            {
                var r = JsonValue.NewObject();
                r["ok"] = false;
                r["error"] = "Unity Test Framework (com.unity.test-framework) is not installed.";
                return r;
            });
        }

        public static void Tick() { }
        public static void Shutdown() { }
    }
}
#endif
