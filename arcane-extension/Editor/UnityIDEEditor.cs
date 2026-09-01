using System;
using System.Collections.Generic;
using Unity.CodeEditor;
using UnityEditor;
using UnityEngine;

namespace UnityIDE.Editor
{
    /// <summary>
    /// Registers UnityIDE as an external code editor in Unity.
    /// Implements IExternalCodeEditor to appear in Edit > Preferences > External Tools,
    /// open scripts in UnityIDE on double-click, and keep .sln/.csproj files generated.
    ///
    /// Finding and launching the app lives in <see cref="UnityIDELauncher"/>, not
    /// here: the same job is needed by the Window > UnityIDE menu items, which
    /// have to work whether or not UnityIDE is the configured script editor.
    ///
    /// Live IPC with the running IDE (console/play/hierarchy/telemetry) is owned by the
    /// UnityIDE.Bridge package (see BridgeBootstrap).
    /// </summary>
    [InitializeOnLoad]
    public class UnityIDEEditor : IExternalCodeEditor
    {
        /// <summary>
        /// The app's name before the rename, or empty for a channel that never
        /// had one. Kept only so an already-installed build is still
        /// recognised; nothing new is ever written under it.
        /// </summary>
        private const string LegacyAppName = UnityIDEChannel.LegacyAppName;

        /// <summary>
        /// The application this build of the package talks to. Everything user
        /// visible is named after it, so the dev-channel package says "UnityIDE
        /// Dev" everywhere the release one says "UnityIDE".
        /// </summary>
        private const string AppName = UnityIDEChannel.DisplayName;

        static UnityIDEEditor()
        {
            CodeEditor.Register(new UnityIDEEditor());
        }

        public CodeEditor.Installation[] Installations
        {
            get
            {
                var installations = new List<CodeEditor.Installation>();
                foreach (var found in UnityIDELauncher.Installations())
                {
                    installations.Add(new CodeEditor.Installation
                    {
                        Name = found.Name,
                        Path = found.Path,
                    });
                }

                // Always provide at least one entry, so the dropdown says what
                // to do rather than simply omitting us.
                if (installations.Count == 0)
                {
                    installations.Add(new CodeEditor.Installation
                    {
                        Name = AppName + " (configure path in preferences)",
                        Path = "",
                    });
                }

                return installations.ToArray();
            }
        }

        public bool TryGetInstallationForPath(string editorPath, out CodeEditor.Installation installation)
        {
            // Check if the given path matches any known UnityIDE installation
            foreach (var inst in Installations)
            {
                if (inst.Path == editorPath)
                {
                    installation = inst;
                    return true;
                }
            }

            // Accept any path that looks like a UnityIDE executable, under either
            // the current or the pre-rename name — a user whose External Script
            // Editor still points at the old app should keep working until they
            // reinstall, not silently lose their editor association.
            if (!string.IsNullOrEmpty(editorPath) &&
                (editorPath.IndexOf(AppName, StringComparison.OrdinalIgnoreCase) >= 0 ||
                 (!string.IsNullOrEmpty(LegacyAppName) &&
                  editorPath.IndexOf(LegacyAppName, StringComparison.OrdinalIgnoreCase) >= 0)))
            {
                installation = new CodeEditor.Installation
                {
                    Name = AppName,
                    Path = editorPath
                };
                return true;
            }

            installation = default(CodeEditor.Installation);
            return false;
        }

        public void Initialize(string editorInstallation)
        {
            UnityIDELauncher.SelectedInstallation = editorInstallation;

            // Generate project files when UnityIDE is selected as the external editor.
            // Deferred, not immediate: Unity calls this from CodeEditor.Register in
            // our InitializeOnLoad static constructor, which is too early for the
            // IDE package's generator to run. See UnityIDEProjectGeneration.ScheduleSync.
            UnityIDEProjectGeneration.ScheduleSync();
        }

        private static bool HasScriptChanges(string[] assets)
        {
            if (assets == null) return false;
            foreach (var asset in assets)
            {
                if (asset.EndsWith(".cs") || asset.EndsWith(".asmdef") || asset.EndsWith(".asmref"))
                    return true;
            }
            return false;
        }

        /// <summary>
        /// Unity asking us to open something. Two callers, and the difference
        /// between them is the whole reason this used to half-work:
        ///
        ///  * Double-clicking a script passes a file, a line and a column.
        ///  * `Assets > Open C# Project` passes an empty path — "just open the
        ///    project". That produced a bare `UnityIDE "&lt;project&gt;"`, which
        ///    the app's argv parser ignored entirely, so the menu item did
        ///    nothing but raise a Welcome window.
        ///
        /// Both are now one call.
        /// </summary>
        public bool OpenProject(string filePath, int line, int column)
        {
            return UnityIDELauncher.Open(filePath, line, column);
        }

        public void SyncAll()
        {
            // Generate .sln/.csproj files via the installed IDE package (reflection).
            UnityIDEProjectGeneration.ScheduleSync();
        }

        public void SyncIfNeeded(string[] addedAssets, string[] deletedAssets, string[] movedAssets,
            string[] movedFromAssetPaths, string[] importedAssets)
        {
            // Regenerate .csproj files when scripts or assembly definitions change
            if (HasScriptChanges(addedAssets) || HasScriptChanges(deletedAssets)
                || HasScriptChanges(movedAssets) || HasScriptChanges(importedAssets))
            {
                // Deferred + coalesced: a single import can call this many times,
                // and each Sync regenerates every .csproj in the project.
                UnityIDEProjectGeneration.ScheduleSync();
            }
        }

        /// <summary>
        /// Drawn by Unity inside Preferences > External Tools.
        ///
        /// This doubles as the diagnostic surface. Everything that can go wrong
        /// with "open my project in UnityIDE" is invisible otherwise — the app
        /// not installed, installed but never launched so it has left no record
        /// of itself, or running but not connected to this project.
        /// </summary>
        public void OnGUI()
        {
            EditorGUILayout.LabelField(AppName, EditorStyles.boldLabel);

            string resolved = UnityIDELauncher.ResolveInstallation();
            EditorGUILayout.LabelField(
                "Installation",
                string.IsNullOrEmpty(resolved) ? "not found" : resolved);
            EditorGUILayout.LabelField(
                "Unity bridge",
                Bridge.BridgeBootstrap.IsConnected
                    ? "connected — this project is open in " + AppName
                    : "not connected");

            EditorGUILayout.Space();

            // Install Path override
            EditorGUILayout.BeginHorizontal();
            string installPath = EditorGUILayout.TextField("Install Path", UnityIDESettings.InstallPath);
            if (installPath != UnityIDESettings.InstallPath)
                UnityIDESettings.InstallPath = installPath;
            if (GUILayout.Button("Browse", GUILayout.Width(60)))
            {
                string selected = EditorUtility.OpenFilePanel("Select " + AppName, "", "");
                if (!string.IsNullOrEmpty(selected))
                    UnityIDESettings.InstallPath = selected;
            }
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();

            EditorGUILayout.BeginHorizontal();
            using (new EditorGUI.DisabledScope(string.IsNullOrEmpty(resolved)))
            {
                if (GUILayout.Button("Open Project in " + AppName))
                    UnityIDEMenu.OpenProject();
            }
            if (string.IsNullOrEmpty(resolved) && GUILayout.Button("Download " + AppName))
                Application.OpenURL(UnityIDELauncher.DownloadUrl);
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();
            EditorGUILayout.HelpBox(
                "Live connection to " + AppName + " (console, play mode, hierarchy) " +
                "is managed automatically by the bridge while the IDE is running.",
                MessageType.Info);
        }
    }
}
