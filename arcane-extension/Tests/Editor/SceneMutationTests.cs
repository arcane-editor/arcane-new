#if UNITYIDE_HAS_TEST_FRAMEWORK
using System.IO;
using NUnit.Framework;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;
using UnityIDE.Bridge;

namespace UnityIDE.Tests
{
    /// <summary>
    /// The bridge's first WRITE RPCs — `attachUiDocument` and
    /// `setSerializedProperty` (B4).
    /// </summary>
    /// <remarks>
    /// These are editor-dependent by nature: every assertion here needs a real
    /// scene, a real AssetDatabase and a real Undo stack, so Unity's own Test
    /// Runner is the only thing that can EXECUTE them (the repo's headless
    /// `csharp-compile.sh` only proves they compile).
    ///
    /// Everything they touch is namespaced and torn down: an ADDITIVE scene
    /// (never the user's open scene), assets confined to
    /// `Assets/UnityIDE_TestTmp`, and `Undo.ClearAll()` so a run does not leave
    /// "UnityIDE: …" entries sitting in the user's Edit menu. The one asset
    /// written outside that folder is Unity's default runtime theme, whose path
    /// the handler owns — the fixture deletes it only when the run created it.
    ///
    /// The PanelSettings tests are deliberately split by what the host project
    /// can guarantee: `attachUiDocument` searches the WHOLE project for
    /// PanelSettings assets, so only the "several exist" case is deterministic
    /// everywhere. The creation path is skipped, loudly, in a project that
    /// already has one.
    /// </remarks>
    public class SceneMutationTests
    {
        private const string TmpFolder = "Assets/UnityIDE_TestTmp";
        private const string TmpFolderName = "UnityIDE_TestTmp";
        private const string UxmlPath = TmpFolder + "/UnityIDE_Test.uxml";
        private const string PanelSettingsPath = TmpFolder + "/UnityIDE_TestPanel.asset";
        private const string SecondPanelSettingsPath = TmpFolder + "/UnityIDE_TestPanel2.asset";
        private const string DefaultThemePath = "Assets/UI Toolkit/UnityThemes/UnityDefaultRuntimeTheme.tss";

        private const string UxmlContents =
            "<ui:UXML xmlns:ui=\"UnityEngine.UIElements\">\n" +
            "    <ui:Label text=\"UnityIDE test\" />\n" +
            "</ui:UXML>\n";

        private Scene _scene;
        private Scene _previousActive;
        private bool _themeWasCreated;

        [SetUp]
        public void SetUp()
        {
            RpcDispatcher.Clear();
            MainThreadDispatcher.Clear();
            // Registering the test thread as "main" is what makes a blocking
            // handler run INLINE inside Dispatch — see DispatcherLivenessTests.
            MainThreadDispatcher.CaptureMainThread();
            EditorGate.ResetForTests();
            SceneMutationHandlers.Register(null);

            if (!AssetDatabase.IsValidFolder(TmpFolder))
                AssetDatabase.CreateFolder("Assets", TmpFolderName);
            File.WriteAllText(AbsolutePath(UxmlPath), UxmlContents);
            AssetDatabase.ImportAsset(UxmlPath, ImportAssetOptions.ForceSynchronousImport);

            _previousActive = SceneManager.GetActiveScene();
            _scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
            SceneManager.SetActiveScene(_scene);
            _themeWasCreated = false;
        }

        [TearDown]
        public void TearDown()
        {
            if (_previousActive.IsValid() && _previousActive.isLoaded)
                SceneManager.SetActiveScene(_previousActive);
            if (_scene.IsValid())
                EditorSceneManager.CloseScene(_scene, true);

            RpcDispatcher.Clear();
            MainThreadDispatcher.Clear();
            EditorGate.ResetForTests();
            // A test run must not leave "UnityIDE: …" entries in the user's Edit
            // menu, and PerformUndo below would otherwise reach across tests.
            Undo.ClearAll();

            if (AssetDatabase.IsValidFolder(TmpFolder))
                AssetDatabase.DeleteAsset(TmpFolder);
            if (_themeWasCreated)
                AssetDatabase.DeleteAsset(DefaultThemePath);
        }

