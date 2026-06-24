using System.Diagnostics;
using Debug = UnityEngine.Debug;

namespace Arcane.Editor
{
    /// <summary>
    /// Centralized logging for the Arcane extension.
    /// Info and Warn logs are stripped unless ARCANE_VERBOSE is defined.
    /// Error logs are always emitted.
    /// To enable verbose logging: add ARCANE_VERBOSE to
    /// Edit > Project Settings > Player > Scripting Define Symbols.
    /// </summary>
    public static class ArcaneLog
    {
        [Conditional("ARCANE_VERBOSE")]
        public static void Info(string message)
        {
            Debug.Log($"[Arcane] {message}");
        }

        [Conditional("ARCANE_VERBOSE")]
        public static void Warn(string message)
        {
            Debug.LogWarning($"[Arcane] {message}");
        }

        public static void Error(string message)
        {
            Debug.LogError($"[Arcane] {message}");
        }
    }
}
