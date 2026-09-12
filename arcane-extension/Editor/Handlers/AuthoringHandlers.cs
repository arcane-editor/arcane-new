using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityIDE.Bridge
{
    internal static class AuthoringHandlers
    {
        internal static void Register()
        {
            RpcDispatcher.Register("authorScene", Author);
            RpcDispatcher.Register("getAuthoringStatus", p => Status(p["operationId"].AsString));
            RpcDispatcher.Register("verifySavedScene", p => Verify(p["scenePath"].AsString, p["requireAuthoredLevel"].AsBool, p["root"].AsString));
        }

        internal static JsonValue Status(string id)
        {
            // Author is synchronous on the main thread. A status request cannot
            // interleave with it; a persisted running record means a reload or
            // shutdown interrupted the transaction, not permission to repeat it.
            var report = AutomationStore.Read("author", id);
            if (report["status"].AsString == "running") {
                report["status"] = "interrupted";
                report["reason"] = "Authoring was interrupted. Inspect declared outputs or restore the task checkpoint before issuing a new operation.";
                AutomationStore.Save("author", id, report);
            }
            return report;
        }

        internal static void RequireIdleClean()
        {
            string busy = EditorGate.BusyReason();
            if (busy != null) throw new InvalidOperationException(busy);
            for (int i = 0; i < SceneManager.sceneCount; i++)
                if (SceneManager.GetSceneAt(i).isDirty) throw new InvalidOperationException("Unsaved scene changes: save or discard them in Unity before automation.");
        }

        internal static JsonValue Author(JsonValue p)
        {
            string id = AutomationStore.Id(p["operationId"].AsString);
            var prior = AutomationStore.Read("author", id);
            string payloadHash = AutomationStore.Hash(p.Serialize());
            if (prior["status"].AsString != "unsupported") {
                if (prior["payloadHash"].AsString != payloadHash) return AutomationStore.Report(id, "failed", "Operation ID already belongs to different authoring inputs. Query status and use a new ID.");
                return prior;
            }
            Scene scene = default;
            bool opened = false;
            int group = -1;
            var report = AutomationStore.Report(id, "running");
            report["payloadHash"] = payloadHash;
            report["taskId"] = p["taskId"];
            report["outputs"] = p["outputs"];
            var backups = new Dictionary<string, byte[]>();
            Scene previousActive = SceneManager.GetActiveScene();
            string previousActivePath = previousActive.path;
            string targetPath = null;
            try
            {
                RequireIdleClean();
                string path = AutomationStore.AssetPath(p["scenePath"].AsString);
                targetPath = path;
                if (!path.EndsWith(".unity", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("scenePath must end in .unity");
                string rootName = p["ownedRoot"].AsString;
                string rootGlobalObjectId = p["rootGlobalObjectId"].AsString;
                bool existingRoot = !string.IsNullOrEmpty(rootGlobalObjectId);
                if (existingRoot == !string.IsNullOrEmpty(rootName)) throw new ArgumentException("Provide exactly one of ownedRoot or rootGlobalObjectId.");
                if (!existingRoot && (string.IsNullOrWhiteSpace(rootName) || rootName.Contains("/") || rootName.Contains("\\"))) throw new ArgumentException("ownedRoot must be one root name.");
                if (existingRoot && p["builder"].IsObject) throw new ArgumentException("Existing-scene authoring uses scoped actions; an Editor builder cannot be confined to the selected root.");
                if (existingRoot && !p["expectedAssetHashes"].IsObject) throw new ArgumentException("Existing-scene authoring requires checkpoint hashes.");
                var outputs = new HashSet<string>();
                if (!p["outputs"].IsArray || !p["actions"].IsArray) throw new ArgumentException("Declare outputs and actions.");
                foreach (var output in p["outputs"].Array) outputs.Add(AutomationStore.AssetPath(output.AsString));
                if (!outputs.Contains(path)) throw new ArgumentException("Declare the scene in outputs.");
                if (p["expectedAssetHashes"].IsObject) foreach (var expected in p["expectedAssetHashes"]) {
                    string target = AutomationStore.AssetPath(expected.Key);
                    if (!outputs.Contains(target) && !(target.EndsWith(".meta") && outputs.Contains(target.Substring(0, target.Length - 5)))) throw new ArgumentException("Unexpected checkpoint target.");
                    string current = null;
                    if (File.Exists(target)) using (var hash = SHA256.Create()) current = BitConverter.ToString(hash.ComputeHash(File.ReadAllBytes(target))).Replace("-", "");
                    if (current != expected.Value.AsString) throw new InvalidOperationException("Conflicting edit since the task checkpoint: " + target);
                }
                foreach (string output in outputs)
                {
                    if (!existingRoot && output != path && File.Exists(output) && AutomationStore.Read("ownership", OwnershipKey(output, rootName))["status"].AsString != "passed")
                        throw new InvalidOperationException("Refusing to overwrite an asset not owned by this builder: " + output);
                    backups[output] = File.Exists(output) ? File.ReadAllBytes(output) : null;
                    backups[output + ".meta"] = File.Exists(output + ".meta") ? File.ReadAllBytes(output + ".meta") : null;
                }
                AutomationStore.Save("author", id, report);
                scene = SceneManager.GetSceneByPath(path);
                if (!scene.IsValid() || !scene.isLoaded)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    if (File.Exists(path)) scene = EditorSceneManager.OpenScene(path, OpenSceneMode.Additive);
                    else
                    {
                        // Unity 6 refuses NewSceneMode.Additive while its clean,
                        // untitled startup scene is open. That scene contains no
                        // persistent user work (dirty scenes were rejected above),
                        // so replace it only when it is the sole loaded scene;
                        // otherwise close just the untitled scene and preserve
                        // every saved scene in the designer's current setup.
                        Scene untitled = Enumerable.Range(0, SceneManager.sceneCount)
                            .Select(SceneManager.GetSceneAt)
                            .FirstOrDefault(candidate => string.IsNullOrEmpty(candidate.path));
                        if (untitled.IsValid() && SceneManager.sceneCount == 1)
                            scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                        else
                        {
                            if (untitled.IsValid()) EditorSceneManager.CloseScene(untitled, true);
                            scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
                        }
                    }
                    opened = true;
                }
                SceneManager.SetActiveScene(scene);
                string ownership = existingRoot ? null : OwnershipKey(path, rootName);
                GameObject root = existingRoot ? ResolveStableGameObject(rootGlobalObjectId, scene) : scene.GetRootGameObjects().SingleOrDefault(g => g.name == rootName);
                if (!existingRoot && root != null && AutomationStore.Read("ownership", ownership)["status"].AsString != "passed")
                    throw new InvalidOperationException("The target root was not created by UnityIDE automation. Choose a new ownedRoot.");
                Undo.IncrementCurrentGroup(); group = Undo.GetCurrentGroup(); Undo.SetCurrentGroupName("UnityIDE authoring");
                if (root == null && !existingRoot) { root = new GameObject(rootName); SceneManager.MoveGameObjectToScene(root, scene); Undo.RegisterCreatedObjectUndo(root, "Create owned root"); }
                if (root == null) throw new ArgumentException("Existing authored root was not found in the declared scene.");
                rootName = root.name;
                foreach (var action in p["actions"].Array) Apply(root, action, outputs);
                if (p["builder"].IsObject) RunBuilder(p["builder"]);
                foreach (string output in outputs) {
                    if (output != path && !File.Exists(output)) throw new InvalidOperationException("Declared output was not created: " + output);
                    var asset = AssetDatabase.LoadMainAssetAtPath(output);
                    if (asset != null && output != path) AssetDatabase.SaveAssetIfDirty(asset);
                    if (output.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)) {
                        var prefab = PrefabUtility.LoadPrefabContents(output);
                        try { AssertPersistentDependencies(prefab.scene); }
                        finally { PrefabUtility.UnloadPrefabContents(prefab); }
                    }
                }
                AssertPersistentDependencies(scene, root);
                if (p["requireAuthoredLevel"].AsBool) AssertRepresentativeLevel(scene, root);
                Undo.CollapseUndoOperations(group);
                if (!EditorSceneManager.SaveScene(scene, path)) throw new IOException("Unity refused to save the scene.");
                if (!existingRoot) AutomationStore.Save("ownership", ownership, AutomationStore.Report(ownership, "passed"));
                // Reopen from disk; inspecting the in-memory scene is not persistence verification.
                Scene reopened = EditorSceneManager.OpenPreviewScene(path);
                try {
                    GameObject reopenedRoot = existingRoot ? FindStableGameObjectInScene(rootGlobalObjectId, reopened) : reopened.GetRootGameObjects().SingleOrDefault(g => g.name == rootName);
                    if (reopenedRoot == null) throw new IOException("Authored root did not survive reopening.");
                    AssertPersistentDependencies(reopened, reopenedRoot);
                    if (p["requireAuthoredLevel"].AsBool) AssertRepresentativeLevel(reopened, reopenedRoot);
                } finally { EditorSceneManager.ClosePreviewScene(reopened); }
                report = AutomationStore.Report(id, "passed", "Saved scene reopened with persistent content.");
                report["taskId"] = p["taskId"];
                report["payloadHash"] = payloadHash;
                report["scenePersistence"] = true; report["outputs"] = p["outputs"]; report["authoredRoot"] = rootName;
                if (!existingRoot) foreach (string output in outputs) AutomationStore.Save("ownership", OwnershipKey(output, rootName), AutomationStore.Report(id, "passed"));
                AutomationStore.Save("author", id, report);
                // Leave authored content visible and editable in the Scene view.
                SceneManager.SetActiveScene(scene);
                Selection.activeGameObject = root;
                FrameInSceneView(root);
                return report;
            }
            catch (Exception e)
            {
                if (group >= 0) Undo.RevertAllDownToGroup(group);
                if (scene.IsValid() && scene.isLoaded && (opened || group >= 0)) EditorSceneManager.CloseScene(scene, true);
                foreach (var backup in backups)
                {
                    if (backup.Value == null) { if (File.Exists(backup.Key)) File.Delete(backup.Key); }
                    else File.WriteAllBytes(backup.Key, backup.Value);
                }
                AssetDatabase.Refresh();
                if (group >= 0 && !opened && !string.IsNullOrEmpty(targetPath) && File.Exists(targetPath)) EditorSceneManager.OpenScene(targetPath, OpenSceneMode.Additive);
                if (!previousActive.IsValid() && !string.IsNullOrEmpty(previousActivePath)) previousActive = SceneManager.GetSceneByPath(previousActivePath);
                if (previousActive.IsValid() && previousActive.isLoaded) SceneManager.SetActiveScene(previousActive);
                report = AutomationStore.Report(id, "failed", e.GetBaseException().Message);
                report["taskId"] = p["taskId"];
                report["payloadHash"] = payloadHash;
                AutomationStore.Save("author", id, report);
                return report;
            }
        }

        private static string OwnershipKey(string path, string root)
        {
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(path + ":" + root))).Replace("-", "");
        }

        private static void Apply(GameObject root, JsonValue action, HashSet<string> outputs)
        {
            string relative = action["target"].AsStringOr("");
            if (relative.StartsWith("/") || relative.Contains("..") || relative.Contains("\\")) throw new ArgumentException("Invalid owned-root target.");
            string kind = action["kind"].AsString;
            if (kind != "object" && kind != "prefab" && kind != "component" && kind != "property" && kind != "savePrefab") throw new ArgumentException("Unknown authoring action.");
            if (action["parent"].IsString) throw new ArgumentException("Use a hierarchical target path to name the parent, for example Track/Obstacle.");
            string targetGlobalObjectId = action["targetGlobalObjectId"].AsString;
            Transform found = string.IsNullOrEmpty(targetGlobalObjectId) ? (string.IsNullOrEmpty(relative) ? root.transform : root.transform.Find(relative)) : null;
            GameObject go = !string.IsNullOrEmpty(targetGlobalObjectId) ? ResolveStableGameObject(targetGlobalObjectId, root.scene) : found != null ? found.gameObject : null;
            if (go != null && !IsWithinRoot(go.transform, root.transform)) throw new ArgumentException("Stable target is outside the declared authored root.");
            if ((kind == "object" || kind == "prefab") && go == null)
            {
                string parentPath = relative.Contains("/") ? relative.Substring(0, relative.LastIndexOf('/')) : "";
                Transform parent = string.IsNullOrEmpty(parentPath) ? root.transform : root.transform.Find(parentPath);
                if (parent == null) throw new ArgumentException("Create the parent first: " + parentPath);
                if (kind == "prefab")
                {
                    var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(AutomationStore.AssetPath(action["assetPath"].AsString));
                    if (prefab == null) throw new ArgumentException("Prefab asset not found.");
                    go = (GameObject)PrefabUtility.InstantiatePrefab(prefab, root.scene);
                }
                else if (Enum.TryParse(action["primitive"].AsString, out PrimitiveType primitive)) go = GameObject.CreatePrimitive(primitive);
                else go = new GameObject();
                go.name = relative.Split('/').Last(); Undo.RegisterCreatedObjectUndo(go, "Create authored object");
                Undo.SetTransformParent(go.transform, parent, "Parent authored object");
            }
            if (go == null) throw new ArgumentException("Target not found: " + relative);
            Undo.RecordObject(go.transform, "Set transform");
            if (action["position"].IsObject) go.transform.localPosition = Vector(action["position"]);
            if (action["scale"].IsObject) go.transform.localScale = Vector(action["scale"]);
            if (kind == "component")
            {
                Type type = ResolveType(action["component"].AsString);
                if (type == null || !typeof(Component).IsAssignableFrom(type)) throw new ArgumentException("Component type not found.");
                if (go.GetComponent(type) == null) Undo.AddComponent(go, type);
            }
            if (kind == "property")
            {
                Type type = ResolveType(action["component"].AsString);
                string componentGlobalObjectId = action["componentGlobalObjectId"].AsString;
                Component component = !string.IsNullOrEmpty(componentGlobalObjectId)
                    ? ResolveStableComponent(componentGlobalObjectId, go)
                    : type == null ? null : go.GetComponent(type);
                if (component == null) throw new ArgumentException("Component not found.");
                Undo.RecordObject(component, "Set authored property");
                var serialized = new SerializedObject(component);
                var property = SceneMutationHandlers.FindPropertyFlexible(serialized, action["property"].AsString);
                if (property == null) throw new ArgumentException("Serialized property not found.");
                string error = SceneMutationHandlers.ApplyValue(property, action["value"]);
                if (error != null) throw new ArgumentException(error);
                serialized.ApplyModifiedProperties();
                PrefabUtility.RecordPrefabInstancePropertyModifications(component);
            }
            if (kind == "savePrefab")
            {
                string output = AutomationStore.AssetPath(action["assetPath"].AsString);
                if (!outputs.Contains(output) || !output.EndsWith(".prefab")) throw new ArgumentException("Declare the prefab output.");
                Directory.CreateDirectory(Path.GetDirectoryName(output));
                PrefabUtility.SaveAsPrefabAsset(go, output, out bool success);
                if (!success) throw new IOException("Prefab save failed.");
            }
        }

        private static bool IsWithinRoot(Transform target, Transform root)
        {
            for (Transform current = target; current != null; current = current.parent)
                if (current == root) return true;
            return false;
        }

        private static GameObject ResolveStableGameObject(string value, Scene scene)
        {
            var resolved = HierarchyHandlers.ResolveGlobalObject(value);
            GameObject go = resolved as GameObject;
            if (go == null && resolved is Component component) go = component.gameObject;
            if (go == null || go.scene != scene) throw new ArgumentException("Stable GameObject target is stale or outside the declared scene.");
            return go;
        }

        private static Component ResolveStableComponent(string value, GameObject owner)
        {
            var component = HierarchyHandlers.ResolveGlobalObject(value) as Component;
            if (component == null || component.gameObject != owner) throw new ArgumentException("Stable component target is stale or belongs to another GameObject.");
            return component;
        }

        private static GameObject FindStableGameObjectInScene(string value, Scene scene)
        {
            foreach (var sceneRoot in scene.GetRootGameObjects())
            foreach (var transform in sceneRoot.GetComponentsInChildren<Transform>(true))
                if (GlobalObjectId.GetGlobalObjectIdSlow(transform.gameObject).ToString() == value) return transform.gameObject;
            return null;
        }

        private static GameObject FindAuthoredRoot(Scene scene, string root)
        {
            if (string.IsNullOrEmpty(root)) return null;
            if (root.StartsWith("GlobalObjectId_V1-", StringComparison.Ordinal)) return FindStableGameObjectInScene(root, scene);
            var matches = scene.GetRootGameObjects().Where(go => go.name == root).ToArray();
            if (matches.Length != 1) throw new InvalidOperationException("The authored root must identify exactly one saved scene root.");
            return matches[0];
        }

        private static void FrameInSceneView(GameObject root)
        {
            var renderers = root.GetComponentsInChildren<Renderer>(false).Where(r => r.enabled).ToArray();
            if (renderers.Length == 0 || SceneView.lastActiveSceneView == null) return;
            Bounds bounds = renderers[0].bounds;
            foreach (var renderer in renderers.Skip(1)) bounds.Encapsulate(renderer.bounds);
            SceneView.lastActiveSceneView.Frame(bounds, true);
            SceneView.lastActiveSceneView.Repaint();
        }

        internal static Type ResolveType(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type type = assembly.GetType(name);
                if (type != null) return type;
                type = assembly.GetType("UnityEngine." + name);
                if (type != null) return type;
            }
            return null;
        }
        private static Vector3 Vector(JsonValue v) => new Vector3((float)v["x"].AsNumber, (float)v["y"].AsNumber, (float)v["z"].AsNumber);

        private static void RunBuilder(JsonValue builder)
        {
            Type type = ResolveType(builder["type"].AsString);
            if (type == null) throw new ArgumentException("Builder type not compiled.");
            var scripts = AssetDatabase.FindAssets("t:MonoScript", new[] { "Assets" });
            bool editorSource = scripts.Select(AssetDatabase.GUIDToAssetPath).Where(p => p.Contains("/Editor/"))
                .Any(p => AssetDatabase.LoadAssetAtPath<MonoScript>(p)?.GetClass() == type);
            if (!editorSource) throw new ArgumentException("Builder must come from a project Editor script.");
            MethodInfo method = type.GetMethod(builder["method"].AsString, BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
            if (method == null || method.ReturnType != typeof(void)) throw new ArgumentException("Builder must be public static void Method(string parameters).");
            method.Invoke(null, new object[] { builder["parameters"].AsStringOr("{}") });
        }

        internal static void AssertPersistentDependencies(Scene scene, GameObject authoredRoot = null)
        {
            var roots = scene.GetRootGameObjects();
            if (roots.Length == 0) throw new InvalidOperationException("Saved scene contains no objects.");
            foreach (var root in authoredRoot != null ? new[] { authoredRoot } : roots)
            foreach (var transform in root.GetComponentsInChildren<Transform>(true))
            {
                if (GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(transform.gameObject) > 0) throw new InvalidOperationException("Missing script: " + transform.name);
                foreach (var component in transform.GetComponents<Component>())
                {
                    if (component == null) continue;
                    var serialized = new SerializedObject(component); var property = serialized.GetIterator();
                    while (property.Next(true))
                    {
                        if (property.propertyType != SerializedPropertyType.ObjectReference) continue;
                        var referenced = property.objectReferenceValue;
                        if (referenced == null && property.objectReferenceInstanceIDValue != 0) throw new InvalidOperationException("Missing reference: " + transform.name + "." + property.propertyPath);
                        if (referenced is Mesh || referenced is Material || referenced is Texture)
                            if (!EditorUtility.IsPersistent(referenced)) throw new InvalidOperationException("Save generated dependency as an asset: " + referenced.name);
                    }
                }
            }
        }

        internal static void AssertRepresentativeLevel(Scene scene, GameObject authoredRoot = null)
        {
            var roots = authoredRoot != null ? new[] { authoredRoot } : scene.GetRootGameObjects();
            bool visible = roots.Any(root =>
                root.GetComponentsInChildren<Renderer>(false).Any(renderer => renderer.enabled && renderer.bounds.size.sqrMagnitude > 0.0001f) ||
                root.GetComponentsInChildren<Terrain>(false).Any(terrain => terrain.enabled && terrain.terrainData != null));
            bool collision = roots.Any(root =>
                root.GetComponentsInChildren<Collider>(false).Any(collider => collider.enabled && collider.bounds.size.sqrMagnitude > 0.0001f) ||
                root.GetComponentsInChildren<Collider2D>(false).Any(collider => collider.enabled && collider.bounds.size.sqrMagnitude > 0.0001f));
            if (!visible || !collision) throw new InvalidOperationException("No saved representative level geometry with collision exists before Play. Runtime-only construction does not satisfy level authoring.");
        }

        internal static JsonValue Verify(string path, bool requireAuthoredLevel = false, string root = null)
        {
            string id = "scene-check";
            Scene scene = default;
            try
            {
                RequireIdleClean(); path = AutomationStore.AssetPath(path);
                scene = EditorSceneManager.OpenPreviewScene(path);
                GameObject authoredRoot = string.IsNullOrEmpty(root) ? null : FindAuthoredRoot(scene, root);
                if (!string.IsNullOrEmpty(root) && authoredRoot == null) throw new InvalidOperationException("Required authored root did not survive reopening.");
                AssertPersistentDependencies(scene, authoredRoot);
                if (requireAuthoredLevel) AssertRepresentativeLevel(scene, authoredRoot);
                var report = AutomationStore.Report(id, "passed", "Saved scene reopens with visible Edit Mode content and persistent dependencies.");
                report["scenePersistence"] = true; var outputs = JsonValue.NewArray(); outputs.Add(path); report["outputs"] = outputs;
                if (authoredRoot != null) report["authoredRoot"] = authoredRoot.name;
                return report;
            }
            catch (Exception e) { return AutomationStore.Report(id, "failed", e.Message); }
            finally { if (scene.IsValid() && scene.isLoaded) EditorSceneManager.ClosePreviewScene(scene); }
        }
    }
}
