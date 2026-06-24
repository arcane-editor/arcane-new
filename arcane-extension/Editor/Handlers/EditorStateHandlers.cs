// EditorStateHandlers.cs — RPC methods for editor state, selection, asset
// queries and editor-control verbs. Registered into RpcDispatcher; every handler
// body runs on the main thread (the dispatcher guarantees this), so direct Unity
// API access is safe here.
//
// Methods:
//   getEditorState, getSelection, getProjectAssets, refreshAssets,
//   generateSolution, executeMenuItem, openAsset, focusUnity,
//   setExternalScriptEditor
//
// Also installs the Selection.selectionChanged hook to push `selection_changed`.

using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Arcane.Bridge
{
    internal static class EditorStateHandlers
    {
        // EditorPrefs key Unity uses for the external script editor path.
        private const string ScriptEditorPrefKey = "kScriptsDefaultApp";

        private static BridgeClient _client;
        private static bool _selectionHookInstalled;

        public static void Register(BridgeClient client)
        {
            _client = client;

            RpcDispatcher.Register("getEditorState", GetEditorState);
            RpcDispatcher.Register("getSelection", GetSelection);
            RpcDispatcher.Register("getProjectAssets", GetProjectAssets);
            RpcDispatcher.Register("refreshAssets", RefreshAssets);
            RpcDispatcher.Register("generateSolution", GenerateSolution);
            RpcDispatcher.Register("executeMenuItem", ExecuteMenuItem);
            RpcDispatcher.Register("openAsset", OpenAsset);
            RpcDispatcher.Register("focusUnity", FocusUnity);
            RpcDispatcher.Register("setExternalScriptEditor", SetExternalScriptEditor);

            InstallSelectionHook();
        }

        // ── getEditorState ───────────────────────────────────────────────────

        private static JsonValue GetEditorState(JsonValue p)
        {
            var result = JsonValue.NewObject();
            result["isPlaying"] = EditorApplication.isPlaying;
            result["isPaused"] = EditorApplication.isPaused;
            result["isCompiling"] = EditorApplication.isCompiling;
            result["unityVersion"] = Application.unityVersion;

            var scenes = JsonValue.NewArray();
            int count = SceneManager.sceneCount;
            for (int i = 0; i < count; i++)
            {
                Scene s = SceneManager.GetSceneAt(i);
                if (s.IsValid() && s.isLoaded) scenes.Add(s.name ?? "");
            }
            result["activeScenes"] = scenes;
            return result;
        }

        // ── getSelection ─────────────────────────────────────────────────────

        private static JsonValue GetSelection(JsonValue p) => BuildSelectionSummary();

        private static JsonValue BuildSelectionSummary()
        {
            var objects = JsonValue.NewArray();
            foreach (var obj in Selection.objects)
            {
                if (obj == null) continue;
                var o = JsonValue.NewObject();
                o["name"] = obj.name ?? "";
                o["instanceId"] = obj.GetInstanceID();
                o["type"] = obj.GetType().Name;

                // Hierarchy path for GameObjects; asset path otherwise.
                string path = "";
                if (obj is GameObject go) path = HierarchyPath(go.transform);
                else
                {
                    string ap = AssetDatabase.GetAssetPath(obj);
                    if (!string.IsNullOrEmpty(ap)) path = ap;
                }
                o["path"] = path;
                objects.Add(o);
            }
            var result = JsonValue.NewObject();
            result["objects"] = objects;
            return result;
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

        // ── getProjectAssets ─────────────────────────────────────────────────

        private static JsonValue GetProjectAssets(JsonValue p)
        {
            string query = p["query"].AsStringOr("");
            string type = p["type"].AsString; // optional

            // AssetDatabase.FindAssets filter: "<query> t:<type>".
            string filter = query ?? "";
            if (!string.IsNullOrEmpty(type)) filter += " t:" + type;

            var assets = JsonValue.NewArray();
            string[] guids = AssetDatabase.FindAssets(filter.Trim());
            // Cap the result set so an empty query (which matches everything)
            // cannot produce a multi-megabyte reply.
            const int MaxResults = 500;
            int n = Math.Min(guids.Length, MaxResults);
            for (int i = 0; i < n; i++)
            {
                string guid = guids[i];
                string path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path)) continue;

                var a = JsonValue.NewObject();
                a["name"] = System.IO.Path.GetFileNameWithoutExtension(path);
                a["path"] = path;
                a["guid"] = guid;
                Type mainType = AssetDatabase.GetMainAssetTypeAtPath(path);
                a["type"] = mainType != null ? mainType.Name : "";
                assets.Add(a);
            }

            var result = JsonValue.NewObject();
            result["assets"] = assets;
            return result;
        }

        // ── refreshAssets ────────────────────────────────────────────────────

        private static JsonValue RefreshAssets(JsonValue p)
        {
            AssetDatabase.Refresh();
            return Ok();
        }

        // ── generateSolution ─────────────────────────────────────────────────

        private static JsonValue GenerateSolution(JsonValue p)
        {
            // Preferred path: Unity.CodeEditor.CodeEditor.CurrentEditor.SyncAll()
            // via reflection (the package may or may not expose it; avoid a hard
            // assembly reference). Fall back to UnityEditor.SyncVS.SyncSolution.
            if (TryReflectSyncAll()) return Ok();
            if (TryReflectSyncVs()) return Ok();

            // Last resort: force an asset refresh which regenerates project files
            // in most setups.
            AssetDatabase.Refresh();
            return Ok();
        }

        private static bool TryReflectSyncAll()
        {
            try
            {
                // Unity.CodeEditor.CodeEditor lives in Unity.CodeEditor assembly.
                Type codeEditor = Type.GetType("Unity.CodeEditor.CodeEditor, Unity.CodeEditor");
                if (codeEditor == null) return false;
                PropertyInfo currentProp = codeEditor.GetProperty("CurrentEditor",
                    BindingFlags.Public | BindingFlags.Static);
                object current = currentProp?.GetValue(null);
                if (current == null) return false;
                MethodInfo syncAll = current.GetType().GetMethod("SyncAll");
                if (syncAll == null) return false;
                syncAll.Invoke(current, null);
                return true;
            }
            catch { return false; }
        }

        private static bool TryReflectSyncVs()
        {
            try
            {
                // Internal: UnityEditor.SyncVS.SyncSolution() (older Unity).
                Type syncVs = Type.GetType("UnityEditor.SyncVS, UnityEditor");
                MethodInfo sync = syncVs?.GetMethod("SyncSolution",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                if (sync == null) return false;
                sync.Invoke(null, null);
                return true;
            }
            catch { return false; }
        }

        // ── executeMenuItem ──────────────────────────────────────────────────

        private static JsonValue ExecuteMenuItem(JsonValue p)
        {
            string path = p["path"].AsString;
            bool ok = false;
            if (!string.IsNullOrEmpty(path))
                ok = EditorApplication.ExecuteMenuItem(path);
            var result = JsonValue.NewObject();
            result["ok"] = ok;
            return result;
        }

        // ── openAsset ────────────────────────────────────────────────────────

        private static JsonValue OpenAsset(JsonValue p)
        {
            string path = p["path"].AsString;
            if (string.IsNullOrEmpty(path))
            {
                string guid = p["guid"].AsString;
                if (!string.IsNullOrEmpty(guid))
                    path = AssetDatabase.GUIDToAssetPath(guid);
            }
            if (!string.IsNullOrEmpty(path))
            {
                var obj = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path);
                if (obj != null) AssetDatabase.OpenAsset(obj);
            }
            return Ok();
        }

        // ── focusUnity ───────────────────────────────────────────────────────

        private static JsonValue FocusUnity(JsonValue p)
        {
            // Best-effort: repaint all views and focus the game/scene view if open.
            try
            {
                UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
                var focused = EditorWindow.focusedWindow;
                if (focused != null) focused.Focus();
            }
            catch { /* best-effort */ }
            return Ok();
        }

        // ── setExternalScriptEditor ──────────────────────────────────────────

        private static JsonValue SetExternalScriptEditor(JsonValue p)
        {
            string path = p["path"].AsString;
            if (!string.IsNullOrEmpty(path))
            {
                EditorPrefs.SetString(ScriptEditorPrefKey, path);
                TryReflectSetExternalEditor(path);
            }
            return Ok();
        }

        private static void TryReflectSetExternalEditor(string path)
        {
            try
            {
                Type codeEditor = Type.GetType("Unity.CodeEditor.CodeEditor, Unity.CodeEditor");
                MethodInfo setter = codeEditor?.GetMethod("SetExternalScriptEditor",
                    BindingFlags.Public | BindingFlags.Static);
                setter?.Invoke(null, new object[] { path });
            }
            catch { /* the EditorPrefs write above is the durable fallback */ }
        }

        // ── selection_changed push ───────────────────────────────────────────

        private static void InstallSelectionHook()
        {
            if (_selectionHookInstalled) return;
            _selectionHookInstalled = true;
            Selection.selectionChanged += OnSelectionChanged;
        }

        public static void UninstallSelectionHook()
        {
            if (!_selectionHookInstalled) return;
            _selectionHookInstalled = false;
            Selection.selectionChanged -= OnSelectionChanged;
        }

        private static void OnSelectionChanged()
        {
            // Fires on the main thread; build + send the selection summary.
            if (_client == null) return;
            _client.Send(Protocol.Envelope(MsgType.SelectionChanged, BuildSelectionSummary()));
        }

        // ── helpers ──────────────────────────────────────────────────────────

        private static JsonValue Ok()
        {
            var r = JsonValue.NewObject();
            r["ok"] = true;
            return r;
        }
    }
}
