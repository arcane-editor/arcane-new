using System;
using System.Diagnostics;
using System.IO;
using Unity.CodeEditor;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace UnityIDE.Editor
{
    /// <summary>
    /// Registers UnityIDE as an external code editor in Unity.
    /// Implements IExternalCodeEditor to appear in Edit > Preferences > External Tools,
    /// open scripts in UnityIDE on double-click, and keep .sln/.csproj files generated.
    ///
    /// Live IPC with the running IDE (console/play/hierarchy/telemetry) is owned by the
    /// UnityIDE.Bridge package (see BridgeBootstrap); this class only handles the
    /// Unity-initiated external-editor responsibilities and launches UnityIDE on demand.
    /// </summary>
    [InitializeOnLoad]
    public class UnityIDEEditor : IExternalCodeEditor
    {
        /// <summary>
        /// The app's name before the rename. Kept only so an already-installed
        /// build is still found; nothing new is ever written under it.
        /// </summary>
        private const string LegacyAppName = "UnityIDE";

        // Each table lists the new-name locations first, then the pre-rename
        // ones. The extension and the IDE ship separately — a user can update
        // the Unity package before reinstalling the app — so probing only the
        // new paths would report "no installation found" on a machine where
        // the IDE is sitting right there under its old name. The legacy
        // entries cost one File.Exists each and can go once the old app has.
        private static readonly string[] MacPaths = {
            "/Applications/UnityIDE.app",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal), "Applications/UnityIDE.app"),
            "/Applications/" + LegacyAppName + ".app",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal), "Applications/" + LegacyAppName + ".app")
        };

        private static readonly string[] WindowsPaths = {
            @"C:\Program Files\UnityIDE\UnityIDE.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\UnityIDE\UnityIDE.exe"),
            @"C:\Program Files\" + LegacyAppName + @"\" + LegacyAppName + ".exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\" + LegacyAppName + @"\" + LegacyAppName + ".exe")
        };

        private static readonly string[] LinuxPaths = {
            "/usr/bin/unityide",
            "/usr/local/bin/unityide",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal), ".local/bin/unityide"),
            "/usr/bin/arcane",
            "/usr/local/bin/arcane",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal), ".local/bin/arcane")
        };

        private string _installPath;

        static UnityIDEEditor()
        {
            CodeEditor.Register(new UnityIDEEditor());
        }

        public CodeEditor.Installation[] Installations
        {
            get
            {
                var installations = new System.Collections.Generic.List<CodeEditor.Installation>();

                // 1. Check for dev launcher (.unityide-dev-path file in project root)
                string devConfigPath = Path.Combine(
                    Path.GetDirectoryName(Application.dataPath),
                    ".unityide-dev-path"
                );
                if (File.Exists(devConfigPath))
                {
                    string devLauncher = File.ReadAllText(devConfigPath).Trim();
                    if (File.Exists(devLauncher))
                    {
                        installations.Add(new CodeEditor.Installation
                        {
                            Name = "UnityIDE (Dev)",
                            Path = devLauncher
                        });
                    }
                }

                // 2. Check custom path from EditorPrefs
                string customPath = UnityIDESettings.InstallPath;
                if (!string.IsNullOrEmpty(customPath) && (File.Exists(customPath) || Directory.Exists(customPath)))
                {
                    installations.Add(new CodeEditor.Installation
                    {
                        Name = "UnityIDE",
                        Path = customPath
                    });
                }

                // 3. Search platform-specific paths for packaged app
                string[] paths;
                switch (Application.platform)
                {
                    case RuntimePlatform.OSXEditor:
                        paths = MacPaths;
                        break;
                    case RuntimePlatform.WindowsEditor:
                        paths = WindowsPaths;
                        break;
                    case RuntimePlatform.LinuxEditor:
                        paths = LinuxPaths;
                        break;
                    default:
                        paths = Array.Empty<string>();
                        break;
                }

                foreach (string path in paths)
                {
                    if (File.Exists(path) || Directory.Exists(path))
                    {
                        installations.Add(new CodeEditor.Installation
                        {
                            Name = "UnityIDE",
                            Path = path
                        });
                    }
                }

                // Always provide at least one entry
                if (installations.Count == 0)
                {
                    installations.Add(new CodeEditor.Installation
                    {
                        Name = "UnityIDE (configure path in preferences)",
                        Path = ""
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
                (editorPath.IndexOf("UnityIDE", StringComparison.OrdinalIgnoreCase) >= 0 ||
                 editorPath.IndexOf(LegacyAppName, StringComparison.OrdinalIgnoreCase) >= 0))
            {
                installation = new CodeEditor.Installation
                {
                    Name = "UnityIDE",
                    Path = editorPath
                };
                return true;
            }

            installation = default;
            return false;
        }

        public void Initialize(string editorInstallation)
        {
            _installPath = editorInstallation;

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

        public bool OpenProject(string filePath, int line, int column)
        {
            // Launch (or focus) UnityIDE and navigate to the requested location. If UnityIDE
            // is already running, its single-instance lock relays the --goto argument to
            // the existing window; otherwise a new instance opens the project.
            return LaunchIde(filePath, line, column);
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

        public void OnGUI()
        {
            EditorGUILayout.LabelField("UnityIDE Settings", EditorStyles.boldLabel);

            // Install Path
            EditorGUILayout.BeginHorizontal();
            string installPath = EditorGUILayout.TextField("Install Path", UnityIDESettings.InstallPath);
            if (installPath != UnityIDESettings.InstallPath)
                UnityIDESettings.InstallPath = installPath;
            if (GUILayout.Button("Browse", GUILayout.Width(60)))
            {
                string selected = EditorUtility.OpenFilePanel("Select UnityIDE Executable", "", "");
                if (!string.IsNullOrEmpty(selected))
                    UnityIDESettings.InstallPath = selected;
            }
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();
            EditorGUILayout.HelpBox(
                "Live connection to the UnityIDE (console, play mode, hierarchy) is " +
                "managed automatically by the UnityIDE bridge while the IDE is running.",
                MessageType.Info);
        }

        private bool LaunchIde(string filePath, int line, int column)
        {
            string execPath = !string.IsNullOrEmpty(_installPath) ? _installPath : UnityIDESettings.InstallPath;

            if (string.IsNullOrEmpty(execPath))
            {
                UnityIDELog.Warn("No UnityIDE installation path configured. Please set the path in Preferences > External Tools.");
                return false;
            }

            try
            {
                string projectPath = Path.GetDirectoryName(Application.dataPath);
                string args = string.IsNullOrEmpty(filePath)
                    ? $"\"{projectPath}\""
                    : $"--goto \"{filePath}:{line}:{column}\" \"{projectPath}\"";

                // Shell scripts (dev launcher)
                if (execPath.EndsWith(".sh"))
                {
                    var psi = new ProcessStartInfo
                    {
                        FileName = "/bin/bash",
                        Arguments = $"\"{execPath}\" {args}",
                        UseShellExecute = false
                    };
                    Process.Start(psi);
                }
                // On macOS, launch the binary inside .app bundle directly so
                // Electron's single-instance lock works (open -a won't relay args to existing instance)
                else if (Application.platform == RuntimePlatform.OSXEditor && execPath.EndsWith(".app"))
                {
                    string macBinary = Path.Combine(execPath, "Contents", "MacOS", "UnityIDE");
                    if (File.Exists(macBinary))
                    {
                        Process.Start(macBinary, args);
                    }
                    else
                    {
                        Process.Start("open", $"-a \"{execPath}\" --args {args}");
                    }
                }
                else
                {
                    Process.Start(execPath, args);
                }

                return true;
            }
            catch (Exception ex)
            {
                UnityIDELog.Error($"Failed to launch: {ex.Message}");
                return false;
            }
        }
    }
}