        // ── attachUiDocument ─────────────────────────────────────────────────

        [Test]
        public void AttachCreatesTheGameObjectAndUiDocumentAndDirtiesTheScene()
        {
            PanelSettings panel = CreatePanelSettings(PanelSettingsPath);

            JsonValue result = Call("attachUiDocument",
                AttachParams("UnityIDE_TestRoot/HUD", PanelSettingsPath));

            AssertOk(result);
            Assert.IsTrue(result["gameObject"]["created"].AsBool, "the missing GameObject must be created");
            Assert.IsTrue(result["uiDocument"]["created"].AsBool, "the UIDocument must be added");
            Assert.AreEqual("UnityIDE_TestRoot/HUD", result["gameObject"]["path"].AsString);
            Assert.AreEqual("given", result["panelSettings"]["confidence"].AsString,
                "a caller-supplied panelSettingsPath is the 'given' confidence");
            Assert.IsTrue(result["scene"]["dirty"].AsBool, "the scene must be dirtied, never saved");
            Assert.AreEqual("UnityIDE: Attach UIDocument", result["undoGroup"].AsString);

            GameObject go = GameObject.Find("UnityIDE_TestRoot/HUD");
            Assert.IsNotNull(go, "the created GameObject must be findable at its path");
            var doc = go.GetComponent<UIDocument>();
            Assert.IsNotNull(doc, "the UIDocument must exist on the target");
            Assert.AreEqual(AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(UxmlPath), doc.visualTreeAsset,
                "sourceAsset must point at the .uxml — a null one renders nothing and logs nothing");
            Assert.AreEqual(panel, doc.panelSettings,
                "panelSettings must be wired — a null one renders nothing and logs nothing");
            Assert.IsNotNull(doc.panelSettings.themeStyleSheet,
                "a themeless PanelSettings renders nothing and logs nothing");
            Assert.IsTrue(_scene.isDirty, "the scene itself must be marked dirty");
        }

        [Test]
        public void AttachHonoursSortingOrderAndReusesAnExistingUiDocument()
        {
            CreatePanelSettings(PanelSettingsPath);
            var existing = new GameObject("UnityIDE_TestHud");
            existing.AddComponent<UIDocument>();

            JsonValue p = AttachParams("UnityIDE_TestHud", PanelSettingsPath);
            p["sortingOrder"] = 3.5d;
            JsonValue result = Call("attachUiDocument", p);

            AssertOk(result);
            Assert.IsFalse(result["gameObject"]["created"].AsBool, "an existing GameObject is not re-created");
            Assert.IsFalse(result["uiDocument"]["created"].AsBool, "an existing UIDocument is reused, not duplicated");
            Assert.AreEqual(3.5f, existing.GetComponent<UIDocument>().sortingOrder, 0.0001f);
        }

        [Test]
        public void UndoRemovesTheCreatedGameObject()
        {
            CreatePanelSettings(PanelSettingsPath);
            AssertOk(Call("attachUiDocument", AttachParams("UnityIDE_TestRoot/HUD", PanelSettingsPath)));
            Assert.IsNotNull(GameObject.Find("UnityIDE_TestRoot/HUD"));

            Undo.PerformUndo();

            Assert.IsNull(GameObject.Find("UnityIDE_TestRoot/HUD"),
                "one undo must remove the whole attach, leaf first");
            Assert.IsNull(GameObject.Find("UnityIDE_TestRoot"),
                "the parent this RPC created is part of the same collapsed group");
        }

        [Test]
        public void UndoRemovesTheAddedUiDocument()
        {
            CreatePanelSettings(PanelSettingsPath);
            var existing = new GameObject("UnityIDE_TestHud");
            Undo.RegisterCreatedObjectUndo(existing, "fixture");

            AssertOk(Call("attachUiDocument", AttachParams("UnityIDE_TestHud", PanelSettingsPath)));
            Assert.IsNotNull(existing.GetComponent<UIDocument>());

            Undo.PerformUndo();

            // `!= null` on purpose: NUnit's IsNotNull compares references and would
            // pass for a DESTROYED GameObject; UnityEngine.Object's own operator would not.
            Assert.IsTrue(existing != null, "the GameObject predates the RPC, so undo must leave it alone");
            Assert.IsNull(existing.GetComponent<UIDocument>(),
                "the component the RPC added must come off in one undo");
        }

