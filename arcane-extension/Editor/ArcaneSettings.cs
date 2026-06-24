using UnityEditor;

namespace Arcane.Editor
{
    /// <summary>
    /// Stores Arcane IDE preferences in Unity's EditorPrefs.
    /// </summary>
    public static class ArcaneSettings
    {
        private const string AutoConnectKey = "Arcane_AutoConnect";
        private const string InstallPathKey = "Arcane_InstallPath";
        private const string LogBatchIntervalMsKey = "Arcane_LogBatchIntervalMs";
        private const string MaxLogBatchSizeKey = "Arcane_MaxLogBatchSize";

        public static bool AutoConnect
        {
            get => EditorPrefs.GetBool(AutoConnectKey, true);
            set => EditorPrefs.SetBool(AutoConnectKey, value);
        }

        public static string InstallPath
        {
            get => EditorPrefs.GetString(InstallPathKey, "");
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
