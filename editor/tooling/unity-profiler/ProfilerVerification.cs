// Copied into the disposable verification package, never installed in a user's project.
using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using UnityEditor;
using UnityEditorInternal;
using Unity.Profiling;
using UnityEngine;
namespace UnityIDE.Bridge
{
    public static class ProfilerVerification
    {
        static int ticks;
        static double deadline;
        static readonly ProfilerMarker Marker = new ProfilerMarker("UnityIDE.Verify.Work");
        static byte[] allocation;
        static bool started;
        static JsonValue Call(string name) { return (JsonValue)typeof(ProfilerHandlers).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { JsonValue.NewObject() }); }
        public static void Run()
        {
            try
            {
                var profileEditor = typeof(ProfilerDriver).GetProperty("profileEditor", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                if (profileEditor == null) throw new Exception("Unity exposes no Editor profiling switch");
                profileEditor.SetValue(null, true, null);
                // Batch mode has no ordinary Editor frames. Run a disposable
                // Play session and put the marker inside its actual player loop.
                EditorSettings.enterPlayModeOptionsEnabled = true;
                EditorSettings.enterPlayModeOptions = EnterPlayModeOptions.DisableDomainReload;
                deadline = EditorApplication.timeSinceStartup + 60;
                EditorApplication.isPlaying = true;
                EditorApplication.update += Update;
            }
            catch (Exception e) { Finish(false, e.ToString()); }
        }
        static void Update()
        {
            try
            {
                if (EditorApplication.timeSinceStartup > deadline) {
                    var stalled = Call("Status");
                    Finish(false, "No verified profiler marker within 60 seconds; ticks=" + ticks +
                        ", rawFrames=" + ProfilerDriver.firstFrameIndex + ".." + ProfilerDriver.lastFrameIndex +
                        ", enabled=" + ProfilerDriver.enabled + ", status=" + stalled.Serialize()); return;
                }
                if (!EditorApplication.isPlaying) return;
                if (!started) {
                    ProfilerDriver.SetAreaEnabled(UnityEngine.Profiling.ProfilerArea.CPU, true);
                    UnityEngine.Profiling.Profiler.enabled = true;
                    var loop = UnityEngine.LowLevel.PlayerLoop.GetCurrentPlayerLoop();
                    var children = new System.Collections.Generic.List<UnityEngine.LowLevel.PlayerLoopSystem>(loop.subSystemList);
                    children.Add(new UnityEngine.LowLevel.PlayerLoopSystem { type = typeof(ProfilerVerification), updateDelegate = Sample });
                    loop.subSystemList = children.ToArray();
                    UnityEngine.LowLevel.PlayerLoop.SetPlayerLoop(loop);
                    Call("Start"); started = true;
                }
                EditorApplication.QueuePlayerLoopUpdate();
                ++ticks;
                // Batch startup and profiler transport are asynchronous. A
                // fixed number of editor ticks can finish before the first
                // recorded frame arrives. Keep recording until evidence exists.
                ProfilerHandlers.Tick();
                var status = Call("Status");
                string id = status["captureId"].AsString;
                string directory = Path.Combine(Path.GetDirectoryName(Application.dataPath), "Library", "UnityIDE", "Profiler", id);
                foreach (JsonValue index in status["chunks"].Array)
                {
                    string path = Path.Combine(directory, (int)index.AsNumber + ".json.gz");
                    string json;
                    using (var file = File.OpenRead(path)) using (var gzip = new GZipStream(file, CompressionMode.Decompress)) using (var reader = new StreamReader(gzip)) json = reader.ReadToEnd();
                    var chunk = JsonValue.Parse(json);
                    foreach (JsonValue sample in chunk["samples"].Array)
                    {
                        if (sample["name"].AsString != "UnityIDE.Verify.Work") continue;
                        using (var view = ProfilerDriver.GetRawFrameDataView((int)chunk["frame"].AsNumber, (int)chunk["thread"].AsNumber))
                        {
                            if (!view.valid) continue;
                            int sampleId = (int)sample["id"].AsNumber;
                            double measured = view.GetSampleTimeMs(sampleId);
                            if (measured <= 0 || Math.Abs(measured - sample["durationMs"].AsNumber) > 0.00001) throw new Exception("Exported timing disagrees with Unity's raw frame");
                            if (view.GetSampleName(sampleId) != sample["name"].AsString) throw new Exception("Exported sample identity disagrees with Unity");
                        }
                        File.WriteAllText(Path.Combine(Path.GetDirectoryName(Application.dataPath), "profiler-status.json"), status.Serialize());
                        Finish(true, "Real Unity marker and timing match the exported compressed capture"); return;
                    }
                }
            }
            catch (Exception e) { Finish(false, e.ToString()); }
        }
        static void Sample()
        {
            using (Marker.Auto()) {
                allocation = new byte[4096]; allocation[0] = (byte)ticks;
                System.Threading.Thread.SpinWait(100000);
            }
        }
        static void Finish(bool ok, string message)
        {
            EditorApplication.update -= Update;
            var result = JsonValue.NewObject(); result["ok"] = ok; result["message"] = message; result["unityVersion"] = Application.unityVersion;
            File.WriteAllText(Path.Combine(Path.GetDirectoryName(Application.dataPath), "profiler-verification.json"), result.Serialize());
            ProfilerHandlers.Uninstall(); EditorApplication.Exit(ok ? 0 : 1);
        }
    }
}
