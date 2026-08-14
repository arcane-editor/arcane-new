using System;
using System.Diagnostics;
using System.IO;
using Unity.CodeEditor;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

namespace Arcane.Editor
{
    /// <summary>
    /// Registers Arcane as an external code editor in Unity.
    /// Implements IExternalCodeEditor to appear in Edit > Preferences > External Tools,
    /// open scripts in Arcane on double-click, and keep .sln/.csproj files generated.
    ///
    /// Live IPC with the running IDE (console/play/hierarchy/telemetry) is owned by the
    /// Arcane.Bridge package (see BridgeBootstrap); this class only handles the
    /// Unity-initiated external-editor responsibilities and launches Arcane on demand.
    /// </summary>
    [InitializeOnLoad]
    public class ArcaneEditor : IExternalCodeEditor
    {
        private static readonly string[] MacPaths = {
            "/Applications/Arcane.app",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal), "Applications/Arcane.app")
        };

        private static readonly string[] WindowsPaths = {
            @"C:\Program Files\Arcane\Arcane.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Arcane\Arcane.exe")
        };

        private static readonly string[] LinuxPaths = {
            "/usr/bin/arcane",
            "/usr/local/bin/arcane",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Personal), ".local/bin/arcane")
        };

        private string _installPath;

        static ArcaneEditor()
        {
            CodeEditor.Register(new ArcaneEditor());
        }

        public CodeEditor.Installation[] Installations
        {
            get
            {
                var installations = new System.Collections.Generic.List<CodeEditor.Installation>();

                // 1. Check for dev launcher (.arcane-dev-path file in project root)
                string devConfigPath = Path.Combine(
                    Path.GetDirectoryName(Application.dataPath),
                    ".arcane-dev-path"
                );
                if (File.Exists(devConfigPath))
                {
                    string devLauncher = File.ReadAllText(devConfigPath).Trim();
                    if (File.Exists(devLauncher))
                    {
                        installations.Add(new CodeEditor.Installation
                        {
                            Name = "Arcane (Dev)",
                            Path = devLauncher
                        });
                    }
                }

                // 2. Check custom path from EditorPrefs
                string customPath = ArcaneSettings.InstallPath;
                if (!string.IsNullOrEmpty(customPath) && (File.Exists(customPath) || Directory.Exists(customPath)))
                {
                    installations.Add(new CodeEditor.Installation
                    {
                        Name = "Arcane",
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
                            Name = "Arcane",
                            Path = path
                        });
                    }
                }

                // Always provide at least one entry
                if (installations.Count == 0)
                {
                    installations.Add(new CodeEditor.Installation
                    {
                        Name = "Arcane (configure path in preferences)",
                        Path = ""
                    });
                }

                return installations.ToArray();
            }
        }

        public bool TryGetInstallationForPath(string editorPath, out CodeEditor.Installation installation)
        {
            // Check if the given path matches any known Arcane installation
            foreach (var inst in Installations)
            {
                if (inst.Path == editorPath)
                {
                    installation = inst;
                    return true;
                }
            }

            // Accept any path that looks like an Arcane executable
            if (!string.IsNullOrEmpty(editorPath) &&
                (editorPath.Contains("Arcane") || editorPath.Contains("arcane")))
            {
                installation = new CodeEditor.Installation
                {
                    Name = "Arcane",
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

            // Generate project files when Arcane is selected as the external editor.
            // Deferred, not immediate: Unity calls this from CodeEditor.Register in
            // our InitializeOnLoad static constructor, which is too early for the
            // IDE package's generator to run. See ArcaneProjectGeneration.ScheduleSync.
            ArcaneProjectGeneration.ScheduleSync();
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
            // Launch (or focus) Arcane and navigate to the requested location. If Arcane
            // is already running, its single-instance lock relays the --goto argument to
            // the existing window; otherwise a new instance opens the project.
            return LaunchArcane(filePath, line, column);
        }

        public void SyncAll()
        {
            // Generate .sln/.csproj files via the installed IDE package (reflection).
            ArcaneProjectGeneration.ScheduleSync();
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
                ArcaneProjectGeneration.ScheduleSync();
            }
        }

        public void OnGUI()
        {
            EditorGUILayout.LabelField("Arcane IDE Settings", EditorStyles.boldLabel);

            // Install Path
            EditorGUILayout.BeginHorizontal();
            string installPath = EditorGUILayout.TextField("Install Path", ArcaneSettings.InstallPath);
            if (installPath != ArcaneSettings.InstallPath)
                ArcaneSettings.InstallPath = installPath;
            if (GUILayout.Button("Browse", GUILayout.Width(60)))
            {
                string selected = EditorUtility.OpenFilePanel("Select Arcane Executable", "", "");
                if (!string.IsNullOrEmpty(selected))
                    ArcaneSettings.InstallPath = selected;
            }
            EditorGUILayout.EndHorizontal();

            EditorGUILayout.Space();
            EditorGUILayout.HelpBox(
                "Live connection to the Arcane IDE (console, play mode, hierarchy) is " +
                "managed automatically by the Arcane bridge while the IDE is running.",
                MessageType.Info);
        }

        private bool LaunchArcane(string filePath, int line, int column)
        {
            string execPath = !string.IsNullOrEmpty(_installPath) ? _installPath : ArcaneSettings.InstallPath;

            if (string.IsNullOrEmpty(execPath))
            {
                ArcaneLog.Warn("No Arcane installation path configured. Please set the path in Preferences > External Tools.");
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
                    string macBinary = Path.Combine(execPath, "Contents", "MacOS", "Arcane");
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
                ArcaneLog.Error($"Failed to launch: {ex.Message}");
                return false;
            }
        }
    }
}
