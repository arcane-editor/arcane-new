// EditorGate.cs — the shared "is the Editor in a state where a scene write is
// safe?" guard, used by every write RPC (SceneMutationHandlers today, whatever
// follows it tomorrow).
//
// It lives in its own file, outside Handlers/, because it is not about any one
// RPC: it is the single place that decides when the bridge must refuse to touch
// the user's project.

using System;
using UnityEditor;
using UnityEditor.SceneManagement;

namespace UnityIDE.Bridge
{
    /// <summary>
    /// The shared "is the Editor in a state where a scene write is safe?" guard.
    /// </summary>
    /// <remarks>
    /// Three states make a scene write a bad idea, and all three fail QUIETLY
    /// without this check — which is the worst possible outcome for an agent
    /// that will report success and move on:
    ///
    ///   * Play Mode — everything written is thrown away on exit.
    ///   * Compiling — the domain is about to reload underneath the handler.
    ///   * Prefab Mode — `SceneManager` sees the prefab stage's throwaway scene,
    ///     so a hierarchy path resolves against the wrong thing (or not at all)
    ///     and MarkSceneDirty dirties a scene the user never opened.
    ///
    /// <see cref="IsBusy"/> is a field, not a method, so tests can inject a
    /// state no headless test process could otherwise reach.
    /// </remarks>
    internal static class EditorGate
    {
        /// <summary>
        /// Returns a user-facing reason the Editor is busy, or null when a write
        /// is safe. Replaceable for tests; call <see cref="ResetForTests"/> to
        /// restore the real check.
        /// </summary>
        internal static Func<string> IsBusy = DefaultIsBusy;

        /// <summary>The busy reason, or null. Null-safe against a cleared IsBusy.</summary>
        internal static string BusyReason()
        {
            Func<string> probe = IsBusy;
            return probe == null ? null : probe();
        }

        internal static void ResetForTests()
        {
            IsBusy = DefaultIsBusy;
        }

        private static string DefaultIsBusy()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isPlaying)
                return "Unity is in Play Mode. Exit Play Mode and try again — changes made in Play Mode are discarded.";
            if (EditorApplication.isCompiling)
                return "Unity is compiling. Try again once the compile finishes.";
            if (PrefabStageUtility.GetCurrentPrefabStage() != null)
                return "Unity has a prefab open in Prefab Mode. Go back to the scene (the arrow in the Hierarchy breadcrumb) and try again.";
            return null;
        }
    }
}