        [Test]
        public void AttachCreatesPanelSettingsAndThemeWhenTheProjectHasNone()
        {
            if (AssetDatabase.FindAssets("t:PanelSettings").Length > 0)
            {
                Assert.Ignore("This project already has a PanelSettings asset, so the creation path " +
                              "cannot be reached — AttachRefusesWhenSeveralPanelSettingsExist covers that state.");
            }

            JsonValue p = AttachParams("UnityIDE_TestRoot/HUD", null);
            p["panelSettingsCreatePath"] = PanelSettingsPath;
            JsonValue result = Call("attachUiDocument", p);

            AssertOk(result);
            Assert.AreEqual("created", result["panelSettings"]["confidence"].AsString);
            Assert.IsTrue(result["panelSettings"]["created"].AsBool);
            Assert.AreEqual(PanelSettingsPath, result["panelSettings"]["path"].AsString);

            var created = AssetDatabase.LoadAssetAtPath<PanelSettings>(PanelSettingsPath);
            Assert.IsNotNull(created, "the PanelSettings asset must exist on disk");
            Assert.IsNotNull(created.themeStyleSheet, "a created PanelSettings must come with a theme");

            _themeWasCreated = result["panelSettings"]["themeCreated"].AsBool;
            if (_themeWasCreated)
            {
                Assert.IsNotNull(AssetDatabase.LoadAssetAtPath<ThemeStyleSheet>(DefaultThemePath),
                    "themeCreated:true must mean the default runtime theme really imported");
            }
        }

        [Test]
        public void AttachRefusesWhenSeveralPanelSettingsExistAndNoneIsNamed()
        {
            CreatePanelSettings(PanelSettingsPath);
            CreatePanelSettings(SecondPanelSettingsPath);

            JsonValue result = Call("attachUiDocument", AttachParams("UnityIDE_TestRoot/HUD", null));

            AssertRefused(result);
            string reason = result["reason"].AsString;
            StringAssert.Contains("panelSettingsPath", reason,
                "the refusal must say how to disambiguate");
            StringAssert.Contains(PanelSettingsPath, reason, "the refusal must list the candidates");
            StringAssert.Contains(SecondPanelSettingsPath, reason, "the refusal must list the candidates");
            Assert.IsNull(GameObject.Find("UnityIDE_TestRoot/HUD"),
                "a refusal must not leave a half-attached GameObject behind");
        }

        [Test]
        public void AttachRefusesAUxmlThatDoesNotImport()
        {
            CreatePanelSettings(PanelSettingsPath);
            JsonValue p = AttachParams("UnityIDE_TestRoot/HUD", PanelSettingsPath);
            p["uxmlPath"] = TmpFolder + "/NotThere.uxml";

            JsonValue result = Call("attachUiDocument", p);

            AssertRefused(result);
            StringAssert.Contains("NotThere.uxml", result["reason"].AsString);
            StringAssert.Contains("VisualTreeAsset", result["reason"].AsString);
        }

        [Test]
        public void AttachRefusesWhenTheEditorGateSaysBusy()
        {
            EditorGate.IsBusy = () => "Unity is compiling. Try again once the compile finishes.";

            JsonValue result = Call("attachUiDocument", AttachParams("UnityIDE_TestRoot/HUD", PanelSettingsPath));

            AssertRefused(result);
            Assert.AreEqual("Unity is compiling. Try again once the compile finishes.",
                result["reason"].AsString);
            Assert.IsNull(GameObject.Find("UnityIDE_TestRoot/HUD"), "a busy editor must be untouched");
        }

        // ── setSerializedProperty ────────────────────────────────────────────

