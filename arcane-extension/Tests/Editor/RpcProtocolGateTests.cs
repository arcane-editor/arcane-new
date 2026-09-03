using UnityIDE.Bridge;
using NUnit.Framework;

namespace UnityIDE.Tests
{
    /// <summary>
    /// Queueing a command changes what its rpc_response MEANS, and the Unity
    /// package updates independently of the IDE that talks to it.
    ///
    /// An IDE built before protocol 3 reads any reply to refreshAssets as "the
    /// import finished". Hand it a `{queued:true}` acceptance and it starts its
    /// "nothing needed compiling" timer against work Unity has not begun — so
    /// updating only the Unity package would silently re-create the exact bug
    /// queueing exists to fix, and report a clean compile for a file that was
    /// never looked at. These tests pin the version gate that prevents it.
    /// </summary>
    public class RpcProtocolGateTests
    {
        [SetUp]
        public void SetUp()
        {
            RpcDispatcher.Clear();
            MainThreadDispatcher.Clear();
            // Registering the test thread as "main" makes the blocking path run
            // its handler inline, so no editor pump is needed here.
            MainThreadDispatcher.CaptureMainThread();
        }

        [TearDown]
        public void TearDown()
        {
            RpcDispatcher.Clear();
            MainThreadDispatcher.Clear();
            RpcDispatcher.SetIdeProtocolVersion(0);
        }

        private static JsonValue Request(string id, string method)
        {
            var payload = JsonValue.NewObject();
            payload["method"] = method;
            payload["params"] = JsonValue.NewObject();
            var msg = Protocol.Envelope(MsgType.RpcRequest, payload);
            msg["id"] = id;
            return msg;
        }

        [Test]
        public void ACurrentIdeGetsTheQueuedAckAndTheWorkIsDeferred()
        {
            int ran = 0;
            RpcDispatcher.RegisterQueued("refreshAssets", p => { ran++; return JsonValue.NewObject(); });
            RpcDispatcher.SetIdeProtocolVersion(Discovery.ProtocolVersion);

            JsonValue reply = null;
            RpcDispatcher.Dispatch(Request("1", "refreshAssets"), r => reply = r);

            Assert.IsNotNull(reply);
            Assert.IsTrue(reply["payload"]["result"]["queued"].AsBool,
                "a current IDE must be told the ask was only ACCEPTED");
            Assert.AreEqual(0, ran, "queued work must not have run yet");

            MainThreadDispatcher.Pump();
            Assert.AreEqual(1, ran, "…and must run once the editor ticks");
        }

        [Test]
        public void AnIdeOlderThanTheQueuedAckKeepsTheBlockingBehaviour()
        {
            int ran = 0;
            RpcDispatcher.RegisterQueued("refreshAssets", p => { ran++; return JsonValue.NewObject(); });
            RpcDispatcher.SetIdeProtocolVersion(Discovery.ProtocolVersion - 1);

            JsonValue reply = null;
            RpcDispatcher.Dispatch(Request("1", "refreshAssets"), r => reply = r);

            Assert.AreEqual(1, ran,
                "an older IDE reads the reply as completion, so the work must be DONE first");
            Assert.IsNotNull(reply);
            Assert.IsTrue(reply["payload"]["result"]["queued"] == null ||
                          reply["payload"]["result"]["queued"].IsNull,
                "no queued marker may reach an IDE that would misread it");
        }

        [Test]
        public void AnUnnegotiatedSessionIsTreatedAsOld()
        {
            // 0 = no handshake seen. Guessing "new" here would be guessing in the
            // direction that produces a silent lie.
            int ran = 0;
            RpcDispatcher.RegisterQueued("refreshAssets", p => { ran++; return JsonValue.NewObject(); });

            RpcDispatcher.Dispatch(Request("1", "refreshAssets"), r => { });
            Assert.AreEqual(1, ran, "unknown IDE version must fall back to blocking");
        }

        [Test]
        public void RegisteringNormallyAfterQueuedClearsTheQueuedMarker()
        {
            int ran = 0;
            RpcDispatcher.RegisterQueued("refreshAssets", p => { ran++; return JsonValue.NewObject(); });
            RpcDispatcher.Register("refreshAssets", p => { ran++; return JsonValue.NewObject(); });
            RpcDispatcher.SetIdeProtocolVersion(Discovery.ProtocolVersion);

            RpcDispatcher.Dispatch(Request("1", "refreshAssets"), r => { });
            Assert.AreEqual(1, ran, "a plain Register must win over an earlier RegisterQueued");
        }
    }
}
