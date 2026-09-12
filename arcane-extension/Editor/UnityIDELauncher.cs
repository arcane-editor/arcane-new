// UnityIDELauncher.cs — the one place that answers "get this project (and
// maybe this file) in front of me in UnityIDE".
//
// Every entry point funnels here: the menu items, Unity's own
// `Assets > Open C# Project`, and double-clicking a script (which reaches us as
// IExternalCodeEditor.OpenProject). They differ only in whether they name a
// file.
//
//   1. IDE already up on THIS project?
//        -> send it over the bridge journal we already maintain, and ask it to
//           raise itself. No process spawn, no dock bounce, and no dependence
//           on knowing where the app is installed.
//   2. unityide://open?project=...&file=...&line=...&column=...
//        -> hand the URL to the OS, which already knows where the app is and
//           how to bring it forward. This is the route that makes install-path
//           discovery a fallback rather than a requirement.
//   3. Resolve an install path and launch it.
//        -> still needed, and not rarely: `tauri dev` on macOS can never
//           register a scheme (LaunchServices has no runtime API), and on
//           Windows registration happens on the app's FIRST RUN, so an install
//           nobody has opened yet has no handler. The app's single-instance
//           lock relays argv to a running instance over a socket (macOS) or a
//           named pipe (Windows), or cold-starts one.
//
// Nothing here throws. A failure to open is reported and returns false; the
// caller is usually a Unity callback where an exception is expensive.

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using UnityEditor;
using UnityEngine;
using UnityIDE.Bridge;

namespace UnityIDE.Editor
{
    public static class UnityIDELauncher
    {
        /// <summary>
        /// Where to send someone who has the package but not the application.
        ///
        /// The dev channel has its own build and its own download section; a
        /// release link would hand a dev-channel user the wrong installer.
        /// </summary>
        public const string DownloadUrl = UnityIDEChannel.DownloadUrl;

        /// <summary>
        /// The installation Unity has selected in External Tools, as handed to
        /// IExternalCodeEditor.Initialize. Empty when UnityIDE is not the
        /// configured script editor, which is exactly when discovery has to
        /// fall back to everything else.
        /// </summary>
        internal static string SelectedInstallation { get; set; }

        /// <summary>projectRoot for the project this Unity editor has open.</summary>
        public static string ProjectRoot
        {
            get { return Discovery.ProjectRoot(Application.dataPath); }
        }

        /// <summary>
        /// Open the project, optionally at a file position.
        /// </summary>
        /// <param name="filePath">Absolute path to a file, or null/empty for
        /// "just open the project".</param>
        /// <returns>False when nothing could be done; the reason has already
        /// been reported to the console.</returns>
        public static bool Open(string filePath, int line, int column)
        {
            string projectRoot = ProjectRoot;

            if (TrySendOverBridge(filePath, line, column))
                return true;

            if (TryDeepLink(projectRoot, filePath, line, column))
                return true;

            return TryLaunch(projectRoot, filePath, line, column);
        }

        // ── warm path ────────────────────────────────────────────────────────

        private static bool TrySendOverBridge(string filePath, int line, int column)
        {
            if (!BridgeBootstrap.IsConnected) return false;

            // Windows refuses a background process the foreground unless the
            // process that currently owns it says otherwise. Unity owns it right
            // now — the user just clicked in it — so this is exactly the case
            // AllowSetForegroundWindow exists for. Without it the IDE's own
            // SetForegroundWindow is downgraded to a taskbar flash.
            AllowForeground(BridgeBootstrap.IdePid);

            if (!string.IsNullOrEmpty(filePath))
            {
                var payload = JsonValue.NewObject();
                payload["path"] = filePath;
                payload["line"] = Math.Max(1, line);
                payload["column"] = Math.Max(1, column);
                if (!BridgeBootstrap.TrySend(Protocol.Envelope(MsgType.OpenFile, payload)))
                    return false;
            }

            // Sent even for a project-only open: on this path nothing else
            // brings the IDE forward, and "open my project" with the window
            // left behind Unity is not what was asked for.
            BridgeBootstrap.TrySend(
                Protocol.Envelope(MsgType.FocusWindow, JsonValue.NewObject()));
            return true;
        }

        // ── deep link ────────────────────────────────────────────────────────