        [Test]
        public void SetSerializedPropertySetsAFloatAndIsUndoable()
        {
            var go = new GameObject("UnityIDE_TestLight");
            Undo.RegisterCreatedObjectUndo(go, "fixture");
            var light = go.AddComponent<Light>();
            light.intensity = 1f;

            // "intensity" is the C# name the agent knows; "m_Intensity" is what
            // Unity serializes — the flexible lookup is what bridges the two.
            JsonValue result = Call("setSerializedProperty",
                SetParams("UnityIDE_TestLight", "Light", "intensity", "float", JsonValue.Of(7d)));

            AssertOk(result);
            Assert.AreEqual("Float", result["propertyType"].AsString);
            Assert.AreEqual(1d, result["previous"].AsNumber, 0.0001d);
            Assert.AreEqual(7d, result["applied"].AsNumber, 0.0001d);
            Assert.IsTrue(result["sceneDirty"].AsBool);
            Assert.AreEqual("UnityIDE: Set intensity", result["undoGroup"].AsString);
            Assert.AreEqual(7f, light.intensity, 0.0001f);

            Undo.PerformUndo();

            Assert.AreEqual(1f, light.intensity, 0.0001f, "one undo must restore the previous value");
        }

        [Test]
        public void SetSerializedPropertyRefusesAnUnknownPropertyAndListsTheRealOnes()
        {
            var go = new GameObject("UnityIDE_TestLight");
            go.AddComponent<Light>();

            JsonValue result = Call("setSerializedProperty",
                SetParams("UnityIDE_TestLight", "Light", "brightnes", "float", JsonValue.Of(7d)));

            AssertRefused(result);
            string reason = result["reason"].AsString;
            StringAssert.Contains("brightnes", reason, "the refusal must name what was asked for");
            StringAssert.Contains("m_Intensity", reason, "the refusal must list the real property names");
            Assert.IsFalse(reason.Contains("m_Script"), "m_Script is never what the caller meant");
        }

        [Test]
        public void SetSerializedPropertyRefusesAMissingComponentAndListsWhatIsThere()
        {
            var go = new GameObject("UnityIDE_TestLight");
            go.AddComponent<Light>();

            JsonValue result = Call("setSerializedProperty",
                SetParams("UnityIDE_TestLight", "Rigidbody", "mass", "float", JsonValue.Of(2d)));

            AssertRefused(result);
            StringAssert.Contains("Rigidbody", result["reason"].AsString);
            StringAssert.Contains("Light", result["reason"].AsString);
        }

        [Test]
        public void SetSerializedPropertyRefusesWhenTheEditorGateSaysBusy()
        {
            var go = new GameObject("UnityIDE_TestLight");
            var light = go.AddComponent<Light>();
            light.intensity = 1f;
            EditorGate.IsBusy = () => "Unity is in Play Mode. Exit Play Mode and try again.";

            JsonValue result = Call("setSerializedProperty",
                SetParams("UnityIDE_TestLight", "Light", "intensity", "float", JsonValue.Of(7d)));

            AssertRefused(result);
            Assert.AreEqual("Unity is in Play Mode. Exit Play Mode and try again.", result["reason"].AsString);
            Assert.AreEqual(1f, light.intensity, 0.0001f, "a busy editor must be untouched");
        }

        [Test]
        public void SetSerializedPropertyWritesAnAssetAndSavesIt()
        {
            PanelSettings panel = CreatePanelSettings(PanelSettingsPath);
            panel.sortingOrder = 0f;

            JsonValue p = JsonValue.NewObject();
            p["assetPath"] = PanelSettingsPath;
            p["property"] = "sortingOrder";
            var value = JsonValue.NewObject();
            value["kind"] = "float";
            value["value"] = JsonValue.Of(4d);
            p["value"] = value;

            JsonValue result = Call("setSerializedProperty", p);

            AssertOk(result);
            Assert.IsTrue(result["target"]["isAsset"].AsBool);
            Assert.AreEqual(PanelSettingsPath, result["target"]["path"].AsString);
            Assert.IsFalse(result["sceneDirty"].AsBool, "an asset write dirties no scene");
            Assert.AreEqual(4f, AssetDatabase.LoadAssetAtPath<PanelSettings>(PanelSettingsPath).sortingOrder,
                0.0001f);
        }

