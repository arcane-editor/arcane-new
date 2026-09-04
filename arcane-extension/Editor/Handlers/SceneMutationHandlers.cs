// SceneMutationHandlers.cs — the bridge's FIRST write RPCs. Until this file the
// agent could read the hierarchy in full detail and change nothing in it: to
// attach a component or set a serialized field it had to ask the user to do it
// by hand, which is where every "wire this up in the Inspector" hand-off came
// from.
//
// Methods (both blocking — the caller wants the answer, not an ack):
//   attachUiDocument      → add a UIDocument + PanelSettings + theme to a GameObject
//   setSerializedProperty → set one serialized field on a component/GameObject/asset
//
// THREE RULES HOLD FOR EVERY WRITE HERE, and later write RPCs must keep them:
//
//   1. ONE UNDO GROUP PER RPC. Increment, name, work, collapse. Ctrl+Z in Unity
//      then reverses the whole action, not the seven steps it happened to take.
//      An RPC that leaves half its work outside the group is worse than one
//      that refuses.
//   2. THE SCENE IS DIRTIED, NEVER SAVED. Saving is the user's call — a bridge
//      that saves for them destroys the "close without saving" escape hatch.
//      Asset writes are the exception: an asset edit that is not written to
//      disk is lost on the next domain reload, so those do save.
//   3. A PREFAB INSTANCE RECORDS ITS OVERRIDE. Without
//      RecordPrefabInstancePropertyModifications the change looks applied in the
//      Inspector and silently reverts the next time Unity reloads the scene.
//
// Refusals are `{ ok:false, reason }` (HierarchyHandlers.Refused) — the same
// shape openScene uses. A refusal is not an error: it is the honest answer, and
// it names what to do next, because the agent reads it and retries (Global
// Constraint 2).

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;

namespace UnityIDE.Bridge
{
    /// <summary>
    /// The shared "is the Editor in a state where a scene write is safe?" guard.
    /// </summary>
    /// <remarks>
    /// Three states make a scene write a bad idea, and all three fail QUIETLY
    /// without this check — which is the worst possible outcome for an agent
    /// that will report success and move on:
    ///
    ///   * Play Mode — everything written is thrown away on exit.
    ///   * Compiling — the domain is about to reload underneath the handler.
    ///   * Prefab Mode — `SceneManager` sees the prefab stage's throwaway scene,
    ///     so a hierarchy path resolves against the wrong thing (or not at all)
    ///     and MarkSceneDirty dirties a scene the user never opened.
    ///
    /// <see cref="IsBusy"/> is a field, not a method, so tests can inject a
    /// state no headless test process could otherwise reach.
    /// </remarks>
    internal static class EditorGate
    {
        /// <summary>
        /// Returns a user-facing reason the Editor is busy, or null when a write
        /// is safe. Replaceable for tests; call <see cref="ResetForTests"/> to
        /// restore the real check.
        /// </summary>
        internal static Func<string> IsBusy = DefaultIsBusy;

        /// <summary>The busy reason, or null. Null-safe against a cleared IsBusy.</summary>
        internal static string BusyReason()
        {
            Func<string> probe = IsBusy;
            return probe == null ? null : probe();
        }

        internal static void ResetForTests()
        {
            IsBusy = DefaultIsBusy;
        }