        /// <summary>
        /// Ask the OS to open the project, by URL rather than by path.
        ///
        /// False means "not attempted, or the OS had no handler" — always a
        /// signal to fall through to launching an executable, never a failure
        /// to report. Nothing here is allowed to throw.
        /// </summary>
        private static bool TryDeepLink(string projectRoot, string filePath, int line, int column)
        {
            var installation = ResolveCandidate();

            // A dev launcher is a specific script the developer pointed us at.
            // Handing the URL to the OS would start whichever build happens to
            // own the scheme instead, which is the opposite of what they asked
            // for.
            if (installation.IsDevLauncher) return false;

            // Not "which application should answer this?" — this build of the
            // package answers to exactly one channel (see UnityIDEChannel), and
            // guessing at runtime is what used to send every dev-channel open
            // to the release app. The only question left is whether the scheme
            // is registered yet.
            //
            // On macOS it always is: the .app bundle declares it in its
            // Info.plist, so LaunchServices knows about it from the moment the
            // app is installed, before it has ever run. Everywhere else
            // registration happens on the app's FIRST RUN
            // (`deep_link().register_all()`), and firing at an unregistered
            // scheme on Windows raises a "you'll need a new app to open this"
            // dialog rather than failing quietly. An install record is proof
            // the app has run, so it is proof the scheme is registered.
            if (!IsMac && !HasInstallRecord) return false;

            string url = BuildDeepLink(UnityIDEChannel.Scheme, projectRoot, filePath, line, column);

            try
            {
                AllowForeground(ASFW_ANY);
                return LaunchUrl(url);
            }
            catch (Exception ex)
            {
                UnityIDELog.Warn("deep link failed, falling back to launching: " + ex.Message);
                return false;
            }
        }

        /// <summary>
        /// `&lt;scheme&gt;://open?project=...&amp;file=...&amp;line=...&amp;column=...`
        ///
        /// Every value is percent-encoded, which is what makes this safe for the
        /// things that break a command line: spaces, `&amp;`, `#`, non-ASCII, and
        /// the backslashes and drive colon of a Windows path.
        /// </summary>
        internal static string BuildDeepLink(
            string scheme, string projectRoot, string filePath, int line, int column)
        {
            var url = new System.Text.StringBuilder();
            url.Append(scheme).Append("://open?project=")
               .Append(Uri.EscapeDataString(TrimTrailingSeparators(projectRoot)));

            if (!string.IsNullOrEmpty(filePath))
            {
                url.Append("&file=").Append(Uri.EscapeDataString(filePath));
                url.Append("&line=").Append(Math.Max(1, line));
                url.Append("&column=").Append(Math.Max(1, column));
            }

            return url.ToString();
        }

        /// <summary>
        /// Hand a URL to the OS. False when it says it has no handler.
        /// </summary>
        private static bool LaunchUrl(string url)
        {
            if (Application.platform == RuntimePlatform.WindowsEditor)
            {
                // ShellExecute, which is the only way to resolve a protocol
                // handler — and which throws Win32Exception when there is none,
                // caught by the caller.
                Process.Start(new ProcessStartInfo
                {
                    FileName = url,
                    UseShellExecute = true,
                });
                return true;
            }

            var psi = new ProcessStartInfo
            {
                FileName = IsMac ? "open" : "xdg-open",
                Arguments = Quote(url),
                UseShellExecute = false,
            };

            var process = Process.Start(psi);
            if (process == null) return false;

            // Both tools exit as soon as the request is handed off — fast on
            // success, immediate on "no handler" — so the exit code is worth
            // the short wait. It is what tells us to fall back instead of
            // leaving the user staring at a Unity editor that did nothing.
            if (!process.WaitForExit(UrlHandoffTimeoutMs))
            {
                // Unexpectedly slow. Assume it is working rather than launch a
                // second copy of the IDE on top of it.
                return true;
            }
            return process.ExitCode == 0;
        }

        /// <summary>
        /// How long to wait for `open`/`xdg-open` to hand the URL off. Generous:
        /// this blocks Unity's main thread, and the real number is milliseconds.
        /// </summary>
        private const int UrlHandoffTimeoutMs = 3000;

        // ── cold path ────────────────────────────────────────────────────────

        private static bool TryLaunch(string projectRoot, string filePath, int line, int column)
        {
            var installation = ResolveInstallation();
            if (installation == null)
            {
                ReportNotInstalled();
                return false;
            }

            string args = BuildArguments(projectRoot, filePath, line, column);

            try
            {
                // Grant foreground rights to whatever we are about to start. The
                // launched process relays its arguments to the already-running
                // instance and exits, so the window that actually needs to come
                // forward belongs to a process we never see. ASFW_ANY covers
                // both, and is scoped to this one call by Windows.
                AllowForeground(ASFW_ANY);
                StartProcess(installation, args);
                return true;
            }
            catch (Exception ex)
            {
                UnityIDELog.Error("failed to launch UnityIDE: " + ex.Message);
                return false;
            }
        }