        [Test]
        public void SetSerializedPropertyAcceptsANumberSentAsText()
        {
            var go = new GameObject("UnityIDE_TestLight");
            var light = go.AddComponent<Light>();
            light.intensity = 1f;

            // The agent tool sends every value as text; refusing "7" would be
            // pedantry that costs the model a whole turn.
            JsonValue result = Call("setSerializedProperty",
                SetParams("UnityIDE_TestLight", "Light", "intensity", "float", JsonValue.Of("7")));

            AssertOk(result);
            Assert.AreEqual(7f, light.intensity, 0.0001f);
        }

        [Test]
        public void SetSerializedPropertyRefusesATypeItCannotCoerce()
        {
            var go = new GameObject("UnityIDE_TestLight");
            go.AddComponent<Light>();

            JsonValue result = Call("setSerializedProperty",
                SetParams("UnityIDE_TestLight", "Light", "intensity", "objectRef", JsonValue.Null));

            AssertRefused(result);
            StringAssert.Contains("Float", result["reason"].AsString,
                "the refusal must name the type the property actually is");
        }

        // ── Fixture helpers ──────────────────────────────────────────────────

        private static string AbsolutePath(string assetPath)
        {
            return Path.Combine(
                Discovery.ProjectRoot(Application.dataPath),
                assetPath.Replace('/', Path.DirectorySeparatorChar));
        }

        private static PanelSettings CreatePanelSettings(string path)
        {
            var panel = ScriptableObject.CreateInstance<PanelSettings>();
            AssetDatabase.CreateAsset(panel, path);
            return AssetDatabase.LoadAssetAtPath<PanelSettings>(path);
        }

        private static JsonValue AttachParams(string targetPath, string panelSettingsPath)
        {
            var target = JsonValue.NewObject();
            target["path"] = targetPath;

            var p = JsonValue.NewObject();
            p["target"] = target;
            p["uxmlPath"] = UxmlPath;
            if (panelSettingsPath != null) p["panelSettingsPath"] = panelSettingsPath;
            return p;
        }

        private static JsonValue SetParams(string targetPath, string component, string property,
            string kind, JsonValue raw)
        {
            var target = JsonValue.NewObject();
            target["path"] = targetPath;

            var value = JsonValue.NewObject();
            value["kind"] = kind;
            value["value"] = raw;

            var p = JsonValue.NewObject();
            p["target"] = target;
            p["component"] = component;
            p["property"] = property;
            p["value"] = value;
            return p;
        }

        /// <summary>
        /// Dispatch one RPC through the real RpcDispatcher and hand back its
        /// result. Blocking registration is part of what this asserts: a queued
        /// handler would answer `{queued:true}` and never touch the scene.
        /// </summary>
        private static JsonValue Call(string method, JsonValue @params)
        {
            var payload = JsonValue.NewObject();
            payload["method"] = method;
            payload["params"] = @params;
            JsonValue msg = Protocol.Envelope(MsgType.RpcRequest, payload);
            msg["id"] = "scene-mutation-test";

            JsonValue reply = null;
            RpcDispatcher.Dispatch(msg, r => reply = r);

            Assert.IsNotNull(reply, method + " produced no reply");
            Assert.IsTrue(reply["payload"]["error"].IsNull,
                method + " errored: " + reply["payload"]["error"]["message"].AsStringOr(""));
            JsonValue result = reply["payload"]["result"];
            Assert.IsFalse(result["queued"].AsBool, method + " must be blocking, not queued");
            return result;
        }

        private static void AssertOk(JsonValue result)
        {
            Assert.IsTrue(result["ok"].AsBool,
                "expected ok:true, got refusal: " + result["reason"].AsStringOr("(none)"));
        }

        private static void AssertRefused(JsonValue result)
        {
            Assert.IsFalse(result["ok"].AsBool, "expected a refusal, got ok:true");
            Assert.IsNotNull(result["reason"].AsString, "a refusal must carry a reason the user can act on");
        }
    }
}
#endif
