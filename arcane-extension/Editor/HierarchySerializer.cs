// HierarchySerializer.cs — serialize loaded scenes into a GameObject tree with a
// payload-size cap.
//
// Shape (getSceneHierarchy result):
//   { scenes:[{ name, path, roots: GameObjectNode[] }], truncated: bool }
//   GameObjectNode = { name, active, tag, layer, instanceId,
//                      components:[{ type, ... }], children: GameObjectNode[] }
//
// The serialized payload is capped at ~2 MB. We approximate the cost as we build
// (summing string lengths) rather than serializing-then-measuring, so a huge
// scene can't spike memory. Once the budget is exceeded we stop descending,
// set truncated = true, and return what we have.
//
// MUST run on the main thread (scene + GameObject access). Callers marshal it.

using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Arcane.Bridge
{
    internal static class HierarchySerializer
    {
        // Approximate byte budget for the whole hierarchy payload (~2 MB).
        private const int PayloadByteBudget = 2 * 1024 * 1024;

        /// <summary>
        /// Serialize all loaded scenes. Returns { scenes, truncated }.
        /// </summary>
        public static JsonValue SerializeLoadedScenes()
        {
            var budget = new Budget(PayloadByteBudget);
            var scenes = JsonValue.NewArray();

            int count = SceneManager.sceneCount;
            for (int i = 0; i < count; i++)
            {
                Scene scene = SceneManager.GetSceneAt(i);
                if (!scene.IsValid() || !scene.isLoaded) continue;

                var sceneObj = JsonValue.NewObject();
                sceneObj["name"] = scene.name ?? "";
                sceneObj["path"] = scene.path ?? "";

                var roots = JsonValue.NewArray();
                if (!budget.Exceeded)
                {
                    foreach (var go in scene.GetRootGameObjects())
                    {
                        if (budget.Exceeded) break;
                        roots.Add(SerializeGameObject(go, budget));
                    }
                }
                sceneObj["roots"] = roots;
                scenes.Add(sceneObj);

                if (budget.Exceeded) break;
            }

            var result = JsonValue.NewObject();
            result["scenes"] = scenes;
            result["truncated"] = budget.Exceeded;
            return result;
        }

        /// <summary>
        /// Serialize a single GameObject node (name/active/tag/layer/instanceId +
        /// shallow component type list + recursive children). Stops adding children
        /// when the budget is exhausted.
        /// </summary>
        public static JsonValue SerializeGameObject(GameObject go, Budget budget)
        {
            var node = JsonValue.NewObject();
            node["name"] = go.name ?? "";
            node["active"] = go.activeSelf;
            node["tag"] = SafeTag(go);
            node["layer"] = go.layer;
            node["instanceId"] = go.GetInstanceID();

            budget.Add(go.name);

            // Shallow component list: type name, plus asset identity for the
            // ones that are project scripts (the deep property dump lives in
            // getGameObject). Missing scripts surface as MissingComponent.
            //
            // Resolving the script here is what lets the IDE tell a user's
            // PlayerController from Unity's Rigidbody. Without it the frontend
            // only received a bare type NAME and had to guess by fuzzy-searching
            // for "<TypeName>.cs" — which silently found nothing for every
            // built-in component, and broke for any script whose file name does
            // not match its class.
            var components = JsonValue.NewArray();
            var comps = go.GetComponents<Component>();
            foreach (var c in comps)
            {
                var compObj = JsonValue.NewObject();
                if (c == null)
                {
                    // A missing MonoBehaviour script reference.
                    compObj["type"] = "MissingComponent";
                }
                else
                {
                    string typeName = c.GetType().Name;
                    compObj["type"] = typeName;
                    budget.Add(typeName);
                    AddScriptIdentity(c, compObj, budget);
                }
                components.Add(compObj);
            }
            node["components"] = components;

            var children = JsonValue.NewArray();
            Transform t = go.transform;
            int childCount = t.childCount;
            for (int i = 0; i < childCount; i++)
            {
                if (budget.Exceeded) break;
                children.Add(SerializeGameObject(t.GetChild(i).gameObject, budget));
            }
            node["children"] = children;

            return node;
        }


        /// <summary>
        /// Attach `script: { path, guid }` when this component is a MonoBehaviour
        /// whose source lives under `Assets/`.
        /// </summary>
        /// <remarks>
        /// Unity requires a MonoBehaviour's file name to equal its class name,
        /// but that is not enough to locate it: two assemblies can define the
        /// same class name, a package can ship a script with the same name as a
        /// project one, and the fuzzy filename search this replaces could not
        /// distinguish any of them. MonoScript.FromMonoBehaviour is exact.
        ///
        /// Restricted to `Assets/`: package and built-in scripts are read-only
        /// to the user, so offering to open them in the editor is a dead end.
        /// </remarks>
        private static void AddScriptIdentity(Component c, JsonValue compObj, Budget budget)
        {
            var mb = c as MonoBehaviour;
            if (mb == null) return;

            MonoScript ms;
            try { ms = MonoScript.FromMonoBehaviour(mb); }
            catch { return; }
            if (ms == null) return;

            string path = AssetDatabase.GetAssetPath(ms);
            if (string.IsNullOrEmpty(path)) return;
            // `Assets/` only — case-sensitively, since Unity always emits this
            // prefix exactly and a looser check would admit `AssetsFoo/`.
            if (!path.StartsWith("Assets/", StringComparison.Ordinal)) return;

            var script = JsonValue.NewObject();
            script["path"] = path;
            script["guid"] = AssetDatabase.AssetPathToGUID(path) ?? "";
            compObj["script"] = script;
            budget.Add(path);
        }

        private static string SafeTag(GameObject go)
        {
            // Untagged GameObjects can throw on .tag in rare states; guard it.
            try { return go.tag; }
            catch { return "Untagged"; }
        }

        /// <summary>Running byte estimate against a fixed budget.</summary>
        internal sealed class Budget
        {
            private int _used;
            private readonly int _max;
            public Budget(int max) { _max = max; }
            public bool Exceeded => _used >= _max;
            public void Add(string s)
            {
                // ~2 bytes/char plus JSON punctuation overhead per field; the exact
                // factor doesn't matter, only that it monotonically tracks growth.
                _used += (s != null ? s.Length * 2 : 0) + 24;
            }
            public void AddBytes(int n) { _used += n; }
        }
    }
}
