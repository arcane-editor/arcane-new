using UnityEditor;

namespace UnityIDE.Editor
{
    /// <summary>
    /// Stores UnityIDE preferences in Unity's EditorPrefs.
    /// </summary>
    public static class UnityIDESettings
    {
        private const string AutoConnectKey = "UnityIDE_AutoConnect";
        private const string InstallPathKey = "UnityIDE_InstallPath";
        private const string LogBatchIntervalMsKey = "UnityIDE_LogBatchIntervalMs";
        private const string MaxLogBatchSizeKey = "UnityIDE_MaxLogBatchSize";

        /// Pre-rename key for InstallPath. EditorPrefs are per-machine and
        /// survive the package update, so anyone who set a custom path would
        /// otherwise be told "no installation path configured" the first time
        /// they double-clicked a script after updating. This is the only key
        /// worth carrying: the other three have sensible defaults, an install
        /// path does not.
        private const string LegacyInstallPathKey = "Arcane_InstallPath";

        public static bool AutoConnect
        {
            get => EditorPrefs.GetBool(AutoConnectKey, true);
            set => EditorPrefs.SetBool(AutoConnectKey, value);
        }

        public static string InstallPath
        {
            get
            {
                var path = EditorPrefs.GetString(InstallPathKey, "");
                if (!string.IsNullOrEmpty(path)) return path;

                // One-time carry-over from the pre-rename key, then delete it
                // so this branch stops running and the old key does not linger
                // as a second source of truth.
                var legacy = EditorPrefs.GetString(LegacyInstallPathKey, "");
                if (string.IsNullOrEmpty(legacy)) return "";

                EditorPrefs.SetString(InstallPathKey, legacy);
                EditorPrefs.DeleteKey(LegacyInstallPathKey);
                return legacy;
            }
            set => EditorPrefs.SetString(InstallPathKey, value);
        }

        public static int LogBatchIntervalMs
        {
            get => EditorPrefs.GetInt(LogBatchIntervalMsKey, 100);
            set => EditorPrefs.SetInt(LogBatchIntervalMsKey, value);
        }

        public static int MaxLogBatchSize
        {
            get => EditorPrefs.GetInt(MaxLogBatchSizeKey, 100);
            set => EditorPrefs.SetInt(MaxLogBatchSizeKey, value);
        }
    }
}
