// UnityIDEMenu.cs — the Unity-side entry points, and the one prompt that makes
// double-clicking a script land in UnityIDE.
//
// Two problems, one file:
//
//  1. There was no way to say "open this project in UnityIDE" from inside
//     Unity. Unity ships `Assets > Open C# Project`, which routes to the
//     configured external script editor — but only if UnityIDE *is* the
//     configured one, so it is not an answer on its own.
//  2. Installing the package does not make UnityIDE the script editor, so
//     double-clicking a script kept opening whatever was already configured.
//     The package looked installed and did nothing visible.
//
// The prompt is opt-in and asked once. Silently claiming the script editor
// would be faster to write and worse to live with: it is a preference a user
// may have set deliberately, on a setting that is per-machine and would be
// re-hijacked on every machine that opens the project.

using System;
using Unity.CodeEditor;
using UnityEditor;
using UnityEngine;

namespace UnityIDE.Editor
{
    [InitializeOnLoad]
    public static class UnityIDEMenu
    {
        /// <summary>
        /// The application this build talks to. Both menu paths are built from
        /// it, so the release and dev packages get distinct menus and can be
        /// told apart at a glance.
        /// </summary>
        private const string AppName = UnityIDEChannel.DisplayName;

        private const string MenuRoot = "Window/" + AppName + "/";
        private const string OpenProjectItem = MenuRoot + "Open Project in " + AppName;
        private const string UseForScriptsItem = MenuRoot + "Use " + AppName + " for C# Scripts";

        /// <summary>
        /// Set once the user has answered the first-run prompt, either way.
        /// EditorPrefs (per machine, survives project reopen) rather than
        /// SessionState: "not now" has to outlive this editor session, or it is
        /// just a nag on every launch.
        /// </summary>
        /// Per channel: answering the prompt for the release build must not
        /// silence it for the dev build, which is a different application
        /// asking a different question.
        private const string PromptAnsweredKey =
            "UnityIDE_ScriptEditorPromptAnswered_" + UnityIDEChannel.Scheme;

        static UnityIDEMenu()
        {
            // Same one-tick defer as BridgeBootstrap: a dialog cannot open from
            // inside an InitializeOnLoad static constructor, and touching the
            // CodeEditor registry that early is fragile.
            EditorApplication.delayCall += MaybeOfferToClaimScriptEditor;
        }

        // ── menu items ───────────────────────────────────────────────────────

        [MenuItem(OpenProjectItem, false, 100)]
        public static void OpenProject()
        {
            if (UnityIDELauncher.Open(null, 1, 1)) return;

            // Open() already logged the reason and, if nothing is installed,
            // already opened the download page. A menu item the user clicked
            // deliberately deserves an answer on screen too.
            if (EditorUtility.DisplayDialog(
                    AppName + " not found",
                    "No " + AppName + " installation could be found on this " +
                    "machine.\n\nInstall it, or point Preferences > External " +
                    "Tools at an existing copy.",
                    "Download " + AppName,
                    "Cancel"))
            {
                Application.OpenURL(UnityIDELauncher.DownloadUrl);
            }
        }

        [MenuItem(UseForScriptsItem, false, 101)]
        public static void UseForScripts()
        {
            if (!ClaimScriptEditor())
            {
                EditorUtility.DisplayDialog(
                    AppName + " not found",
                    "Install " + AppName + ", or point Preferences > External " +
                    "Tools at an existing copy, and try again.",
                    "OK");
            }
        }

        /// <summary>Greyed out once UnityIDE is already the script editor.</summary>
        [MenuItem(UseForScriptsItem, true)]
        public static bool UseForScriptsValidate()
        {
            return !IsCurrentScriptEditor();
        }

        // ── first-run prompt ─────────────────────────────────────────────────

        private static void MaybeOfferToClaimScriptEditor()
        {
            try
            {
                if (EditorPrefs.GetBool(PromptAnsweredKey, false)) return;
                if (IsCurrentScriptEditor())
                {
                    // Already ours — nothing to ask, and asking later would be
                    // noise if they ever switch away deliberately.
                    EditorPrefs.SetBool(PromptAnsweredKey, true);
                    return;
                }
                // Nothing to point Unity at yet. Deliberately does NOT mark the
                // prompt answered: the user may install the app tomorrow, and
                // that is exactly when this offer becomes useful.
                if (UnityIDELauncher.ResolveInstallation() == null) return;

                int choice = EditorUtility.DisplayDialogComplex(
                    "Use " + AppName + " for C# scripts?",
                    AppName + " is installed on this machine. Make it the editor " +
                    "Unity opens when you double-click a script?\n\n" +
                    "You can change this any time in " +
                    "Preferences > External Tools.",
                    "Use " + AppName,
                    "Not now",
                    "Never ask again");

                switch (choice)
                {
                    case 0:
                        ClaimScriptEditor();
                        EditorPrefs.SetBool(PromptAnsweredKey, true);
                        break;
                    case 1:
                        // Ask again next session. Nothing persisted.
                        break;
                    default:
                        EditorPrefs.SetBool(PromptAnsweredKey, true);
                        break;
                }
            }
            catch (Exception e)
            {
                // A dialog is never worth breaking the editor's load chain over.
                UnityIDELog.Warn("script-editor prompt skipped: " + e.Message);
            }
        }

        // ── script-editor registration ───────────────────────────────────────

        /// <summary>
        /// Point Unity's External Script Editor at UnityIDE. False when there is
        /// no installation to point it at.
        /// </summary>
        public static bool ClaimScriptEditor()
        {
            string path = UnityIDELauncher.ResolveInstallation();
            if (string.IsNullOrEmpty(path)) return false;

            CodeEditor.SetExternalScriptEditor(path);
            return true;
        }

        /// <summary>Is UnityIDE what Unity currently opens scripts with?</summary>
        public static bool IsCurrentScriptEditor()
        {
            try
            {
                string current = CodeEditor.CurrentEditorInstallation;
                if (string.IsNullOrEmpty(current)) return false;
                // Match on the name rather than on an exact path: the user may
                // have picked a copy we would not have discovered. The release
                // build also accepts the pre-rename app; the dev build must not
                // accept the release one, or it would report a release install
                // as "already ours" and never offer to take over.
                if (current.IndexOf(AppName, StringComparison.OrdinalIgnoreCase) >= 0)
                    return true;
                return !string.IsNullOrEmpty(UnityIDEChannel.LegacyAppName)
                    && current.IndexOf(
                        UnityIDEChannel.LegacyAppName, StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch
            {
                return false;
            }
        }
    }
}
