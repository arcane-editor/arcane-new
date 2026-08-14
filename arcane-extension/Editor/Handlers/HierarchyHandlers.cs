// HierarchyHandlers.cs — scene/GameObject inspection RPCs + the hierarchy_changed
// push. All handler bodies run on the main thread (scene + SerializedObject
// access). Registered into RpcDispatcher.
//
// Methods:
//   getSceneHierarchy  → { scenes:[{name,path,roots[]}], truncated }
//   getGameObject      → full component list with serialized property values
//   findReferencesToScript → { gameObjects:[{scene,path,instanceId}] } for a guid
//   listScenes         → { scenes:[{name,path,guid,loaded}] } — every scene in Assets/
//   openScene          → { ok } | error — opens a scene, honouring unsaved changes
//
// Push:
//   hierarchy_changed { } on EditorApplication.hierarchyChanged (debounced ~250ms).

using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;

namespace Arcane.Bridge
{
    internal static class HierarchyHandlers
    {
        // Per-GameObject serialized-value caps for getGameObject so a single fat
        // object (huge arrays, long strings) can't produce an oversized reply.
        private const int MaxArrayElements = 64;     // elements serialized per array property
        private const int MaxStringValueLength = 4096; // truncate long string values
        private const int MaxPropertiesPerComponent = 400; // safety valve

        private static BridgeClient _client;
        private static bool _hierarchyHookInstalled;

        // Debounce state for hierarchy_changed.
        private static double _hierarchyDirtyAt = -1;
        private const double HierarchyDebounceSeconds = 0.25;

        public static void Register(BridgeClient client)
        {
            _client = client;
            RpcDispatcher.Register("getSceneHierarchy", GetSceneHierarchy);
            RpcDispatcher.Register("getGameObject", GetGameObject);
            RpcDispatcher.Register("findReferencesToScript", FindReferencesToScript);
            RpcDispatcher.Register("listScenes", ListScenes);
            RpcDispatcher.Register("openScene", OpenScene);
            InstallHierarchyHook();
        }

        // ── getSceneHierarchy ────────────────────────────────────────────────

        private static JsonValue GetSceneHierarchy(JsonValue p)
        {
            return HierarchySerializer.SerializeLoadedScenes();
        }


        // ── listScenes ───────────────────────────────────────────────────────

        /// <summary>
        /// Every scene asset under `Assets/`, flagged with whether it is
        /// currently loaded.
        /// </summary>
        /// <remarks>
        /// The Hierarchy panel could only ever show what Unity already had
        /// open, so switching scenes meant alt-tabbing to Unity. This is the
        /// list behind the panel's scene picker.
        ///
        /// `Assets/` only: package scenes are read-only and opening one is
        /// never what a user means from a project scene switcher.
        /// </remarks>
        private static JsonValue ListScenes(JsonValue p)
        {
            var loaded = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                Scene s = SceneManager.GetSceneAt(i);
                if (s.IsValid() && !string.IsNullOrEmpty(s.path)) loaded.Add(s.path);
            }

