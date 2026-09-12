// LauncherTests.cs — the pure parts of launching UnityIDE from Unity.
//
// Only argument construction and quoting are covered here. Discovery and the
// launch itself touch EditorPrefs, the filesystem and Process.Start, none of
// which belong in a unit test — but the argument string is exactly where the
// silent failures live: a mis-quoted path produces a process that starts,
// exits 0, and opens nothing.

using UnityIDE.Editor;
using NUnit.Framework;

namespace UnityIDE.Tests
{
    public class LauncherTests
    {
        // ── project-only ─────────────────────────────────────────────────────

        /// <summary>
        /// What `Assets > Open C# Project` and the Window menu item produce.
        /// This shape used to be a bare `UnityIDE "&lt;project&gt;"`, which the
        /// app's argv parser ignored entirely.
        /// </summary>
        [Test]
        public void ProjectOnlyOpenUsesTheProjectFlag()
        {
            Assert.AreEqual(
                "--project \"/Users/me/Proj\"",
                UnityIDELauncher.BuildArguments("/Users/me/Proj", null, 1, 1));
        }

        [Test]
        public void AnEmptyFilePathIsTreatedAsProjectOnly()
        {
            Assert.AreEqual(
                "--project \"/Users/me/Proj\"",
                UnityIDELauncher.BuildArguments("/Users/me/Proj", "", 12, 3));
        }

        // ── goto ─────────────────────────────────────────────────────────────

        [Test]
        public void AFileOpenCarriesItsPositionAndTheProject()
        {
            Assert.AreEqual(
                "--goto \"/Users/me/Proj/Assets/Player.cs:42:7\" \"/Users/me/Proj\"",
                UnityIDELauncher.BuildArguments(
                    "/Users/me/Proj", "/Users/me/Proj/Assets/Player.cs", 42, 7));
        }

        /// <summary>
        /// Unity hands out 0 for "no particular position" in some flows, and the
        /// app treats line/column as 1-based.
        /// </summary>
        [Test]
        public void APositionBelowOneIsClampedToOne()
        {
            Assert.AreEqual(
                "--goto \"/a/b.cs:1:1\" \"/p\"",
                UnityIDELauncher.BuildArguments("/p", "/a/b.cs", 0, -3));
        }

        [Test]
        public void AWindowsPathKeepsItsDriveLetterAndBackslashes()
        {
            Assert.AreEqual(
                "--goto \"C:\\Proj\\Assets\\Player.cs:9:1\" \"C:\\Proj\"",
                UnityIDELauncher.BuildArguments(
                    "C:\\Proj", "C:\\Proj\\Assets\\Player.cs", 9, 1));
        }

        // ── quoting ──────────────────────────────────────────────────────────

        [Test]
        public void PathsWithSpacesAreQuoted()
        {
            Assert.AreEqual(
                "--project \"/Users/me/My Unity Project\"",
                UnityIDELauncher.BuildArguments("/Users/me/My Unity Project", null, 1, 1));
        }

        /// <summary>
        /// The reason Quote trims. A backslash immediately before the closing
        /// quote escapes it, so `"C:\Proj\"` never terminates the argument and
        /// the project path swallows everything after it.
        /// </summary>
        [Test]
        public void ATrailingBackslashIsTrimmedSoItCannotEscapeTheClosingQuote()
        {
            string args = UnityIDELauncher.BuildArguments("C:\\Proj\\", null, 1, 1);
            Assert.AreEqual("--project \"C:\\Proj\"", args);
            Assert.IsFalse(args.Contains("\\\""), "the closing quote must not be escaped");
        }

        [Test]
        public void ATrailingForwardSlashIsTrimmedToo()
        {
            Assert.AreEqual(
                "--project \"/Users/me/Proj\"",
                UnityIDELauncher.BuildArguments("/Users/me/Proj/", null, 1, 1));
        }

        /// <summary>A path that is nothing but separators still has to survive.</summary>
        [Test]
        public void ARootPathIsNotTrimmedAway()
        {
            Assert.AreEqual("\"/\"", UnityIDELauncher.Quote("/"));
        }

        [Test]
        public void EmbeddedQuotesAreEscaped()
        {
            Assert.AreEqual("\"/a/we\\\"ird\"", UnityIDELauncher.Quote("/a/we\"ird"));
        }

        [Test]
        public void AnEmptyValueQuotesToAnEmptyArgument()
        {
            Assert.AreEqual("\"\"", UnityIDELauncher.Quote(null));
            Assert.AreEqual("\"\"", UnityIDELauncher.Quote(""));
        }

        // ── deep link ────────────────────────────────────────────────────────
        //
        // The route taken first now, because it needs no idea where the app is
        // installed. Percent-encoding is what makes it safe for the things that
        // break a command line.

        [Test]
        public void AProjectOnlyDeepLinkNamesOnlyTheProject()
        {
            Assert.AreEqual(
                "unityide://open?project=%2FUsers%2Fme%2FProj",
                UnityIDELauncher.BuildDeepLink("unityide", "/Users/me/Proj", null, 1, 1));
        }

