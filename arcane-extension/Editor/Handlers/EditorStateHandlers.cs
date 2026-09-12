// EditorStateHandlers.cs — RPC methods for editor state, selection, asset
// queries and editor-control verbs. Registered into RpcDispatcher; every handler
// body runs on the main thread (the dispatcher guarantees this), so direct Unity
// API access is safe here.
//
// Methods:
//   getEditorState, getSelection, getProjectAssets, refreshAssets,
//   requestCompile, generateSolution, executeMenuItem, openAsset, focusUnity,
//   setExternalScriptEditor
//
// refreshAssets and requestCompile are registered QUEUED (see RpcDispatcher):
// they are commands whose worth is the side effect, and making the caller
// block on a main thread that Unity has parked is what turned "the AI wrote a
// file" into an 8s RPC timeout. They report real completion with
// `refresh_completed` instead.
//
// Also installs the Selection.selectionChanged hook to push `selection_changed`.

using System;
using System.Reflection;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace UnityIDE.Bridge
{
    internal static class EditorStateHandlers
    {
        // EditorPrefs key Unity uses for the external script editor path.
        private const string ScriptEditorPrefKey = "kScriptsDefaultApp";

        /// <summary>Shared coalescing key for the two import-triggering commands.</summary>
        private const string AssetRefreshKey = "assetRefresh";

        /// <summary>
        /// How long to hold the editor awake after an import, so a compile the
        /// importer scheduled actually gets to START. Unity does not begin
        /// compiling inside Refresh(); it schedules the work for a later tick,
        /// and a backgrounded editor has no later tick unless we supply one.
        /// CompilationHook extends this once the compile is under way.
        /// </summary>
        private const int PostImportWakeMs = 20000;

        private static BridgeClient _client;
        private static bool _selectionHookInstalled;

        public static void Register(BridgeClient client)
        {
            _client = client;

            RpcDispatcher.Register("getEditorState", GetEditorState);
            RpcDispatcher.Register("getSelection", GetSelection);
            RpcDispatcher.Register("getProjectAssets", GetProjectAssets);
            // Both end in an AssetDatabase import, so they share a coalescing
            // key: an agent writing ten scripts queues one refresh, not ten.
            RpcDispatcher.RegisterQueued("refreshAssets", RefreshAssets, AssetRefreshKey);
            RpcDispatcher.RegisterQueued("requestCompile", RequestCompile, AssetRefreshKey);
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

        // ── refreshAssets / requestCompile (both QUEUED) ─────────────────────

        private static JsonValue RefreshAssets(JsonValue p)
        {
            AssetDatabase.Refresh();
            MainThreadDispatcher.RequestWake(PostImportWakeMs);
            AnnounceRefreshCompleted(false);
            return Ok();
        }

        /// <summary>
        /// Import changed assets and, optionally, force a script compile.
        ///
        /// The plain import is the right default: if a .cs file really changed,
        /// Unity schedules the compile itself, and if it did not, there is
        /// genuinely nothing to build — which is a real answer the IDE knows how
        /// to report. `force` exists for the case where the importer did not
        /// notice; it is not the default because RequestScriptCompilation()
        /// recompiles and reloads the domain unconditionally, and paying that on
        /// every agent write would be worse than the problem being fixed.
        /// </summary>
        private static JsonValue RequestCompile(JsonValue p)
        {
            AssetDatabase.Refresh();

            bool force = p != null && p["force"] != null && p["force"].AsBool;
            if (force) CompilationPipeline.RequestScriptCompilation();

            MainThreadDispatcher.RequestWake(PostImportWakeMs);
            AnnounceRefreshCompleted(force);
            return Ok();
        }

        /// <summary>
        /// Tell the IDE the queued import actually ran. Runs on the main thread
        /// (the dispatcher guarantees it), and Send only queues, so this is safe
        /// even though a compile-triggered domain reload may be moments away.
        ///
        /// `compiling` is the part that keeps the IDE honest. Without it, the
        /// IDE can only infer "nothing needed compiling" from silence, and
        /// silence is also what a scheduled-but-not-yet-started compile looks
        /// like on a backgrounded editor — so it would report a clean no-op
        /// compile for a file that is about to fail to build. This is positive
        /// evidence that a compile is already in flight. It is not a complete
        /// answer on its own (Unity often schedules the compile for a later
        /// tick, and this reads false then), which is why the IDE also refuses
        /// to conclude anything while the editor is parked.
        /// </summary>
        private static void AnnounceRefreshCompleted(bool compileRequested)
        {
            if (_client == null) return;
            var payload = JsonValue.NewObject();
            payload["compileRequested"] = compileRequested;
            // A forced request compiles unconditionally, so it counts as in
            // flight even before Unity flips isCompiling.
            payload["compiling"] = compileRequested || EditorApplication.isCompiling;
            _client.Send(Protocol.Envelope(MsgType.RefreshCompleted, payload));
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
