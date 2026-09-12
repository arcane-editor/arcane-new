#if UNITYIDE_HAS_TEST_FRAMEWORK
using System;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityIDE.Bridge;

namespace UnityIDE.Tests
{
    public class AutomationTests
    {
        private string _folder;
        private SceneSetup[] _setup;
        private string _prefix;
        [SetUp]
        public void Setup()
        {
            if (Enumerable.Range(0, SceneManager.sceneCount).Any(i => SceneManager.GetSceneAt(i).isDirty))
                Assert.Ignore("Automation integration tests require clean editor scenes; no user scene was discarded.");
            _prefix = "test_" + Guid.NewGuid().ToString("N");
            _folder = "Assets/UnityIDEAutomationTests_" + _prefix;
            _setup = EditorSceneManager.GetSceneManagerSetup();
            Directory.CreateDirectory(_folder); AssetDatabase.Refresh();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        }
        [TearDown]
        public void TearDown()
        {
            if (_folder == null) return;
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            AssetDatabase.DeleteAsset(_folder);
            if (_setup.Length > 0 && _setup.All(s => !string.IsNullOrEmpty(s.path))) EditorSceneManager.RestoreSceneManagerSetup(_setup);
            Undo.ClearAll();
            if (Directory.Exists(AutomationStore.DirectoryPath))
                foreach (var file in Directory.GetFiles(AutomationStore.DirectoryPath, "*-" + _prefix + "*")) File.Delete(file);
        }
        private JsonValue Operation(string suffix)
        {
            var op = JsonValue.NewObject(); op["operationId"] = _prefix + suffix; op["taskId"] = _prefix;
            op["scenePath"] = _folder + "/Level.unity"; op["ownedRoot"] = "AuthoredLevel";
            op["outputs"] = JsonValue.NewArray(); op["outputs"].Add(op["scenePath"]);
            op["actions"] = JsonValue.NewArray();
            var action = JsonValue.NewObject(); action["kind"] = "object"; action["target"] = "Track"; action["primitive"] = "Cube";
            op["actions"].Add(action); return op;
        }
        [Test]
        public void RepeatedAuthoringUpdatesOwnedContentAndSceneReopens()
        {
            var first = Operation("a"); var a = AuthoringHandlers.Author(first);
            Assert.AreEqual("passed", a["status"].AsString, a.Serialize());
            Assert.AreEqual("passed", AuthoringHandlers.Author(first)["status"].AsString);
            var second = Operation("b");
            var position = JsonValue.NewObject(); position["x"] = 4; position["y"] = 0; position["z"] = 0;
            second["actions"][0]["position"] = position;
            var b = AuthoringHandlers.Author(second); Assert.AreEqual("passed", b["status"].AsString, b.Serialize());
            var scene = SceneManager.GetSceneByPath(first["scenePath"].AsString);
            Assert.AreEqual(1, scene.GetRootGameObjects().Length);
            Assert.AreEqual(1, scene.GetRootGameObjects()[0].transform.childCount);
            Assert.AreEqual(4, scene.GetRootGameObjects()[0].transform.GetChild(0).localPosition.x);
            Assert.AreEqual("passed", AuthoringHandlers.Verify(first["scenePath"].AsString)["status"].AsString);
        }
        [Test]
        public void ChangedPayloadCannotReuseAnOperationIdentity()
        {
            var op = Operation("reuse"); Assert.AreEqual("passed", AuthoringHandlers.Author(op)["status"].AsString);
            op["ownedRoot"] = "Different";
            var result = AuthoringHandlers.Author(op);
            Assert.AreEqual("failed", result["status"].AsString); StringAssert.Contains("different", result["reason"].AsString);
            Assert.IsNull(GameObject.Find("Different"));
        }
        [Test]
        public void DirtySceneBlocksAuthoringWithoutSavingUserChanges()
        {
            var scene = SceneManager.GetActiveScene(); new GameObject("UnsavedUserObject"); EditorSceneManager.MarkSceneDirty(scene);
            var op = Operation("dirty"); var result = AuthoringHandlers.Author(op);
            Assert.AreEqual("failed", result["status"].AsString);
            Assert.IsTrue(scene.isDirty); Assert.IsNotNull(GameObject.Find("UnsavedUserObject"));
            Assert.IsFalse(File.Exists(op["scenePath"].AsString));
        }
        [Test]
        public void OrphanedPlaytestAcknowledgementBecomesInterrupted()
        {
            string id = _prefix + "orphan";
            var run = AutomationStore.Report(id, "running"); run["cleanupComplete"] = false;
            AutomationStore.Save("play", id, run);
            var request = JsonValue.NewObject(); request["operationId"] = id;
            var report = PlaytestHandlers.Status(request);
            Assert.AreEqual("interrupted", report["status"].AsString);
            Assert.IsTrue(report["cleanupComplete"].AsBool);
            Assert.IsFalse(EditorApplication.isPlayingOrWillChangePlaymode);
        }
        [Test]
        public void UnownedRootRefusalKeepsTheExistingCleanSceneOpen()
        {
            var op = Operation("unowned");
            var scene = SceneManager.GetActiveScene(); new GameObject("AuthoredLevel");
            EditorSceneManager.SaveScene(scene, op["scenePath"].AsString);
            var result = AuthoringHandlers.Author(op);
            Assert.AreEqual("failed", result["status"].AsString);
            Assert.IsTrue(scene.isLoaded); Assert.IsFalse(scene.isDirty);
            Assert.IsNotNull(GameObject.Find("AuthoredLevel"));
            Assert.AreEqual(scene, SceneManager.GetActiveScene());
        }
        [Test]
        public void FailedBatchRollsBackEarlierActionsAndDoesNotSaveOutputs()
        {
            var op = Operation("rollback"); var invalid = JsonValue.NewObject(); invalid["kind"] = "component";
            invalid["target"] = "Track"; invalid["component"] = "NoSuchComponent_" + _prefix; op["actions"].Add(invalid);
            var result = AuthoringHandlers.Author(op);
            Assert.AreEqual("failed", result["status"].AsString); Assert.IsFalse(File.Exists(op["scenePath"].AsString));
            Assert.IsNull(GameObject.Find("AuthoredLevel"));
        }
        [Test]
        public void TransientMeshIsNotPersistenceEvidence()
        {
            var go = new GameObject("TransientMesh"); var mesh = new Mesh(); go.AddComponent<MeshFilter>().sharedMesh = mesh;
            try { Assert.Throws<InvalidOperationException>(() => AuthoringHandlers.AssertPersistentDependencies(go.scene)); }
            finally { UnityEngine.Object.DestroyImmediate(mesh); }
        }
        [Test]
        public void MissingObjectsAndFalseUiStateDoNotPassAssertions()
        {
            var step = JsonValue.NewObject(); step["target"] = "MissingPlayer"; step["property"] = "activeSelf"; step["expected"] = true;
            Assert.IsFalse(PlaytestHandlers.Observe(step, 0)["passed"].AsBool);
            new GameObject("HUD").AddComponent<UnityEngine.UIElements.UIDocument>();
            step["target"] = "HUD"; step["property"] = "ui:missing-button.visible";
            Assert.IsFalse(PlaytestHandlers.Observe(step, 1)["passed"].AsBool);
        }
        [Test]
        public void DeclaredPrefabSurvivesReloadWithReferences()
        {
            var op = Operation("prefab"); string path = _folder + "/Track.prefab"; op["outputs"].Add(path);
            var save = JsonValue.NewObject(); save["kind"] = "savePrefab"; save["target"] = "Track"; save["assetPath"] = path; op["actions"].Add(save);
            var result = AuthoringHandlers.Author(op); Assert.AreEqual("passed", result["status"].AsString, result.Serialize());
            var prefab = PrefabUtility.LoadPrefabContents(path);
            try { Assert.IsNotNull(prefab.GetComponent<MeshFilter>().sharedMesh); Assert.IsNotNull(prefab.GetComponent<Collider>()); }
            finally { PrefabUtility.UnloadPrefabContents(prefab); }
        }
        [Test]
        public void RuntimeOnlyConstructionDoesNotSatisfyASavedLevel()
        {
            new GameObject("RuntimeBuilderOnly");
            Assert.Throws<InvalidOperationException>(() => AuthoringHandlers.AssertRepresentativeLevel(SceneManager.GetActiveScene()));
            GameObject.CreatePrimitive(PrimitiveType.Cube);
            Assert.DoesNotThrow(() => AuthoringHandlers.AssertRepresentativeLevel(SceneManager.GetActiveScene()));
        }
        [Test]
        public void AssetPathsRejectTraversalAndExternalPaths()
        {
            Assert.Throws<ArgumentException>(() => AutomationStore.AssetPath("Assets/../ProjectSettings/Test.asset"));
            Assert.Throws<ArgumentException>(() => AutomationStore.AssetPath("/tmp/Foreign.asset"));
        }
    }
}
#endif