        private static string DefaultIsBusy()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isPlaying)
                return "Unity is in Play Mode. Exit Play Mode and try again — changes made in Play Mode are discarded.";
            if (EditorApplication.isCompiling)
                return "Unity is compiling. Try again once the compile finishes.";
            if (PrefabStageUtility.GetCurrentPrefabStage() != null)
                return "Unity has a prefab open in Prefab Mode. Go back to the scene (the arrow in the Hierarchy breadcrumb) and try again.";
            return null;
        }
    }

    internal static class SceneMutationHandlers
    {
        private const string AttachUndoGroup = "UnityIDE: Attach UIDocument";
        private const string DefaultPanelSettingsPath = "Assets/UI/PanelSettings.asset";
        private const string DefaultThemePath = "Assets/UI Toolkit/UnityThemes/UnityDefaultRuntimeTheme.tss";

        /// <summary>What a fresh runtime theme contains — Unity's own default, imported by URL.</summary>
        private const string DefaultThemeContents = "@import url(\"unity-theme://default\");\nVisualElement {}\n";

        /// <summary>Cap on the property names a refusal lists, so a fat component can't flood the reply.</summary>
        private const int MaxNamesInRefusal = 60;

        public static void Register(BridgeClient client)
        {
            RpcDispatcher.Register("attachUiDocument", AttachUiDocument);
            RpcDispatcher.Register("setSerializedProperty", SetSerializedProperty);
        }

        // ── attachUiDocument ─────────────────────────────────────────────────

        /// <summary>
        /// Attach a UIDocument to a GameObject, wired to a .uxml, a PanelSettings
        /// and a theme — the whole "why is my UI invisible?" chain in one call.
        /// </summary>
        /// <remarks>
        /// Doing this by hand is four steps, three of which fail silently: a
        /// UIDocument with no PanelSettings draws nothing, a PanelSettings with
        /// no theme style sheet draws nothing, and a sourceAsset left null draws
        /// nothing. None of the three logs anything. So this RPC either produces
        /// a UIDocument that will actually render, or it refuses and says which
        /// link is missing.
        ///
        /// The force import matters for the write-then-attach turn: the agent
        /// writes HUD.uxml and attaches it in the same breath, and Unity has not
        /// necessarily imported the new file yet, so LoadAssetAtPath returns
        /// null for a file that exists on disk. One synchronous import fixes
        /// that; a second would just be a slower way to get the same null, so a
        /// still-null asset is a refusal.
        /// </remarks>
        private static JsonValue AttachUiDocument(JsonValue p)
        {
            string busy = EditorGate.BusyReason();
            if (busy != null) return HierarchyHandlers.Refused(busy);

            string uxmlPath = p["uxmlPath"].AsString;
            if (string.IsNullOrEmpty(uxmlPath))
                return HierarchyHandlers.Refused("attachUiDocument requires a 'uxmlPath'.");

            VisualTreeAsset vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(uxmlPath);
            if (vta == null)
            {
                // Freshly written by this same turn: on disk, not yet imported.
                AssetDatabase.ImportAsset(uxmlPath, ImportAssetOptions.ForceSynchronousImport);
                vta = AssetDatabase.LoadAssetAtPath<VisualTreeAsset>(uxmlPath);
            }
            if (vta == null)
            {
                return HierarchyHandlers.Refused(
                    "The UXML at " + uxmlPath + " did not import as a VisualTreeAsset; " +
                    "check the Console for import errors.");
            }

            // Everything refusable is settled BEFORE the first scene mutation, so
            // a refusal never leaves a half-attached GameObject behind. The
            // asset-side work (creating a PanelSettings, writing a theme) is not
            // undoable anyway, which is why it belongs outside the group.
            PanelSettings panelSettings = ResolvePanelSettings(p, out string psConfidence,
                out bool psCreated, out string psRefusal);
            if (panelSettings == null) return HierarchyHandlers.Refused(psRefusal);

            bool themeCreated = EnsureTheme(panelSettings, out string themeRefusal);
            if (themeRefusal != null) return HierarchyHandlers.Refused(themeRefusal);

            GameObject preexisting = ResolveExistingTarget(p, out string targetRefusal);
            if (targetRefusal != null) return HierarchyHandlers.Refused(targetRefusal);

            // The undo group opens BEFORE the first mutation so the GameObject
            // creation collapses into it — an undo that leaves an orphan
            // GameObject behind is exactly the mess rule 1 exists to prevent.
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName(AttachUndoGroup);
            int undoGroup = Undo.GetCurrentGroup();

            // `??` would be wrong here: UnityEngine.Object overloads `==` with a
            // fake-null for destroyed objects, and the null-coalescing operator
            // ignores that overload.
            bool createdGameObject = ReferenceEquals(preexisting, null);
            GameObject go = createdGameObject
                ? CreateTargetPath(p["target"]["path"].AsString)
                : preexisting;

            bool createdDocument = false;
            UIDocument doc = go.GetComponent<UIDocument>();
            if (doc == null)
            {
                doc = Undo.AddComponent<UIDocument>(go);
                createdDocument = true;
            }
            if (doc == null)
            {
                Undo.RevertAllDownToGroup(undoGroup);
                return HierarchyHandlers.Refused(
                    "Could not add a UIDocument to \"" + HierarchyHandlers.HierarchyPath(go.transform) + "\".");
            }

            float? sortingOrder = p["sortingOrder"].IsNumber ? (float)p["sortingOrder"].AsNumber : (float?)null;
            ApplyUiDocumentFields(doc, vta, panelSettings, sortingOrder);

            if (PrefabUtility.IsPartOfPrefabInstance(doc))
                PrefabUtility.RecordPrefabInstancePropertyModifications(doc);

            Scene scene = go.scene;
            if (scene.IsValid()) EditorSceneManager.MarkSceneDirty(scene);

            Undo.CollapseUndoOperations(undoGroup);

            Selection.activeGameObject = go;
            EditorGUIUtility.PingObject(go);

            string psPath = AssetDatabase.GetAssetPath(panelSettings);

            var goInfo = JsonValue.NewObject();
            goInfo["path"] = HierarchyHandlers.HierarchyPath(go.transform);
            goInfo["instanceId"] = go.GetInstanceID();
            goInfo["created"] = createdGameObject;

            var docInfo = JsonValue.NewObject();
            docInfo["instanceId"] = doc.GetInstanceID();
            docInfo["created"] = createdDocument;

            var psInfo = JsonValue.NewObject();
            psInfo["path"] = psPath ?? "";
            psInfo["guid"] = AssetDatabase.AssetPathToGUID(psPath ?? "") ?? "";
            psInfo["created"] = psCreated;
            psInfo["themeCreated"] = themeCreated;
            psInfo["confidence"] = psConfidence;

            var vtaInfo = JsonValue.NewObject();
            string vtaPath = AssetDatabase.GetAssetPath(vta);
            vtaInfo["path"] = vtaPath ?? uxmlPath;
            vtaInfo["guid"] = AssetDatabase.AssetPathToGUID(vtaPath ?? uxmlPath) ?? "";

            var sceneInfo = JsonValue.NewObject();
            sceneInfo["path"] = scene.IsValid() ? (scene.path ?? "") : "";
            // Not hard-coded true: a GameObject outside any loaded scene has
            // nothing to dirty, and saying otherwise would be the exact
            // "degraded path reads as success" this bridge refuses to do.
            sceneInfo["dirty"] = scene.IsValid();

            var result = JsonValue.NewObject();
            result["ok"] = true;
            result["gameObject"] = goInfo;
            result["uiDocument"] = docInfo;
            result["panelSettings"] = psInfo;
            result["visualTreeAsset"] = vtaInfo;
            result["scene"] = sceneInfo;
            result["undoGroup"] = AttachUndoGroup;
            return result;
        }

        /// <summary>
        /// The target GameObject if it already exists. `null` with a `null`
        /// refusal means "absent, and the caller may create it".
        /// </summary>
        /// <remarks>
        /// Split from the creation half so every refusal this target can produce
        /// is raised BEFORE the undo group opens — an RPC that refuses after
        /// creating a GameObject would leave the user's scene dirty for nothing.
        /// An instanceId target is never created: an id that does not resolve
        /// names an object that is gone, and inventing a new one under that id
        /// would be a lie.
        /// </remarks>
        private static GameObject ResolveExistingTarget(JsonValue p, out string refusal)
        {
            refusal = null;

            JsonValue target = p["target"];
            if (target == null || !target.IsObject)
            {
                refusal = "attachUiDocument requires a 'target' with an 'instanceId' or a 'path'.";
                return null;
            }

            GameObject existing = HierarchyHandlers.ResolveGameObject(target);
            if (existing != null) return existing;

            if (target["instanceId"].IsNumber)
            {
                refusal = "No GameObject with instanceId " + target["instanceId"].AsInt +
                          " — it may have been deleted. Pass a hierarchy path instead.";
                return null;
            }

            string path = target["path"].AsString;
            if (string.IsNullOrEmpty(path))
            {
                refusal = "attachUiDocument requires a 'target' with an 'instanceId' or a 'path'.";
                return null;
            }

            bool createIfMissing = !p.ContainsKey("createIfMissing") || p["createIfMissing"].AsBool;
            if (!createIfMissing)
            {
                refusal = "No GameObject at \"" + path + "\" and createIfMissing is false.";
                return null;
            }

            foreach (string part in path.Split('/'))
            {
                if (string.IsNullOrEmpty(part))
                {
                    refusal = "\"" + path + "\" is not a valid hierarchy path (empty name segment).";
                    return null;
                }
            }
            return null;
        }

        /// <summary>
        /// Create whatever part of a hierarchy path does not exist yet, and
        /// return its leaf.
        /// </summary>
        /// <remarks>
        /// The longest existing prefix wins, so "UI/HUD" against an existing
        /// "UI" adds one child rather than a second root called "UI". Only
        /// called once <see cref="ResolveExistingTarget"/> has validated the
        /// path, and only inside the open undo group, so one Ctrl+Z removes
        /// every GameObject it made.
        /// </remarks>
        private static GameObject CreateTargetPath(string path)
        {
            string[] parts = path.Split('/');
            Transform parent = null;
            int firstMissing = 0;
            for (int i = parts.Length - 1; i >= 1; i--)
            {
                string prefix = string.Join("/", parts, 0, i);
                GameObject found = HierarchyHandlers.FindByHierarchyPath(prefix);
                if (found != null)
                {
                    parent = found.transform;
                    firstMissing = i;
                    break;
                }
            }

            GameObject leaf = null;
            for (int i = firstMissing; i < parts.Length; i++)
            {
                var made = new GameObject(parts[i]);
                Undo.RegisterCreatedObjectUndo(made, AttachUndoGroup);
                if (parent != null) made.transform.SetParent(parent, false);
                parent = made.transform;
                leaf = made;
            }
            return leaf;
        }

        /// <summary>
        /// The PanelSettings to wire up, and how confident the choice is:
        /// "given" (the caller named it), "only" (the project has exactly one)
        /// or "created" (there were none).
        /// </summary>
        /// <remarks>
        /// Several PanelSettings is a refusal rather than a guess. Picking the
        /// wrong one produces UI that renders on the wrong sort layer or at the
        /// wrong scale — visible, plausible and wrong, which costs more to
        /// debug than being asked.
        /// </remarks>
        private static PanelSettings ResolvePanelSettings(JsonValue p, out string confidence,
            out bool createdAsset, out string refusal)
        {
            confidence = "given";
            createdAsset = false;
            refusal = null;

            string given = p["panelSettingsPath"].AsString;
            if (!string.IsNullOrEmpty(given))
            {
                var asset = AssetDatabase.LoadAssetAtPath<PanelSettings>(given);
                if (asset == null)
                {
                    refusal = "No PanelSettings asset at " + given + ".";
                    return null;
                }
                return asset;
            }

            string[] guids = AssetDatabase.FindAssets("t:PanelSettings");
            var paths = new List<string>();
            foreach (string guid in guids)
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (!string.IsNullOrEmpty(path)) paths.Add(path);
            }

            if (paths.Count == 1)
            {
                var only = AssetDatabase.LoadAssetAtPath<PanelSettings>(paths[0]);
                if (only == null)
                {
                    refusal = "The project's only PanelSettings, " + paths[0] + ", could not be loaded.";
                    return null;
                }
                confidence = "only";
                return only;
            }

            if (paths.Count > 1)
            {
                refusal = "This project has " + paths.Count + " PanelSettings assets — " +
                          "pass panelSettingsPath to say which one to use: " + string.Join(", ", paths.ToArray()) + ".";
                return null;
            }

            bool createIfMissing = !p.ContainsKey("createPanelSettingsIfMissing") ||
                                   p["createPanelSettingsIfMissing"].AsBool;
            if (!createIfMissing)
            {
                refusal = "This project has no PanelSettings asset and createPanelSettingsIfMissing is false.";
                return null;
            }

            string createPath = p["panelSettingsCreatePath"].AsString;
            if (string.IsNullOrEmpty(createPath)) createPath = DefaultPanelSettingsPath;
            if (!EnsureAssetFolder(createPath, out string folderError))
            {
                refusal = folderError;
                return null;
            }

            var made = ScriptableObject.CreateInstance<PanelSettings>();
            if (made == null)
            {
                refusal = "Could not create a PanelSettings asset at " + createPath + ".";
                return null;
            }
            try
            {
                AssetDatabase.CreateAsset(made, createPath);
            }
            catch (Exception e)
            {
                refusal = "Could not create a PanelSettings asset at " + createPath + ": " + e.Message;
                return null;
            }

            confidence = "created";
            createdAsset = true;
            return made;
        }

        /// <summary>
        /// Give a PanelSettings a theme when it has none, writing Unity's
        /// default runtime theme if the project does not ship one.
        /// </summary>
        /// <remarks>
        /// A themeless PanelSettings renders NOTHING and logs nothing, so the
        /// agent would attach a perfectly correct UIDocument and report success
        /// over a blank screen. Returns whether a .tss was written.
        /// </remarks>
        private static bool EnsureTheme(PanelSettings panelSettings, out string refusal)
        {
            refusal = null;
            if (panelSettings.themeStyleSheet != null) return false;

            bool wroteFile = false;
            ThemeStyleSheet theme = null;
            foreach (string guid in AssetDatabase.FindAssets("t:ThemeStyleSheet"))
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path)) continue;
                theme = AssetDatabase.LoadAssetAtPath<ThemeStyleSheet>(path);
                if (theme != null) break;
            }

            if (theme == null)
            {
                if (!EnsureAssetFolder(DefaultThemePath, out string folderError))
                {
                    refusal = folderError;
                    return false;
                }
                try
                {
                    string absolute = Path.Combine(
                        Discovery.ProjectRoot(Application.dataPath),
                        DefaultThemePath.Replace('/', Path.DirectorySeparatorChar));
                    File.WriteAllText(absolute, DefaultThemeContents);
                }
                catch (Exception e)
                {
                    refusal = "Could not write a default theme to " + DefaultThemePath + ": " + e.Message;
                    return false;
                }
                AssetDatabase.ImportAsset(DefaultThemePath, ImportAssetOptions.ForceSynchronousImport);
                theme = AssetDatabase.LoadAssetAtPath<ThemeStyleSheet>(DefaultThemePath);
                if (theme == null)
                {
                    refusal = "Wrote " + DefaultThemePath +
                              " but it did not import as a ThemeStyleSheet; check the Console for import errors.";
                    return false;
                }
                wroteFile = true;
            }

            panelSettings.themeStyleSheet = theme;
            EditorUtility.SetDirty(panelSettings);
            AssetDatabase.SaveAssetIfDirty(panelSettings);
            return wroteFile;
        }

        /// <summary>
        /// Point the UIDocument at its .uxml, PanelSettings and sort order.
        /// </summary>
        /// <remarks>
        /// The SerializedObject route is preferred because ApplyModifiedProperties
        /// records its own Undo entry and writes the backing fields exactly the
        /// way the Inspector does. The public-property fallback exists for a
        /// Unity version that renames those fields: `visualTreeAsset` and
        /// `panelSettings` are public API and will not, so an attach never fails
        /// merely because a private field moved.
        /// </remarks>
        private static void ApplyUiDocumentFields(UIDocument doc, VisualTreeAsset vta,
            PanelSettings panelSettings, float? sortingOrder)
        {
            bool applied = false;
            var so = new SerializedObject(doc);
            try
            {
                SerializedProperty source = FindPropertyFlexible(so, "m_SourceAsset");
                SerializedProperty panel = FindPropertyFlexible(so, "m_PanelSettings");
                SerializedProperty sort = FindPropertyFlexible(so, "m_SortingOrder");
                if (source != null && panel != null && (!sortingOrder.HasValue || sort != null))
                {
                    source.objectReferenceValue = vta;
                    panel.objectReferenceValue = panelSettings;
                    if (sortingOrder.HasValue) sort.floatValue = sortingOrder.Value;
                    so.ApplyModifiedProperties();
                    applied = true;
                }
            }
            finally
            {
                so.Dispose();
            }

            if (applied) return;

            Undo.RecordObject(doc, AttachUndoGroup);
            doc.visualTreeAsset = vta;
            doc.panelSettings = panelSettings;
            if (sortingOrder.HasValue) doc.sortingOrder = sortingOrder.Value;
            EditorUtility.SetDirty(doc);
        }

        /// <summary>Create the folder chain an asset path needs. False + a reason on failure.</summary>
        private static bool EnsureAssetFolder(string assetPath, out string error)
        {
            error = null;
            if (string.IsNullOrEmpty(assetPath) || !assetPath.StartsWith("Assets", StringComparison.Ordinal))
            {
                error = "\"" + assetPath + "\" is not a path under Assets/.";
                return false;
            }

            string[] parts = assetPath.Split('/');
            // parts[^1] is the file name; everything before it is folders.
            string sofar = parts[0];
            for (int i = 1; i < parts.Length - 1; i++)
            {
                string next = sofar + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next))
                {
                    string guid = AssetDatabase.CreateFolder(sofar, parts[i]);
                    if (string.IsNullOrEmpty(guid))
                    {
                        error = "Could not create the folder " + next + ".";
                        return false;
                    }
                }
                sofar = next;
            }
            return true;
        }

        // ── setSerializedProperty ────────────────────────────────────────────

        /// <summary>
        /// Set one serialized field on a component, a GameObject or an asset.
        /// </summary>
        /// <remarks>
        /// This is the "wire it up in the Inspector" step that used to be the
        /// hand-off point of every agent turn. It reports `previous` alongside
        /// `applied` on purpose: a set that silently did nothing (a coerced
        /// value, a property Unity clamps) is indistinguishable from a real one
        /// unless the caller can compare, and an agent that cannot compare will
        /// report success either way.
        /// </remarks>
        private static JsonValue SetSerializedProperty(JsonValue p)
        {
            string busy = EditorGate.BusyReason();
            if (busy != null) return HierarchyHandlers.Refused(busy);

            string property = p["property"].AsString;
            if (string.IsNullOrEmpty(property))
                return HierarchyHandlers.Refused("setSerializedProperty requires a 'property'.");

            JsonValue value = p["value"];
            if (value == null || !value.IsObject)
                return HierarchyHandlers.Refused("setSerializedProperty requires a 'value' object with a 'kind'.");

            bool isAsset;
            UnityEngine.Object obj = ResolveWriteTarget(p, out isAsset, out string targetRefusal);
            if (obj == null) return HierarchyHandlers.Refused(targetRefusal);

            string undoGroupName = "UnityIDE: Set " + property;

            var so = new SerializedObject(obj);
            SerializedProperty prop = FindPropertyFlexible(so, property);
            if (prop == null)
            {
                string names = VisiblePropertyNames(so);
                so.Dispose();
                return HierarchyHandlers.Refused(
                    "\"" + obj.name + "\" (" + obj.GetType().Name + ") has no serialized property \"" +
                    property + "\". It has: " + names + ".");
            }

            JsonValue previous = HierarchyHandlers.SerializePropertyValue(prop);
            string propertyType = prop.propertyType.ToString();

            // ApplyValue only writes into the SerializedProperty's in-memory
            // copy — nothing reaches the object until ApplyModifiedProperties —
            // so a refusal here costs the user nothing and needs no undo group
            // opened around it.
            string applyRefusal = ApplyValue(prop, value);
            if (applyRefusal != null)
            {
                so.Dispose();
                return HierarchyHandlers.Refused(applyRefusal);
            }

            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName(undoGroupName);
            int undoGroup = Undo.GetCurrentGroup();

            // ApplyModifiedProperties writes the Undo entry itself, which is why
            // there is no RecordObject above it.
            so.ApplyModifiedProperties();
            JsonValue applied = HierarchyHandlers.SerializePropertyValue(prop);
            so.Dispose();

            bool sceneDirty = false;
            if (isAsset)
            {
                // An asset edit that never reaches disk is lost on the next
                // domain reload — the one case where writing is the honest move.
                EditorUtility.SetDirty(obj);
                AssetDatabase.SaveAssetIfDirty(obj);
            }
            else
            {
                if (PrefabUtility.IsPartOfPrefabInstance(obj))
                    PrefabUtility.RecordPrefabInstancePropertyModifications(obj);
                Scene scene = SceneOf(obj);
                if (scene.IsValid())
                {
                    EditorSceneManager.MarkSceneDirty(scene);
                    sceneDirty = true;
                }
            }

            Undo.CollapseUndoOperations(undoGroup);

            var result = JsonValue.NewObject();
            result["ok"] = true;
            result["target"] = DescribeTarget(obj, isAsset);
            result["property"] = property;
            result["propertyType"] = propertyType;
            result["previous"] = previous;
            result["applied"] = applied;
            result["sceneDirty"] = sceneDirty;
            result["undoGroup"] = undoGroupName;
            return result;
        }

        /// <summary>The object to write to: an asset, a GameObject, or one of its components.</summary>
        private static UnityEngine.Object ResolveWriteTarget(JsonValue p, out bool isAsset, out string refusal)
        {
            isAsset = false;
            refusal = null;

            if (p["componentInstanceId"].IsNumber)
            {
                UnityEngine.Object byId = ObjectFromInstanceId(p["componentInstanceId"].AsInt);
                if (byId == null)
                {
                    refusal = "No object with componentInstanceId " + p["componentInstanceId"].AsInt +
                              " — it may have been deleted.";
                    return null;
                }
                isAsset = AssetDatabase.Contains(byId);
                return byId;
            }

            string assetPath = p["assetPath"].AsString;
            if (!string.IsNullOrEmpty(assetPath))
            {
                var asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(assetPath);
                if (asset == null)
                {
                    refusal = "No asset at " + assetPath + ".";
                    return null;
                }
                string componentOnAsset = p["component"].AsString;
                if (!string.IsNullOrEmpty(componentOnAsset))
                {
                    var prefabRoot = asset as GameObject;
                    if (prefabRoot == null)
                    {
                        refusal = "The asset at " + assetPath + " is a " + asset.GetType().Name +
                                  ", not a prefab, so it has no \"" + componentOnAsset + "\" component.";
                        return null;
                    }
                    Component comp = FindComponent(prefabRoot, componentOnAsset, out string compRefusal);
                    if (comp == null)
                    {
                        refusal = compRefusal;
                        return null;
                    }
                    isAsset = true;
                    return comp;
                }
                isAsset = true;
                return asset;
            }

            JsonValue target = p["target"];
            if (target == null || !target.IsObject)
            {
                refusal = "setSerializedProperty requires an 'assetPath' or a 'target' with an 'instanceId' or a 'path'.";
                return null;
            }

            GameObject go = HierarchyHandlers.ResolveGameObject(target);
            if (go == null)
            {
                string path = target["path"].AsString;
                refusal = string.IsNullOrEmpty(path)
                    ? "No GameObject with instanceId " + target["instanceId"].AsInt + " in any loaded scene."
                    : "No GameObject at \"" + path + "\" in any loaded scene.";
                return null;
            }

            string componentName = p["component"].AsString;
            if (string.IsNullOrEmpty(componentName)) return go;

            Component onGo = FindComponent(go, componentName, out string refusalText);
            if (onGo == null)
            {
                refusal = refusalText;
                return null;
            }
            return onGo;
        }

        /// <summary>A component by type name (case-insensitive), or null + a reason listing what is there.</summary>
        private static Component FindComponent(GameObject go, string typeName, out string refusal)
        {
            refusal = null;
            var names = new List<string>();
            foreach (Component c in go.GetComponents<Component>())
            {
                if (c == null) continue; // missing script
                string name = c.GetType().Name;
                names.Add(name);
                if (string.Equals(name, typeName, StringComparison.OrdinalIgnoreCase)) return c;
            }
            refusal = "\"" + go.name + "\" has no \"" + typeName + "\" component. It has: " +
                      string.Join(", ", names.ToArray()) + ".";
            return null;
        }

        private static UnityEngine.Object ObjectFromInstanceId(int id)
        {
            // Unity 6.3 renamed instance ids to entity ids and deprecated the int
            // overload; EntityIdToObject does not exist below it. Same guard as
            // HierarchyHandlers.ResolveGameObject.
#if UNITY_6000_3_OR_NEWER
            return EditorUtility.EntityIdToObject(id);
#else
            return EditorUtility.InstanceIDToObject(id);
#endif
        }

        private static Scene SceneOf(UnityEngine.Object obj)
        {
            var go = obj as GameObject;
            if (go != null) return go.scene;
            var comp = obj as Component;
            if (comp != null) return comp.gameObject.scene;
            return default(Scene);
        }

        private static JsonValue DescribeTarget(UnityEngine.Object obj, bool isAsset)
        {
            var o = JsonValue.NewObject();
            o["instanceId"] = obj.GetInstanceID();
            o["type"] = obj.GetType().Name;
            o["isAsset"] = isAsset;
            if (isAsset)
            {
                o["path"] = AssetDatabase.GetAssetPath(obj) ?? "";
            }
            else
            {
                var go = obj as GameObject;
                var comp = obj as Component;
                Transform t = go != null ? go.transform : comp != null ? comp.transform : null;
                o["path"] = t != null ? HierarchyHandlers.HierarchyPath(t) : (obj.name ?? "");
            }
            return o;
        }

        // ── Property lookup + value application ──────────────────────────────

        /// <summary>
        /// FindProperty, then the two naming conventions Unity actually uses.
        /// </summary>
        /// <remarks>
        /// The agent knows the C# field name it wrote (`speed`); Unity's
        /// serialized name for a built-in is the backing field (`m_Speed`). Both
        /// directions are tried so neither the author of a MonoBehaviour nor the
        /// reader of an Inspector has to know which convention applies. A nested
        /// path ("items.Array.data[2].name") hits the first attempt unchanged.
        /// </remarks>
        internal static SerializedProperty FindPropertyFlexible(SerializedObject so, string name)
        {
            if (so == null || string.IsNullOrEmpty(name)) return null;

            SerializedProperty direct = so.FindProperty(name);
            if (direct != null) return direct;

            if (name.StartsWith("m_", StringComparison.Ordinal))
            {
                string stripped = name.Substring(2);
                if (stripped.Length > 0)
                {
                    string lowered = char.ToLowerInvariant(stripped[0]) + stripped.Substring(1);
                    SerializedProperty alt = so.FindProperty(lowered);
                    if (alt != null) return alt;
                }
                return null;
            }

            string capitalized = char.ToUpperInvariant(name[0]) + name.Substring(1);
            return so.FindProperty("m_" + capitalized);
        }

        /// <summary>The top-level property names a refusal lists, minus the two nobody means.</summary>
        private static string VisiblePropertyNames(SerializedObject so)
        {
            var names = new List<string>();
            SerializedProperty it = so.GetIterator();
            if (it.NextVisible(true))
            {
                do
                {
                    if (it.name == "m_Script" || it.name == "m_ObjectHideFlags") continue;
                    names.Add(it.name);
                    if (names.Count >= MaxNamesInRefusal) break;
                }
                while (it.NextVisible(false));
            }
            if (names.Count == 0) return "(no settable properties)";
            return string.Join(", ", names.ToArray());
        }

        /// <summary>Write `value` into `prop`. Returns null on success, a refusal reason otherwise.</summary>
        private static string ApplyValue(SerializedProperty prop, JsonValue value)
        {
            string kind = value["kind"].AsStringOr("");
            JsonValue raw = value["value"];

            switch (kind)
            {
                case "int":
                case "float":
                    {
                        double n;
                        if (!TryNumber(raw, out n)) return Mismatch(prop, kind, "a number");
                        if (prop.propertyType == SerializedPropertyType.Integer)
                        {
                            prop.longValue = (long)Math.Round(n);
                            return null;
                        }
                        if (prop.propertyType == SerializedPropertyType.Float)
                        {
                            prop.doubleValue = n;
                            return null;
                        }
                        if (prop.propertyType == SerializedPropertyType.Boolean)
                        {
                            prop.boolValue = n != 0d;
                            return null;
                        }
                        if (prop.propertyType == SerializedPropertyType.Enum)
                        {
                            return SetEnumByIndex(prop, (int)Math.Round(n));
                        }
                        return WrongType(prop, kind);
                    }
                case "bool":
                    {
                        bool b;
                        if (!TryBool(raw, out b)) return Mismatch(prop, kind, "true or false");
                        if (prop.propertyType == SerializedPropertyType.Boolean)
                        {
                            prop.boolValue = b;
                            return null;
                        }
                        if (prop.propertyType == SerializedPropertyType.Integer)
                        {
                            prop.longValue = b ? 1 : 0;
                            return null;
                        }
                        return WrongType(prop, kind);
                    }
                case "string":
                    {
                        string s = raw.AsString;
                        if (s == null) return Mismatch(prop, kind, "a string");
                        if (prop.propertyType == SerializedPropertyType.String)
                        {
                            prop.stringValue = s;
                            return null;
                        }
                        if (prop.propertyType == SerializedPropertyType.Enum) return SetEnumByName(prop, s);
                        return WrongType(prop, kind);
                    }
                case "enum":
                    {
                        if (prop.propertyType != SerializedPropertyType.Enum) return WrongType(prop, kind);
                        string enumName = value["enumName"].AsString ?? raw.AsString;
                        if (!string.IsNullOrEmpty(enumName)) return SetEnumByName(prop, enumName);
                        double idx;
                        if (TryNumber(raw, out idx)) return SetEnumByIndex(prop, (int)Math.Round(idx));
                        return "Setting an enum needs an 'enumName' or a numeric index.";
                    }
                case "color":
                    {
                        if (prop.propertyType != SerializedPropertyType.Color) return WrongType(prop, kind);
                        if (raw == null || !raw.IsObject) return Mismatch(prop, kind, "{ r, g, b, a }");
                        var c = new Color(
                            (float)raw["r"].AsNumber, (float)raw["g"].AsNumber, (float)raw["b"].AsNumber,
                            raw.ContainsKey("a") ? (float)raw["a"].AsNumber : 1f);
                        prop.colorValue = c;
                        return null;
                    }
                case "vector2":
                    {
                        if (prop.propertyType != SerializedPropertyType.Vector2) return WrongType(prop, kind);
                        if (raw == null || !raw.IsObject) return Mismatch(prop, kind, "{ x, y }");
                        prop.vector2Value = new Vector2((float)raw["x"].AsNumber, (float)raw["y"].AsNumber);
                        return null;
                    }
                case "vector3":
                    {
                        if (prop.propertyType != SerializedPropertyType.Vector3) return WrongType(prop, kind);
                        if (raw == null || !raw.IsObject) return Mismatch(prop, kind, "{ x, y, z }");
                        prop.vector3Value = new Vector3(
                            (float)raw["x"].AsNumber, (float)raw["y"].AsNumber, (float)raw["z"].AsNumber);
                        return null;
                    }
                case "objectRef":
                    {
                        if (prop.propertyType != SerializedPropertyType.ObjectReference)
                            return WrongType(prop, kind);
                        UnityEngine.Object resolved = ResolveObjectRef(value["ref"], out string refRefusal);
                        if (resolved == null) return refRefusal;
                        prop.objectReferenceValue = resolved;
                        return null;
                    }
                case "null":
                    {
                        if (prop.propertyType == SerializedPropertyType.ObjectReference)
                        {
                            prop.objectReferenceValue = null;
                            return null;
                        }
                        if (prop.propertyType == SerializedPropertyType.String)
                        {
                            prop.stringValue = "";
                            return null;
                        }
                        return "Only an object reference or a string can be set to null; \"" + prop.name +
                               "\" is a " + prop.propertyType + ".";
                    }
                default:
                    return "Unknown value kind \"" + kind + "\". Use int, float, bool, string, enum, " +
                           "color, vector2, vector3, objectRef or null.";
            }
        }

        private static string WrongType(SerializedProperty prop, string kind)
        {
            return "\"" + prop.name + "\" is a " + prop.propertyType + ", which cannot be set from a " +
                   kind + " value.";
        }

        private static string Mismatch(SerializedProperty prop, string kind, string expected)
        {
            return "Setting \"" + prop.name + "\" as " + kind + " needs a value of " + expected + ".";
        }

        private static string SetEnumByIndex(SerializedProperty prop, int index)
        {
            string[] names = prop.enumNames;
            if (names == null || index < 0 || index >= names.Length)
            {
                return "Enum index " + index + " is out of range for \"" + prop.name + "\". Its values are: " +
                       (names == null ? "(unknown)" : string.Join(", ", names)) + ".";
            }
            prop.enumValueIndex = index;
            return null;
        }

        private static string SetEnumByName(SerializedProperty prop, string name)
        {
            string[] names = prop.enumNames;
            if (names != null)
            {
                for (int i = 0; i < names.Length; i++)
                {
                    if (string.Equals(names[i], name, StringComparison.OrdinalIgnoreCase))
                    {
                        prop.enumValueIndex = i;
                        return null;
                    }
                }
            }
            string[] display = prop.enumDisplayNames;
            if (display != null)
            {
                for (int i = 0; i < display.Length; i++)
                {
                    if (string.Equals(display[i], name, StringComparison.OrdinalIgnoreCase))
                    {
                        prop.enumValueIndex = i;
                        return null;
                    }
                }
            }
            return "\"" + name + "\" is not a value of the enum \"" + prop.name + "\". Its values are: " +
                   (names == null ? "(unknown)" : string.Join(", ", names)) + ".";
        }

        /// <summary>
        /// An object reference by asset guid, asset path or scene path.
        /// </summary>
        /// <remarks>
        /// Guid first: it is the only identifier that survives a file move, and
        /// it is what the .meta the agent just read actually contains. The
        /// refusal names every route that was tried, because "could not resolve"
        /// alone leaves the agent no way to tell a typo'd path from a
        /// not-yet-imported asset.
        /// </remarks>
        private static UnityEngine.Object ResolveObjectRef(JsonValue r, out string refusal)
        {
            refusal = null;
            if (r == null || !r.IsObject)
            {
                refusal = "Setting an object reference needs a 'ref' with a 'guid', an 'assetPath' or a 'scenePath'.";
                return null;
            }

            string subAssetName = r["subAssetName"].AsString;
            var tried = new List<string>();

            string guid = r["guid"].AsString;
            if (!string.IsNullOrEmpty(guid))
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                tried.Add("guid " + guid + (string.IsNullOrEmpty(path) ? " (no asset)" : " → " + path));
                UnityEngine.Object hit = LoadAsset(path, subAssetName);
                if (hit != null) return hit;
            }

            string assetPath = r["assetPath"].AsString;
            if (!string.IsNullOrEmpty(assetPath))
            {
                tried.Add("asset path " + assetPath);
                UnityEngine.Object hit = LoadAsset(assetPath, subAssetName);
                if (hit != null) return hit;
            }

            string scenePath = r["scenePath"].AsString;
            if (!string.IsNullOrEmpty(scenePath))
            {
                string componentType = r["componentType"].AsString;
                tried.Add("scene path " + scenePath +
                          (string.IsNullOrEmpty(componentType) ? "" : " (" + componentType + ")"));
                GameObject go = HierarchyHandlers.FindByHierarchyPath(scenePath);
                if (go != null)
                {
                    if (string.IsNullOrEmpty(componentType)) return go;
                    Component comp = FindComponent(go, componentType, out string _);
                    if (comp != null) return comp;
                }
            }

            refusal = tried.Count == 0
                ? "Setting an object reference needs a 'ref' with a 'guid', an 'assetPath' or a 'scenePath'."
                : "Could not resolve the object reference. Tried: " + string.Join("; ", tried.ToArray()) + ".";
            return null;
        }

        private static UnityEngine.Object LoadAsset(string path, string subAssetName)
        {
            if (string.IsNullOrEmpty(path)) return null;
            if (string.IsNullOrEmpty(subAssetName))
                return AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path);

            foreach (UnityEngine.Object candidate in AssetDatabase.LoadAllAssetsAtPath(path))
            {
                if (candidate != null && string.Equals(candidate.name, subAssetName, StringComparison.Ordinal))
                    return candidate;
            }
            return null;
        }

        private static bool TryNumber(JsonValue v, out double n)
        {
            n = 0d;
            if (v == null) return false;
            if (v.IsNumber)
            {
                n = v.AsNumber;
                return true;
            }
            // Tolerated because the agent tool sends every value as text: the
            // model writes "7", not 7, and refusing that would be pedantry.
            string s = v.AsString;
            return !string.IsNullOrEmpty(s) &&
                   double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out n);
        }

        private static bool TryBool(JsonValue v, out bool b)
        {
            b = false;
            if (v == null) return false;
            if (v.Type == JsonType.Bool)
            {
                b = v.AsBool;
                return true;
            }
            string s = v.AsString;
            if (string.IsNullOrEmpty(s)) return false;
            if (string.Equals(s, "true", StringComparison.OrdinalIgnoreCase)) { b = true; return true; }
            if (string.Equals(s, "false", StringComparison.OrdinalIgnoreCase)) { b = false; return true; }
            return false;
        }
    }
}
