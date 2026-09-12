#if UNITY_EDITOR
using UnityEngine;
using UnityEditor;

namespace UnityIDE.Automation
{
    internal static class AutomationSeed
    {
        // Runs before scene Awake/OnEnable, including with domain reload disabled.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
        private static void Apply()
        {
            if (SessionState.GetBool("UnityIDE.Automation.SeedActive", false))
                Random.InitState(SessionState.GetInt("UnityIDE.Automation.Seed", 0));
        }
    }
}
#endif
