// UnityIDEChannel.cs — what makes this build of the package a RELEASE build.
//
// The package ships twice, once per release channel, because the two channels
// are separate applications end to end: a different app name, a different
// deep-link scheme, a different per-user config directory, a different updater
// feed. A single package that tried to work out at runtime which of them the
// user meant got it wrong in the one case that matters — it always resolved to
// release, so someone testing the dev build had their double-clicks answered by
// the release app, silently.
//
// So the choice is made once, at build time, and everything downstream reads it
// from here. `scripts/unity-extension-channel.mjs` rewrites this file (and the
// package id, the assembly name and the asset GUIDs) to produce the dev
// variant; the values checked in are the release ones.
//
// KEEP EVERY MEMBER `const`. `UnityIDEMenu` builds its `[MenuItem]` paths out of
// DisplayName, and an attribute argument must be a compile-time constant.

namespace UnityIDE.Editor
{
    internal static class UnityIDEChannel
    {
        /// <summary>Product name of the application this build talks to.</summary>
        public const string DisplayName = "UnityIDE";

        /// <summary>
        /// Deep-link scheme the application answers. Mirrors
        /// `plugins.deep-link.desktop.schemes` in its tauri config.
        /// </summary>
        public const string Scheme = "unityide";

        /// <summary>
        /// The application's per-user config directory under $HOME. Mirrors
        /// `auth::config_dir_name` on the app side, and is where it writes the
        /// install record this package reads.
        /// </summary>
        public const string ConfigDirName = ".unityide";

        /// <summary>Executable name used for the Linux probe paths.</summary>
        public const string LinuxBinaryName = "unityide";

        /// <summary>UPM package id. Mirrors `name` in package.json.</summary>
        public const string PackageName = "com.unityide.editor";

        /// <summary>
        /// Where to send someone who has this package but not the application.
        /// </summary>
        public const string DownloadUrl = "https://unityide.app/download";

        /// <summary>
        /// This application's name before the rename, or empty when there was
        /// never one — there was no dev-channel build under the old name.
        ///
        /// Empty rather than a bool the probe builder branches on: a `const`
        /// bool folds at compile time, and the dead branch it leaves behind is
        /// a CS0162 warning in every build of the other channel.
        /// </summary>
        public const string LegacyAppName = "Arcane";

        /// <summary>True in the dev-channel build. For messages, not behaviour.</summary>
        public const bool IsDev = false;
    }
}
