using System;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace Arcane.Editor
{
    /// <summary>
    /// Generates .sln and .csproj files by invoking ProjectGeneration.Sync()
    /// from whichever Unity IDE package is installed (com.unity.ide.vscode or
    /// com.unity.ide.visualstudio), using reflection to avoid compile-time dependencies.
    /// If neither package is found, auto-installs com.unity.ide.vscode.
    /// </summary>
    public static class ArcaneProjectGeneration
    {
        private static bool _initialized;
        private static MethodInfo _syncMethod;
        private static object _generatorInstance;
        private static bool _packageInstallRequested;
        private static EditorApplication.CallbackFunction _installCheckCallback;

        /// Consecutive Sync() failures; reset by the first success.
        private static int _consecutiveFailures;

        /// How many failures in a row before we surface a visible error.
        private const int FailureReportThreshold = 3;

        public static bool IsInstallingPackage => _packageInstallRequested;

        /// True while a deferred Sync is already queued, so bursts coalesce.
        private static bool _syncScheduled;

        /// <summary>
        /// Queue a <see cref="Sync"/> for the next editor tick instead of running
        /// it now.
        /// </summary>
        /// <remarks>
        /// Every caller of this reaches us from a Unity callback that can fire
        /// while the editor is still assembling itself:
        ///
        ///   - <c>Initialize</c> runs from <c>CodeEditor.Register</c> inside this
        ///     assembly's <c>InitializeOnLoad</c> static constructor, i.e. during
        ///     <c>EditorAssemblies.ProcessInitializeOnLoadAttributes</c>.
        ///   - <c>SyncIfNeeded</c> runs from asset postprocessing.
        ///
        /// The IDE package's generator is not built to be driven at those
        /// moments: its <c>Sync()</c> resolves AssetPostprocessor callbacks
        /// through <c>TypeCache</c>, which Unity has not finished populating
        /// while it is still processing InitializeOnLoad attributes. It threw
        /// NullReferenceException every time, three callers in a row tripped the
        /// failure threshold, and the user got a red console error on every
        /// domain reload while project generation silently never happened.
        ///
        /// delayCall runs after the reload settles, which is the first moment
        /// the generator's own dependencies are actually there.
        /// </remarks>
        public static void ScheduleSync()
        {
            if (_syncScheduled) return;
            _syncScheduled = true;
            EditorApplication.delayCall += RunScheduledSync;
        }

        private static void RunScheduledSync()
        {
            // A compile or import still in flight means the same half-built
            // pipeline, so wait for a later tick rather than burn an attempt.
            // _syncScheduled stays true here, which keeps this the only pending
            // callback instead of stacking one per re-queue.
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            {
                EditorApplication.delayCall += RunScheduledSync;
                return;
            }

            _syncScheduled = false;
            Sync();
        }

        private static readonly (string assemblyName, string typeName)[] Candidates =
        {
            ("Unity.VSCode.Editor", "VSCodeEditor.ProjectGeneration"),
            ("Unity.VisualStudio.Editor", "Microsoft.Unity.VisualStudio.Editor.ProjectGeneration"),
        };

        /// <summary>
        /// Generate all .sln and .csproj files for the current Unity project.
        /// </summary>
        public static bool Sync()
        {
            if (!EnsureInitialized())
            {
                EnsureIdePackageInstalled();
                return false;
            }

            try
            {
                _syncMethod.Invoke(_generatorInstance, null);
                ArcaneLog.Info("Project files (.sln/.csproj) regenerated successfully.");
                _consecutiveFailures = 0;
                return true;
            }
            catch (TargetInvocationException ex)
            {
                // The IDE package's ProjectGeneration can throw NullReferenceException
                // when called during early asset postprocessing. Reset so it re-initializes next time.
                Reset();
                ReportFailure(ex.InnerException?.Message ?? ex.Message);
                return false;
            }
            catch (Exception ex)
            {
                Reset();
                ReportFailure(ex.Message);
                return false;
            }
        }

        /// <summary>
        /// A single failure here is usually a transient deferral (generation
        /// attempted during early asset postprocessing), so it stays at Info.
        /// Sustained failure is not transient: it means the project never gets
        /// .csproj files, which silently costs the user all C# IntelliSense.
        /// That case is escalated to an Error once, because verbose logging is
        /// compiled out by default and the failure is otherwise invisible.
        /// </summary>
        private static void ReportFailure(string message)
        {
            _consecutiveFailures++;
            ArcaneLog.Info($"Project file generation deferred: {message}");

            if (_consecutiveFailures == FailureReportThreshold)
            {
                ArcaneLog.Error(
                    $"Could not generate .sln/.csproj files after {_consecutiveFailures} attempts: {message}. " +
                    "Unity-side IntelliSense project generation is not working. " +
                    "Arcane falls back to generating its own project files from the Unity install, " +
                    "so C# IntelliSense should still work in the editor.");
            }
        }

        /// <summary>
        /// Clear cached reflection data. Call this if IDE packages are installed/removed at runtime.
        /// </summary>
        public static void Reset()
        {
            _initialized = false;
            _syncMethod = null;
            _generatorInstance = null;
        }

        private static void EnsureIdePackageInstalled()
        {
            if (_packageInstallRequested)
                return;

            _packageInstallRequested = true;

            ArcaneLog.Info("No IDE package found. Auto-installing com.unity.ide.vscode for project file generation...");

            var request = UnityEditor.PackageManager.Client.Add("com.unity.ide.vscode");

            _installCheckCallback = () =>
            {
                if (!request.IsCompleted) return;

                EditorApplication.update -= _installCheckCallback;
                _installCheckCallback = null;

                if (request.Status == UnityEditor.PackageManager.StatusCode.Success)
                {
                    ArcaneLog.Info("com.unity.ide.vscode installed successfully. Unity will reload scripts.");
                }
                else
                {
                    ArcaneLog.Error($"Failed to install com.unity.ide.vscode: {request.Error?.message}");
                    _packageInstallRequested = false;
                }
            };

            EditorApplication.update += _installCheckCallback;
        }

        private static bool EnsureInitialized()
        {
            if (_initialized)
                return _syncMethod != null;

            _initialized = true;

            string projectPath = Path.GetDirectoryName(Application.dataPath);

            foreach (var (assemblyName, typeName) in Candidates)
            {
                try
                {
                    var assembly = Assembly.Load(assemblyName);
                    if (assembly == null) continue;

                    var type = assembly.GetType(typeName);
                    if (type == null) continue;

                    var syncMethod = type.GetMethod("Sync",
                        BindingFlags.Public | BindingFlags.Instance,
                        null, Type.EmptyTypes, null);
                    if (syncMethod == null) continue;

                    // ProjectGeneration constructors typically take the project directory path
                    object instance = null;

                    var ctorWithPath = type.GetConstructor(new[] { typeof(string) });
                    if (ctorWithPath != null)
                    {
                        instance = ctorWithPath.Invoke(new object[] { projectPath });
                    }
                    else
                    {
                        var ctorDefault = type.GetConstructor(Type.EmptyTypes);
                        if (ctorDefault != null)
                            instance = ctorDefault.Invoke(null);
                    }

                    if (instance == null) continue;

                    _generatorInstance = instance;
                    _syncMethod = syncMethod;

                    ArcaneLog.Info($"Found ProjectGeneration in {assemblyName}");
                    return true;
                }
                catch (FileNotFoundException)
                {
                    // Assembly not installed, try next
                }
                catch (Exception ex)
                {
                    ArcaneLog.Warn($"Could not load {assemblyName}: {ex.Message}");
                }
            }

            return false;
        }
    }
}
