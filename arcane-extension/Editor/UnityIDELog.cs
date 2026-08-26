using System.Diagnostics;
using Debug = UnityEngine.Debug;

namespace UnityIDE.Editor
{
    /// <summary>
    /// Centralized logging for the UnityIDE extension.
    /// Info and Warn logs are stripped unless UNITYIDE_VERBOSE is defined.
    /// Error logs are always emitted.
    /// To enable verbose logging: add UNITYIDE_VERBOSE to
    /// Edit > Project Settings > Player > Scripting Define Symbols.
    /// </summary>
    public static class UnityIDELog
    {
        [Conditional("UNITYIDE_VERBOSE")]
        public static void Info(string message)
        {
            Debug.Log($"[UnityIDE] {message}");
        }

        [Conditional("UNITYIDE_VERBOSE")]
        public static void Warn(string message)
        {
            Debug.LogWarning($"[UnityIDE] {message}");
        }

        public static void Error(string message)
        {
            Debug.LogError($"[UnityIDE] {message}");
        }
    }
}