            var scenes = JsonValue.NewArray();
            foreach (string guid in AssetDatabase.FindAssets("t:Scene", new[] { "Assets" }))
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path)) continue;

                var obj = JsonValue.NewObject();
                obj["name"] = System.IO.Path.GetFileNameWithoutExtension(path);
                obj["path"] = path;
                obj["guid"] = guid;
                obj["loaded"] = loaded.Contains(path);
                scenes.Add(obj);
            }

            var result = JsonValue.NewObject();
            result["scenes"] = scenes;
            return result;
        }

        // ── openScene ────────────────────────────────────────────────────────

        /// <summary>
        /// Open a scene in the Unity Editor. `mode` is "single" (default) or
        /// "additive".
        /// </summary>
        /// <remarks>
        /// Refused during play mode and compilation. Changing the open scene
        /// while entering/exiting play mode loses state Unity cannot recover,
        /// and during a compile the domain is about to reload underneath us —
        /// both are cases where a silent failure would look like the IDE
        /// ignoring the click.
        ///
        /// SaveCurrentModifiedScenesIfUserWantsTo is Unity's own prompt, so an
        /// unsaved scene raises the dialog the user already knows rather than
        /// this bridge inventing one. It returns false when they cancel, which
        /// is reported as a refusal, not an error.
        /// </remarks>
        private static JsonValue OpenScene(JsonValue p)
        {
            string path = p != null && p["path"] != null ? p["path"].AsString : null;
            if (string.IsNullOrEmpty(path))
            {
                return Refused("openScene requires a 'path'.");
            }
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isPlaying)
            {
                return Refused("Unity is in Play Mode. Exit Play Mode to change scenes.");
            }
            if (EditorApplication.isCompiling)
            {
                return Refused("Unity is compiling. Try again once the compile finishes.");
            }

            string modeStr = p["mode"] != null ? p["mode"].AsString : "single";
            var mode = string.Equals(modeStr, "additive", StringComparison.OrdinalIgnoreCase)
                ? OpenSceneMode.Additive
                : OpenSceneMode.Single;

            // Only the single-scene path replaces what is open, so only it can
            // discard unsaved work.
            if (mode == OpenSceneMode.Single &&
                !EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo())
            {
                return Refused("Cancelled — the open scene has unsaved changes.");
            }

            try
            {
                EditorSceneManager.OpenScene(path, mode);
            }
            catch (Exception e)
            {
                return Refused("Could not open scene: " + e.Message);
            }

            var ok = JsonValue.NewObject();
            ok["ok"] = true;
            return ok;
        }

        /// <summary>A refusal the UI can show verbatim, distinct from a crash.</summary>
        private static JsonValue Refused(string reason)
        {
            var o = JsonValue.NewObject();
            o["ok"] = false;
            o["reason"] = reason;
            return o;
        }

        // ── getGameObject ────────────────────────────────────────────────────

        private static JsonValue GetGameObject(JsonValue p)
        {
            GameObject go = ResolveGameObject(p);
            if (go == null)
            {
                var err = JsonValue.NewObject();
                err["found"] = false;
                return err;
            }

            var result = JsonValue.NewObject();
            result["found"] = true;
            result["name"] = go.name ?? "";
            result["active"] = go.activeSelf;
            result["instanceId"] = go.GetInstanceID();

            string tag;
            try { tag = go.tag; } catch { tag = "Untagged"; }
            result["tag"] = tag;
            result["layer"] = go.layer;

            var components = JsonValue.NewArray();
            foreach (var c in go.GetComponents<Component>())
            {
                components.Add(SerializeComponent(c));
            }
            result["components"] = components;
            return result;
        }

        private static GameObject ResolveGameObject(JsonValue p)
        {
            // By instanceId (preferred — unambiguous).
            if (p["instanceId"].IsNumber)
            {
                int id = p["instanceId"].AsInt;
                // Unity 6.3 renamed instance ids to entity ids and deprecated the
                // int overload. EntityIdToObject does not exist below 6.3, so this
                // has to be a version guard rather than a straight swap — the
                // package still supports 2021.3. `int` converts to EntityId
                // implicitly, so the argument is unchanged.
#if UNITY_6000_3_OR_NEWER
                var obj = EditorUtility.EntityIdToObject(id);
#else
                var obj = EditorUtility.InstanceIDToObject(id);
#endif
                if (obj is GameObject go) return go;
                if (obj is Component comp) return comp.gameObject;
                return null;
            }

            // By hierarchy path ("Parent/Child/Leaf"), searched across loaded scenes.
            string path = p["path"].AsString;
            if (!string.IsNullOrEmpty(path))
                return FindByHierarchyPath(path);

            return null;
        }

        private static GameObject FindByHierarchyPath(string path)
        {
            string[] parts = path.Split('/');
            if (parts.Length == 0) return null;

            int sceneCount = SceneManager.sceneCount;
            for (int s = 0; s < sceneCount; s++)
            {
                Scene scene = SceneManager.GetSceneAt(s);
                if (!scene.IsValid() || !scene.isLoaded) continue;
                foreach (var root in scene.GetRootGameObjects())
                {
                    if (root.name != parts[0]) continue;
                    GameObject match = DescendPath(root.transform, parts, 1);
                    if (match != null) return match;
                }
            }
            return null;
        }

        private static GameObject DescendPath(Transform current, string[] parts, int index)
        {
            if (index >= parts.Length) return current.gameObject;
            for (int i = 0; i < current.childCount; i++)
            {
                Transform child = current.GetChild(i);
                if (child.name == parts[index])
                {
                    GameObject r = DescendPath(child, parts, index + 1);
                    if (r != null) return r;
                }
            }
            return null;
        }

        // ── Component serialization (SerializedObject walk) ──────────────────

        private static JsonValue SerializeComponent(Component c)
        {
            var obj = JsonValue.NewObject();
            if (c == null)
            {
                obj["type"] = "MissingComponent";
                return obj;
            }

            obj["type"] = c.GetType().Name;
            obj["instanceId"] = c.GetInstanceID();

            var props = JsonValue.NewObject();
            try
            {
                var so = new SerializedObject(c);
                SerializedProperty it = so.GetIterator();
                int emitted = 0;
                // enterChildren=true on the first MoveNext, then iterate siblings at
                // the top level (NextVisible(false) does not descend, keeping the
                // dump shallow and bounded).
                if (it.NextVisible(true))
                {
                    do
                    {
                        if (emitted >= MaxPropertiesPerComponent) break;
                        // Skip the script reference pseudo-field name "m_Script".
                        if (it.name == "m_Script") continue;
                        props[it.name] = SerializePropertyValue(it);
                        emitted++;
                    }
                    while (it.NextVisible(false));
                }
                so.Dispose();
            }
            catch (Exception e)
            {
                props["__error"] = "serialization failed: " + e.Message;
            }
            obj["properties"] = props;
            return obj;
        }

        private static JsonValue SerializePropertyValue(SerializedProperty prop)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Integer:
                    return JsonValue.Of((long)prop.longValue);
                case SerializedPropertyType.Boolean:
                    return JsonValue.Of(prop.boolValue);
                case SerializedPropertyType.Float:
                    return JsonValue.Of(prop.doubleValue);
                case SerializedPropertyType.String:
                    return JsonValue.Of(Truncate(prop.stringValue));
                case SerializedPropertyType.Enum:
                    {
                        var o = JsonValue.NewObject();
                        o["enum"] = prop.enumValueIndex;
                        string[] names = prop.enumDisplayNames;
                        if (names != null && prop.enumValueIndex >= 0 && prop.enumValueIndex < names.Length)
                            o["name"] = names[prop.enumValueIndex];
                        return o;
                    }
                case SerializedPropertyType.Color:
                    {
                        Color col = prop.colorValue;
                        var o = JsonValue.NewObject();
                        o["r"] = col.r; o["g"] = col.g; o["b"] = col.b; o["a"] = col.a;
                        return o;
                    }
                case SerializedPropertyType.Vector2:
                    return Vec(prop.vector2Value.x, prop.vector2Value.y, null, null);
                case SerializedPropertyType.Vector3:
                    return Vec(prop.vector3Value.x, prop.vector3Value.y, prop.vector3Value.z, null);
                case SerializedPropertyType.Vector4:
                    return Vec(prop.vector4Value.x, prop.vector4Value.y, prop.vector4Value.z, prop.vector4Value.w);
                case SerializedPropertyType.Quaternion:
                    return Vec(prop.quaternionValue.x, prop.quaternionValue.y,
                               prop.quaternionValue.z, prop.quaternionValue.w);
                case SerializedPropertyType.ObjectReference:
                    {
                        var o = JsonValue.NewObject();
                        var refObj = prop.objectReferenceValue;
                        if (refObj != null)
                        {
                            o["name"] = refObj.name ?? "";
                            o["type"] = refObj.GetType().Name;
                            o["instanceId"] = refObj.GetInstanceID();
                        }
                        else
                        {
                            o["name"] = JsonValue.Null;
                        }
                        return o;
                    }
                case SerializedPropertyType.Bounds:
                    {
                        Bounds b = prop.boundsValue;
                        var o = JsonValue.NewObject();
                        o["center"] = Vec(b.center.x, b.center.y, b.center.z, null);
                        o["size"] = Vec(b.size.x, b.size.y, b.size.z, null);
                        return o;
                    }
                case SerializedPropertyType.Rect:
                    {
                        Rect r = prop.rectValue;
                        var o = JsonValue.NewObject();
                        o["x"] = r.x; o["y"] = r.y; o["width"] = r.width; o["height"] = r.height;
                        return o;
                    }
                default:
                    // Arrays/generic/composite: emit a bounded summary.
                    if (prop.isArray && prop.propertyType != SerializedPropertyType.String)
                        return SerializeArray(prop);
                    // Unknown/unsupported scalar — emit its type name as a hint.
                    return JsonValue.Of("<" + prop.propertyType + ">");
            }
        }

        private static JsonValue SerializeArray(SerializedProperty arrayProp)
        {
            var o = JsonValue.NewObject();
            int size = arrayProp.arraySize;
            o["length"] = size;
            var items = JsonValue.NewArray();
            int take = Math.Min(size, MaxArrayElements);
            for (int i = 0; i < take; i++)
            {
                SerializedProperty el = arrayProp.GetArrayElementAtIndex(i);
                items.Add(SerializePropertyValue(el));
            }
            o["items"] = items;
            if (size > take) o["truncated"] = true;
            return o;
        }

        private static JsonValue Vec(float x, float y, float? z, float? w)
        {
            var o = JsonValue.NewObject();
            o["x"] = x; o["y"] = y;
            if (z.HasValue) o["z"] = z.Value;
            if (w.HasValue) o["w"] = w.Value;
            return o;
        }

        private static string Truncate(string s)
        {
            if (s == null) return "";
            return s.Length > MaxStringValueLength ? s.Substring(0, MaxStringValueLength) : s;
        }

        // ── findReferencesToScript ───────────────────────────────────────────

        private static JsonValue FindReferencesToScript(JsonValue p)
        {
            string guid = p["guid"].AsString;
            var gameObjects = JsonValue.NewArray();
            var result = JsonValue.NewObject();
            result["gameObjects"] = gameObjects;
            if (string.IsNullOrEmpty(guid)) return result;

            int sceneCount = SceneManager.sceneCount;
            for (int s = 0; s < sceneCount; s++)
            {
                Scene scene = SceneManager.GetSceneAt(s);
                if (!scene.IsValid() || !scene.isLoaded) continue;
                foreach (var root in scene.GetRootGameObjects())
                {
                    ScanForScript(root.transform, scene.name, guid, gameObjects);
                }
            }
            return result;
        }

        private static void ScanForScript(Transform t, string sceneName, string guid, JsonValue outArr)
        {
            GameObject go = t.gameObject;
            foreach (var mb in go.GetComponents<MonoBehaviour>())
            {
                if (mb == null) continue; // missing script
                MonoScript ms = MonoScript.FromMonoBehaviour(mb);
                if (ms == null) continue;
                // Map the MonoScript asset to its guid and compare.
                if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(ms, out string scriptGuid, out long _)
                    && string.Equals(scriptGuid, guid, StringComparison.OrdinalIgnoreCase))
                {
                    var entry = JsonValue.NewObject();
                    entry["scene"] = sceneName ?? "";
                    entry["path"] = HierarchyPath(go.transform);
                    entry["instanceId"] = go.GetInstanceID();
                    outArr.Add(entry);
                    break; // one hit per GameObject is enough
                }
            }

            for (int i = 0; i < t.childCount; i++)
                ScanForScript(t.GetChild(i), sceneName, guid, outArr);
        }

        private static string HierarchyPath(Transform t)
        {
            string path = t.name;
            Transform cur = t.parent;
            while (cur != null)
            {
                path = cur.name + "/" + path;
                cur = cur.parent;
            }
            return path;
        }

        // ── hierarchy_changed push (debounced) ───────────────────────────────

        private static void InstallHierarchyHook()
        {
            if (_hierarchyHookInstalled) return;
            _hierarchyHookInstalled = true;
            EditorApplication.hierarchyChanged += OnHierarchyChanged;
        }

        public static void UninstallHierarchyHook()
        {
            if (!_hierarchyHookInstalled) return;
            _hierarchyHookInstalled = false;
            EditorApplication.hierarchyChanged -= OnHierarchyChanged;
            _hierarchyDirtyAt = -1;
        }

        private static void OnHierarchyChanged()
        {
            // Mark dirty; the actual send is debounced in Tick() (main thread).
            _hierarchyDirtyAt = Protocol.NowUnixSeconds();
        }

        /// <summary>Main-thread pump hook: emits the debounced hierarchy_changed.</summary>
        public static void Tick()
        {
            if (_hierarchyDirtyAt < 0 || _client == null) return;
            if (Protocol.NowUnixSeconds() - _hierarchyDirtyAt < HierarchyDebounceSeconds) return;
            _hierarchyDirtyAt = -1;
            _client.Send(Protocol.Envelope(MsgType.HierarchyChanged, JsonValue.NewObject()));
        }
    }
}