        [Test]
        public void AFileDeepLinkCarriesTheFileAndPosition()
        {
            Assert.AreEqual(
                "unityide://open?project=%2FUsers%2Fme%2FProj" +
                "&file=%2FUsers%2Fme%2FProj%2FAssets%2FPlayer.cs&line=42&column=7",
                UnityIDELauncher.BuildDeepLink(
                    "unityide", "/Users/me/Proj", "/Users/me/Proj/Assets/Player.cs", 42, 7));
        }

        [Test]
        public void AnEmptyFilePathProducesAProjectOnlyDeepLink()
        {
            Assert.AreEqual(
                "unityide://open?project=%2Fp",
                UnityIDELauncher.BuildDeepLink("unityide", "/p", "", 9, 9));
        }

        /// <summary>
        /// A Windows path is nothing but characters a URL treats specially: a
        /// drive colon and backslashes.
        /// </summary>
        [Test]
        public void AWindowsPathIsFullyEncoded()
        {
            string url = UnityIDELauncher.BuildDeepLink(
                "unityide", "C:\\Proj", "C:\\Proj\\Assets\\Player.cs", 9, 1);
            Assert.AreEqual(
                "unityide://open?project=C%3A%5CProj" +
                "&file=C%3A%5CProj%5CAssets%5CPlayer.cs&line=9&column=1",
                url);
            Assert.IsFalse(url.Contains("\\"), "no raw backslash may survive into the URL");
        }

        /// <summary>
        /// The characters that quietly truncate a URL if they go through raw:
        /// `&` starts a new parameter, `#` starts a fragment, a space ends the
        /// argument.
        /// </summary>
        [Test]
        public void SpacesAmpersandsAndHashesAreEncoded()
        {
            string url = UnityIDELauncher.BuildDeepLink(
                "unityide", "/Users/me/Rock & Roll #2", null, 1, 1);
            Assert.AreEqual(
                "unityide://open?project=%2FUsers%2Fme%2FRock%20%26%20Roll%20%232", url);
        }

        [Test]
        public void NonAsciiPathsAreEncoded()
        {
            Assert.AreEqual(
                "unityide://open?project=%2FUsers%2Fme%2FPr%C3%B8ject",
                UnityIDELauncher.BuildDeepLink("unityide", "/Users/me/Prøject", null, 1, 1));
        }

        /// <summary>The dev build answers its own scheme, so both can be installed.</summary>
        [Test]
        public void TheSchemeIsWhicheverInstallationAnswered()
        {
            StringAssert.StartsWith(
                "unityide-dev://open?",
                UnityIDELauncher.BuildDeepLink("unityide-dev", "/p", null, 1, 1));
        }

        [Test]
        public void ADeepLinkPositionBelowOneIsClampedToOne()
        {
            StringAssert.EndsWith(
                "&line=1&column=1",
                UnityIDELauncher.BuildDeepLink("unityide", "/p", "/p/A.cs", 0, -3));
        }

        /// <summary>
        /// Same trim as the command line, for the same reason on the far side:
        /// the app compares the project it is handed against the one a window
        /// already has open, and a trailing separator is a spelling difference.
        /// </summary>
        [Test]
        public void ATrailingSeparatorIsTrimmedFromTheProject()
        {
            Assert.AreEqual(
                "unityide://open?project=C%3A%5CProj",
                UnityIDELauncher.BuildDeepLink("unityide", "C:\\Proj\\", null, 1, 1));
        }

        [Test]
        public void TrimTrailingSeparatorsKeepsARootPath()
        {
            Assert.AreEqual("/", UnityIDELauncher.TrimTrailingSeparators("/"));
            Assert.AreEqual("\\", UnityIDELauncher.TrimTrailingSeparators("\\"));
        }

        // ── discovery ────────────────────────────────────────────────────────

        /// <summary>
        /// A macOS .app is a directory, not a file. Probing with File.Exists
        /// alone reports every bundle as missing.
        /// </summary>
        [Test]
        public void ExistsAcceptsADirectoryAsWellAsAFile()
        {
            string dir = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(), "unityide-exists-" + System.IO.Path.GetRandomFileName());
            System.IO.Directory.CreateDirectory(dir);
            try
            {
                Assert.IsTrue(UnityIDELauncher.Exists(dir));
                Assert.IsFalse(UnityIDELauncher.Exists(
                    System.IO.Path.Combine(dir, "nothing-here")));
                Assert.IsFalse(UnityIDELauncher.Exists(null));
                Assert.IsFalse(UnityIDELauncher.Exists(""));
            }
            finally
            {
                try { System.IO.Directory.Delete(dir, true); } catch { }
            }
        }

        /// <summary>
        /// The Windows list carried Electron's `%LOCALAPPDATA%\Programs\<app>`
        /// convention while Tauri's NSIS installs to `%LOCALAPPDATA%\<app>`, so
        /// a default per-user install was never found. Both are probed now.
        /// </summary>
        [Test]
        public void WindowsProbesIncludeTheTauriPerUserInstallDirectory()
        {
            if (UnityEngine.Application.platform != UnityEngine.RuntimePlatform.WindowsEditor)
                Assert.Ignore("Windows-only probe list");

            string local = System.Environment.GetFolderPath(
                System.Environment.SpecialFolder.LocalApplicationData);
            CollectionAssert.Contains(
                UnityIDELauncher.ProbePaths(),
                System.IO.Path.Combine(local, "UnityIDE\\UnityIDE.exe"));
        }
    }
}
