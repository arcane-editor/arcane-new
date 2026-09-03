using System.IO;
using UnityIDE.Bridge;
using NUnit.Framework;

namespace UnityIDE.Tests
{
    public class DiscoveryTests
    {
        private string _root;

        [SetUp]
        public void SetUp()
        {
            _root = Path.Combine(Path.GetTempPath(), "unityide-disc-" + Path.GetRandomFileName());
            Directory.CreateDirectory(Path.Combine(Path.Combine(_root, "Library"), "UnityIDE"));
        }

        [TearDown]
        public void TearDown()
        {
            try { Directory.Delete(_root, true); } catch { }
        }

        private void WriteBridgeJson(string contents)
        {
            File.WriteAllText(Discovery.BridgeJsonPath(_root), contents);
        }

        [Test]
        public void ResolvesAWellFormedBridgeJson()
        {
            WriteBridgeJson("{\"transport\":\"journal\",\"protocolVersion\":2," +
                            "\"ideSessionId\":\"abc123\",\"ideVersion\":\"0.3.0\",\"idePid\":4242}");

            BridgeDiscovery d;
            Assert.IsTrue(Discovery.TryResolve(_root, out d));
            Assert.AreEqual("abc123", d.IdeSessionId);
            Assert.AreEqual(2, d.ProtocolVersion);
            Assert.AreEqual("0.3.0", d.IdeVersion);
            Assert.AreEqual(4242, d.IdePid);
        }

        [Test]
        public void FailsWhenBridgeJsonIsAbsent()
        {
            BridgeDiscovery d;
            Assert.IsFalse(Discovery.TryResolve(_root, out d),
                "no bridge.json means no IDE — there is no computed fallback any more");
        }

        [Test]
        public void FailsOnMalformedOrSessionlessJson()
        {
            WriteBridgeJson("{ not json");
            BridgeDiscovery d;
            Assert.IsFalse(Discovery.TryResolve(_root, out d));

            WriteBridgeJson("{\"transport\":\"journal\",\"protocolVersion\":2}");
            Assert.IsFalse(Discovery.TryResolve(_root, out d),
                "a bridge.json with no ideSessionId cannot be handshaked against");
        }

        [Test]
        public void JournalPathsLiveUnderLibraryUnityIde()
        {
            string dir = Path.Combine(Path.Combine(_root, "Library"), "UnityIDE");
            Assert.AreEqual(Path.Combine(dir, "to-ide.jsonl"), Discovery.ToIdeJournalPath(_root));
            Assert.AreEqual(Path.Combine(dir, "to-ide.ack"), Discovery.ToIdeAckPath(_root));
            Assert.AreEqual(Path.Combine(dir, "to-unity.jsonl"), Discovery.ToUnityJournalPath(_root));
            Assert.AreEqual(Path.Combine(dir, "to-unity.ack"), Discovery.ToUnityAckPath(_root));
        }

        [Test]
        public void EpochSidecarsSitBesideTheirJournals()
        {
            string dir = Path.Combine(Path.Combine(_root, "Library"), "UnityIDE");
            Assert.AreEqual(Path.Combine(dir, "to-ide.epoch"),
                JournalLimits.EpochPathFor(Discovery.ToIdeJournalPath(_root)));
            Assert.AreEqual(Path.Combine(dir, "to-unity.epoch"),
                JournalLimits.EpochPathFor(Discovery.ToUnityJournalPath(_root)));
        }

        [Test]
        public void ProjectRootIsTheParentOfAssets()
        {
            string dataPath = Path.Combine(_root, "Assets");
            Assert.AreEqual(_root, Discovery.ProjectRoot(dataPath));
        }

        [Test]
        public void ProtocolVersionMatchesTheIdeSide()
        {
            // MUST equal PROTOCOL_VERSION in editor/src-tauri/src/unity_ipc.rs,
            // which pins the same literal from its own side. A mismatch is not
            // cosmetic: the IDE raises a permanent "update bridge" banner, and
            // the package silently drops to the pre-queue blocking path.
            //
            // 3 = queued commands (refreshAssets/requestCompile ack on
            // ACCEPTANCE, real completion arrives as refresh_completed).
            Assert.AreEqual(3, Discovery.ProtocolVersion);
        }
    }
}