        /// <summary>
        /// SessionState, so the browser opens at most once per Unity session.
        /// The page is a page — re-opening it on every double-click would stack
        /// tabs on someone who is already looking at it.
        /// </summary>
        private const string DownloadPromptedKey = "UnityIDE.DownloadPagePrompted";

        /// <summary>
        /// The package is installed and the application is not.
        ///
        /// This is the one failure worth being loud about: from inside Unity it
        /// is indistinguishable from the integration being broken. Double-click
        /// a script, nothing happens, and the only trace is a console line the
        /// user is probably not looking at — which is exactly what it used to
        /// do. Send them to the download page instead, once.
        /// </summary>
        private static void ReportNotInstalled()
        {
            UnityIDELog.Error(
                "no " + UnityIDEChannel.DisplayName + " installation found. Set the path in " +
                "Preferences > External Tools, or install it from " + DownloadUrl + ".");

            if (SessionState.GetBool(DownloadPromptedKey, false)) return;
            SessionState.SetBool(DownloadPromptedKey, true);

            try
            {
                Application.OpenURL(DownloadUrl);
            }
            catch (Exception e)
            {
                UnityIDELog.Warn("could not open the download page: " + e.Message);
            }
        }

        private static void StartProcess(string installation, string args)
        {
            // A dev launcher is a shell script, not an executable.
            if (installation.EndsWith(".sh", StringComparison.OrdinalIgnoreCase))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "/bin/bash",
                    Arguments = Quote(installation) + " " + args,
                    UseShellExecute = false,
                });
                return;
            }

            // macOS .app bundle: go through `open`, never the inner binary.
            //
            // `open -n` starts a new instance whose only job is to hand its
            // arguments to the running one over the single-instance socket and
            // exit; with no instance running it becomes the real one. Doing it
            // this way rather than exec'ing Contents/MacOS/<binary> directly is
            // what gets LaunchServices' normal launch — correct Gatekeeper
            // handling, and an app that does not inherit Unity's environment or
            // sit in Unity's process group.
            if (IsMac && installation.EndsWith(".app", StringComparison.OrdinalIgnoreCase))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "open",
                    Arguments = "-n -a " + Quote(installation) + " --args " + args,
                    UseShellExecute = false,
                });
                return;
            }

            Process.Start(new ProcessStartInfo
            {
                FileName = installation,
                Arguments = args,
                UseShellExecute = false,
            });
        }

        // ── argument building ────────────────────────────────────────────────

        /// <summary>
        /// `--goto "<file>:<line>:<col>" "<project>"` for a file, or
        /// `--project "<project>"` for the project alone.
        /// </summary>
        internal static string BuildArguments(string projectRoot, string filePath, int line, int column)
        {
            if (string.IsNullOrEmpty(filePath))
                return "--project " + Quote(projectRoot);

            string target = filePath + ":" + Math.Max(1, line) + ":" + Math.Max(1, column);
            return "--goto " + Quote(target) + " " + Quote(projectRoot);
        }

        /// <summary>
        /// Quote one argument for a command line.
        ///
        /// The trailing-separator trim is not cosmetic. On Windows a backslash
        /// immediately before the closing quote escapes it, so
        /// <c>"C:\Proj\"</c> does not terminate the argument — the project path
        /// swallows every argument after it and the launch opens nothing. Unity
        /// hands back a project root without a trailing separator today, but
        /// this is one character of defence against a class of bug that is
        /// invisible until someone's path ends in one.
        /// </summary>
        internal static string Quote(string value)
        {
            if (string.IsNullOrEmpty(value)) return "\"\"";
            return "\"" + TrimTrailingSeparators(value).Replace("\"", "\\\"") + "\"";
        }

        /// <summary>
        /// Drop trailing path separators. A root path is all separator, so it is
        /// returned unchanged rather than trimmed away to nothing.
        /// </summary>
        internal static string TrimTrailingSeparators(string value)
        {
            if (string.IsNullOrEmpty(value)) return value;
            string trimmed = value.TrimEnd('\\', '/');
            return trimmed.Length == 0 ? value : trimmed;
        }

        // ── installation discovery ───────────────────────────────────────────

        /// <summary>
        /// The path to launch, or null when nothing is installed.
        ///
        /// Order matters: an explicit choice beats a discovered one, and a
        /// record the app wrote about itself beats a path we guessed.
        /// </summary>
        public static string ResolveInstallation()
        {
            var candidate = ResolveCandidate();
            return string.IsNullOrEmpty(candidate.Path) ? null : candidate.Path;
        }

        /// <summary>
        /// The winning installation, with everything we know about it —
        /// including whether it is a dev launcher, which decides whether a deep
        /// link is allowed at all.
        /// </summary>
        internal static Candidate ResolveCandidate()
        {
            foreach (var candidate in Candidates())
            {
                if (Exists(candidate.Path)) return candidate;
            }
            return default(Candidate);
        }

        internal struct Candidate
        {
            public string Name;
            public string Path;
            /// <summary>
            /// A launcher script the developer pointed us at explicitly. It has
            /// to be run directly: a deep link would start whichever build owns
            /// the scheme instead.
            /// </summary>
            public bool IsDevLauncher;
        }

        /// <summary>Every installation we can find, best first, deduplicated.</summary>
        public static System.Collections.Generic.List<CodeEditorInstallation> Installations()
        {
            var result = new System.Collections.Generic.List<CodeEditorInstallation>();
            var seen = new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var candidate in Candidates())
            {
                if (!Exists(candidate.Path)) continue;
                if (!seen.Add(candidate.Path)) continue;
                result.Add(new CodeEditorInstallation { Name = candidate.Name, Path = candidate.Path });
            }
            return result;
        }

        private static System.Collections.Generic.IEnumerable<Candidate> Candidates()
        {
            // 1. Dev launcher, declared per project.
            string devConfig = Path.Combine(ProjectRoot, ".unityide-dev-path");
            if (File.Exists(devConfig))
            {
                string devLauncher = SafeReadAllText(devConfig);
                if (!string.IsNullOrEmpty(devLauncher))
                {
                    yield return new Candidate
                    {
                        Name = "UnityIDE (Dev)",
                        Path = devLauncher.Trim(),
                        IsDevLauncher = true,
                    };
                }
            }

            // 2. Whatever Unity currently has selected in External Tools. Unity
            //    hands it to IExternalCodeEditor.Initialize; honouring it here
            //    keeps the launcher and Unity's own dropdown from disagreeing
            //    about which copy is "the" installation.
            if (!string.IsNullOrEmpty(SelectedInstallation))
                yield return new Candidate { Name = "UnityIDE", Path = SelectedInstallation };

            // 3. The user's own choice.
            string custom = UnityIDESettings.InstallPath;
            if (!string.IsNullOrEmpty(custom))
                yield return new Candidate { Name = "UnityIDE", Path = custom };

            // 4. What the app said about itself the last time it ran. This is
            //    the reliable one: it survives a non-default install directory,
            //    a portable copy, and a rename, none of which a probe list can.
            yield return ReadInstallRecord();

            // 5. Default install locations, as a fallback for an app that is
            //    installed but has never been launched.
            foreach (string path in ProbePaths())
                yield return new Candidate { Name = "UnityIDE", Path = path };
        }

        /// <summary>True when this channel's application has left an install record.</summary>
        private static bool HasInstallRecord
        {
            get { return !string.IsNullOrEmpty(ReadInstallRecord().Path); }
        }

        /// <summary>
        /// The install record this channel's application writes on every launch
        /// (`unity::write_install_record`): `$HOME/&lt;ConfigDirName&gt;/install.json`.
        ///
        /// One directory, not two. This build talks to one application, and
        /// reading the other channel's record is how a dev-channel package ends
        /// up launching the release app.
        ///
        /// Derived from the home directory rather than from a SpecialFolder:
        /// Mono maps ApplicationData to `~/.config` on macOS while the app uses
        /// `dirs::home_dir`, and the two would never meet.
        /// </summary>
        private static Candidate ReadInstallRecord()
        {
            try
            {
                string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                if (string.IsNullOrEmpty(home)) return default(Candidate);

                string file = Path.Combine(
                    Path.Combine(home, UnityIDEChannel.ConfigDirName), "install.json");
                if (!File.Exists(file)) return default(Candidate);

                JsonValue json = JsonValue.TryParse(File.ReadAllText(file));
                if (json == null || !json.IsObject) return default(Candidate);

                // launchPath is the .app bundle on macOS and the executable
                // elsewhere; exePath is the fallback for a record written
                // before launchPath existed.
                string path = json["launchPath"].AsStringOr("");
                if (string.IsNullOrEmpty(path)) path = json["exePath"].AsStringOr("");
                if (string.IsNullOrEmpty(path)) return default(Candidate);

                return new Candidate { Name = UnityIDEChannel.DisplayName, Path = path };
            }
            catch
            {
                return default(Candidate);
            }
        }

        /// <summary>
        /// Default install locations for THIS channel's application, as a
        /// fallback for a copy that is installed but has never been launched
        /// (and so has left no install record).
        ///
        /// The release build also probes the pre-rename name: the extension and
        /// the app ship separately, so probing only the current paths would
        /// report "not installed" on a machine where the IDE is sitting right
        /// there under its old name.
        /// </summary>
        internal static string[] ProbePaths()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

            // This channel's application first, then the name it shipped under
            // before the rename (release only — there was never a dev-channel
            // build called Arcane). Built as a list rather than branched on
            // `UnityIDEChannel.IsDev`, because a const bool folds at compile
            // time and leaves the other channel's build full of CS0162
            // unreachable-code warnings.
            var names = new System.Collections.Generic.List<string> { UnityIDEChannel.DisplayName };
            if (!string.IsNullOrEmpty(UnityIDEChannel.LegacyAppName))
                names.Add(UnityIDEChannel.LegacyAppName);

            var paths = new System.Collections.Generic.List<string>();

            switch (Application.platform)
            {
                case RuntimePlatform.OSXEditor:
                    foreach (string app in names)
                    {
                        paths.Add("/Applications/" + app + ".app");
                        paths.Add(Path.Combine(home, "Applications/" + app + ".app"));
                    }
                    break;

                case RuntimePlatform.WindowsEditor:
                {
                    // Tauri's NSIS installer puts a per-user install in
                    // %LOCALAPPDATA%\<productName> and a per-machine one in
                    // Program Files. The `Programs\` variant is Electron's
                    // convention, kept only because this list shipped with it.
                    string local = Environment.GetFolderPath(
                        Environment.SpecialFolder.LocalApplicationData);
                    foreach (string app in names)
                    {
                        paths.Add(Path.Combine(local, app + "\\" + app + ".exe"));
                        paths.Add("C:\\Program Files\\" + app + "\\" + app + ".exe");
                        paths.Add(Path.Combine(local, "Programs\\" + app + "\\" + app + ".exe"));
                    }
                    break;
                }

                case RuntimePlatform.LinuxEditor:
                {
                    // Lowercase binary names, not the product name.
                    var bins = new System.Collections.Generic.List<string>
                        { UnityIDEChannel.LinuxBinaryName };
                    if (!string.IsNullOrEmpty(UnityIDEChannel.LegacyAppName))
                        bins.Add(UnityIDEChannel.LegacyAppName.ToLowerInvariant());
                    foreach (string bin in bins)
                    {
                        paths.Add("/usr/bin/" + bin);
                        paths.Add("/usr/local/bin/" + bin);
                        paths.Add(Path.Combine(home, ".local/bin/" + bin));
                    }
                    break;
                }
            }

            return paths.ToArray();
        }

        // ── platform helpers ─────────────────────────────────────────────────

        private static bool IsMac
        {
            get { return Application.platform == RuntimePlatform.OSXEditor; }
        }

        /// <summary>A macOS .app is a directory; everything else is a file.</summary>
        internal static bool Exists(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            try { return File.Exists(path) || Directory.Exists(path); }
            catch { return false; }
        }

        private static string SafeReadAllText(string path)
        {
            try { return File.ReadAllText(path); }
            catch { return null; }
        }

        /// <summary>Any process may take the foreground.</summary>
        private const int ASFW_ANY = -1;

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AllowSetForegroundWindow(int dwProcessId);

        /// <summary>
        /// Hand our foreground rights to the IDE.
        ///
        /// Windows only, and best-effort: without it a background process
        /// calling SetForegroundWindow gets its taskbar button flashed instead
        /// of its window raised, which is precisely the "it opened but I can't
        /// see it" failure. Everywhere else the OS has no such restriction.
        /// </summary>
        private static void AllowForeground(int pid)
        {
            if (Application.platform != RuntimePlatform.WindowsEditor) return;
            if (pid == 0) return;
            try { AllowSetForegroundWindow(pid); }
            catch (Exception e) { UnityIDELog.Warn("AllowSetForegroundWindow failed: " + e.Message); }
        }
    }

    /// <summary>
    /// One discovered installation. Mirrors CodeEditor.Installation, but as our
    /// own type so discovery does not have to be expressed in terms of the
    /// external-editor API it also feeds.
    /// </summary>
    public struct CodeEditorInstallation
    {
        public string Name;
        public string Path;
    }
}
