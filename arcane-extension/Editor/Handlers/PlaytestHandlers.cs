using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;
using UnityIDE.Automation;

namespace UnityIDE.Bridge
{
    internal static class PlaytestHandlers
    {
        private const string ActiveKey = "UnityIDE.Automation.Playtest";
        private static JsonValue _run;
        private static IAutomationInput _input;
        private static int _frame = -1;
        private static double _captureStarted;
        private static bool _capturePending;
        private static bool _subscribed;
        private static double _lastSample;

        internal static void Register()
        {
            RpcDispatcher.Register("startPlaytest", Start);
            RpcDispatcher.Register("getPlaytestStatus", Status);
            RpcDispatcher.Register("cancelPlaytest", Cancel);
            RpcDispatcher.Register("getAutomationState", _ => {
                var state = JsonValue.NewObject();
                if (_run != null) { state["activePlaytest"] = _run["operationId"]; state["taskId"] = _run["taskId"]; }
                return state;
            });
            if (!_subscribed) { Application.logMessageReceived += OnLog; _subscribed = true; }
            string active = SessionState.GetString(ActiveKey, "");
            if (!string.IsNullOrEmpty(active)) {
                _run = JsonValue.Parse(active);
                // Only the expected Enter/Exit Play Mode reload can be resumed.
                if (_run["status"].AsString == "running" && !EditorApplication.isPlaying)
                    Finish("interrupted", "Play Mode ended before the scenario completed.");
            }
        }

        private static JsonValue Start(JsonValue p)
        {
            string id = AutomationStore.Id(p["operationId"].AsString);
            var prior = RecoverReport(id);
            string payloadHash = AutomationStore.Hash(p["scenario"].Serialize());
            if (prior["status"].AsString != "unsupported") {
                if (prior["payloadHash"].AsString != payloadHash || prior["taskId"].AsString != p["taskId"].AsString) return AutomationStore.Report(id, "failed", "Operation ID already belongs to a different task or scenario. Use a new ID.");
                return PublicReport(prior, false);
            }
            try
            {
                if (_run != null) throw new InvalidOperationException("Another playtest owns Unity.");
                AuthoringHandlers.RequireIdleClean();
                if (AutomationInput.Create == null) return AutomationStore.Report(id, "unsupported", "Input System adapter unavailable. Legacy input checks were not run.");
                var scenario = p["scenario"];
                string path = AutomationStore.AssetPath(scenario["scenePath"].AsString);
                if (!File.Exists(path)) throw new ArgumentException("Playtest scene must already be saved.");
                if (!scenario["steps"].IsArray || !scenario["steps"].Array.Any(s => s["kind"].AsString == "assert") || !scenario["steps"].Array.Any(s => s["kind"].AsString == "input"))
                    throw new ArgumentException("A scenario needs real inputs and assertions.");
                _run = AutomationStore.Report(id, "queued");
                _run["payloadHash"] = payloadHash; _run["cleanupComplete"] = false; _run["taskId"] = p["taskId"];
                _run["scenario"] = scenario; _run["step"] = 0; _run["waitFrames"] = 0;
                _run["performance"] = JsonValue.NewObject();
                _run["performance"]["samples"] = 0; _run["performance"]["frameTotalMs"] = 0;
                _run["performance"]["maxFrameMs"] = 0; _run["performance"]["peakMemoryMb"] = 0;
                _run["gcStart"] = GC.CollectionCount(0);
                _run["observations"] = JsonValue.NewArray(); _run["consoleErrors"] = JsonValue.NewArray(); _run["captureFiles"] = JsonValue.NewArray();
                _run["startedUtc"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                _run["previousScene"] = SceneManager.GetActiveScene().path;
                // Save and restore the editor scene layout, with no unsaved scenes allowed.
                var setup = JsonValue.NewArray();
                foreach (var scene in EditorSceneManager.GetSceneManagerSetup()) {
                    var item = JsonValue.NewObject(); item["path"] = scene.path; item["isLoaded"] = scene.isLoaded; item["isActive"] = scene.isActive; setup.Add(item);
                }
                _run["sceneSetup"] = setup;
                _run["previousWindow"] = EditorWindow.focusedWindow != null ? EditorWindow.focusedWindow.GetType().FullName : "";
                // Journal ownership and the original layout before changing Unity.
                Persist();
                EditorSceneManager.OpenScene(path, OpenSceneMode.Single);
                if (!Application.isBatchMode) {
                    var gameView = typeof(EditorWindow).Assembly.GetType("UnityEditor.GameView");
                    if (gameView != null) EditorWindow.GetWindow(gameView).Focus();
                }
                SessionState.SetInt("UnityIDE.Automation.Seed", scenario["seed"].AsInt);
                SessionState.SetBool("UnityIDE.Automation.SeedActive", true);
                Persist();
                EditorApplication.isPlaying = true;
                return PublicReport(_run, false);
            }
            catch (Exception e) {
                // A rejected concurrent request must never cancel the owning run.
                if (_run != null && _run["operationId"].AsString == id) Finish("failed", e.Message);
                return AutomationStore.Report(id, "failed", e.Message);
            }
        }

        internal static void Tick()
        {
            if (_run == null) return;
            try
            {
                string status = _run["status"].AsString;
                if (status != "queued" && status != "running") {
                    if (!EditorApplication.isPlayingOrWillChangePlaymode) Restore();
                    return;
                }
                MainThreadDispatcher.RequestWake(2000);
                double elapsed = (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _run["startedUtc"].AsNumber) / 1000d;
                double limit = _run["scenario"]["timeoutSeconds"].IsNumber ? Math.Max(1, Math.Min(600, _run["scenario"]["timeoutSeconds"].AsNumber)) : 120;
                if (elapsed > limit) { Finish("failed", "Scenario timeout; Unity did not complete the required steps."); return; }
                if (!EditorApplication.isPlaying) return;
                if (status == "queued") {
                    if (AutomationInput.Create == null) { Finish("unsupported", "Input System adapter unavailable after reload."); return; }
                    _input = AutomationInput.Create();
                    _run["status"] = "running"; Persist();
                }
                else if (_input == null) { Finish("interrupted", "Unexpected domain reload during gameplay; rerun against a clean state."); return; }
                if (_capturePending) {
                    if (EditorApplication.timeSinceStartup - _captureStarted > 10) Finish("failed", "No rendered Game-view frame arrived within ten seconds.");
                    return;
                }
                if (_frame == Time.frameCount) return; _frame = Time.frameCount;
                if (_run["waitUntilUtc"].IsNumber && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() < _run["waitUntilUtc"].AsNumber) return;
                if (EditorApplication.timeSinceStartup - _lastSample > .25) {
                    _lastSample = EditorApplication.timeSinceStartup;
                    var stats = _run["performance"]; int count = stats["samples"].AsInt + 1;
                    double frameMs = Time.unscaledDeltaTime * 1000d;
                    stats["samples"] = count; stats["frameTotalMs"] = stats["frameTotalMs"].AsNumber + frameMs;
                    stats["meanFrameMs"] = stats["frameTotalMs"].AsNumber / count;
                    stats["maxFrameMs"] = Math.Max(stats["maxFrameMs"].AsNumber, frameMs);
                    stats["peakMemoryMb"] = Math.Max(stats["peakMemoryMb"].AsNumber, UnityEngine.Profiling.Profiler.GetTotalAllocatedMemoryLong() / (1024d * 1024d));
                    stats["gcCollections"] = Math.Max(0, GC.CollectionCount(0) - _run["gcStart"].AsInt);
                }
                int remaining = _run["waitFrames"].AsInt;
                if (remaining > 0) { _run["waitFrames"] = remaining - 1; return; }
                int index = _run["step"].AsInt;
                var steps = _run["scenario"]["steps"].Array;
                if (index >= steps.Count) { Finish(_run["consoleErrors"].Array.Count == 0 ? "passed" : "failed", _run["consoleErrors"].Array.Count == 0 ? "Input-driven assertions completed." : "Runtime errors observed."); return; }
                var step = steps[index];
                switch (step["kind"].AsString)
                {
                    case "input":
                        var value = step["value"];
                        float[] values = value.IsArray ? value.Array.Select(v => (float)v.AsNumber).ToArray() : new[] { (float)value.AsNumber };
                        _input.Send(step["device"].AsString, step["control"].AsString, values);
                        _run["waitFrames"] = Math.Max(1, step["frames"].AsInt); break;
                    case "wait":
                        if (step["seconds"].IsNumber) _run["waitUntilUtc"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + Math.Max(0, Math.Min(600, step["seconds"].AsNumber)) * 1000;
                        else _run["waitFrames"] = Math.Max(1, step["frames"].AsInt);
                        break;
                    case "assert":
                        var observation = Observe(step, index); _run["observations"].Add(observation);
                        if (!observation["passed"].AsBool) { Finish("failed", "Assertion failed: " + observation["label"].AsString); return; }
                        break;
                    case "capture":
                        if (_run["captureFiles"].Array.Count >= 8) throw new InvalidOperationException("Maximum eight captures per scenario.");
                        _capturePending = true; _captureStarted = EditorApplication.timeSinceStartup;
                        string operation = _run["operationId"].AsString;
                        AutomationFrameCapture.Capture((bytes, error) => {
                            if (_run == null || _run["operationId"].AsString != operation || _run["status"].AsString != "running") return;
                            _capturePending = false;
                            if (error != null) { Finish("failed", error); return; }
                            int totalBytes = _run["captureBytes"].AsInt + bytes.Length;
                            if (totalBytes > 6 * 1024 * 1024) { Finish("failed", "Capture payload exceeds the six MiB scenario limit. Use fewer capture checkpoints."); return; }
                            _run["captureBytes"] = totalBytes;
                            string filename = operation + "-" + index + ".png";
                            File.WriteAllBytes(Path.Combine(AutomationStore.DirectoryPath, filename), bytes);
                            var item = JsonValue.NewObject(); item["file"] = filename; item["label"] = step["label"].AsStringOr("Game view");
                            _run["captureFiles"].Add(item); Persist();
                        });
                        break;
                    default: throw new ArgumentException("Unknown scenario step.");
                }
                _run["step"] = index + 1; Persist();
            }
            catch (Exception e) { Finish("failed", e.GetBaseException().Message); }
        }

        internal static JsonValue Observe(JsonValue step, int index)
        {
            var go = HierarchyHandlers.FindByHierarchyPath(step["target"].AsStringOr(""));
            string member = step["property"].AsStringOr("activeSelf");
            object actual = null;
            if (go != null) {
                if (member.StartsWith("ui:")) {
                    var document = go.GetComponent<UIDocument>();
                    var parts = member.Substring(3).Split('.');
                    var element = document?.rootVisualElement?.Q(parts[0]);
                    actual = parts.Length == 1 ? (object)(element != null) : parts[1] == "text" ? (element as TextElement)?.text : parts[1] == "visible" ? (object)(element != null && element.visible && element.resolvedStyle.display != DisplayStyle.None && element.worldBound.width > 0 && element.worldBound.height > 0) : null;
                } else {
                    object target = go;
                    string component = step["component"].AsString;
                    if (!string.IsNullOrEmpty(component)) target = go.GetComponent(AuthoringHandlers.ResolveType(component) ?? throw new ArgumentException("Component type not found."));
                    actual = target;
                    foreach (string part in member.Split('.')) {
                        if (actual == null) break;
                        var type = actual.GetType();
                        var field = type.GetField(part, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                        var property = type.GetProperty(part, BindingFlags.Public | BindingFlags.Instance);
                        actual = field != null ? field.GetValue(actual) : property != null && property.GetIndexParameters().Length == 0 ? property.GetValue(actual) : throw new ArgumentException("Observable member not found: " + part);
                    }
                }
            }
            string comparison = step["comparison"].AsStringOr("equals");
            string actualText = Convert.ToString(actual, CultureInfo.InvariantCulture);
            var expected = step["expected"];
            string expectedText = expected.IsString ? expected.AsString : expected.Serialize();
            bool passed;
            if (comparison == "exists") passed = actual != null;
            else if (comparison == "equals") passed = actual != null && string.Equals(actualText, expectedText, StringComparison.OrdinalIgnoreCase);
            else {
                if (actual == null || !double.TryParse(actualText, NumberStyles.Float, CultureInfo.InvariantCulture, out double n) || !expected.IsNumber) passed = false;
                else passed = comparison == "greater" ? n > expected.AsNumber : comparison == "less" && n < expected.AsNumber;
            }
            var result = JsonValue.NewObject(); result["step"] = index; result["label"] = step["label"].AsStringOr(step["target"].AsStringOr("") + "." + member);
            result["passed"] = passed; result["actual"] = actualText ?? "(missing)"; result["expected"] = expectedText;
            return result;
        }

        private static void OnLog(string message, string stack, LogType type)
        {
            if (_run == null || (type != LogType.Error && type != LogType.Exception && type != LogType.Assert)) return;
            if (_run["consoleErrors"].IsArray && _run["consoleErrors"].Array.Count < 50) _run["consoleErrors"].Add(message + "\n" + stack);
        }
        private static void Persist() {
            if (_run == null) return;
            SessionState.SetString(ActiveKey, _run.Serialize());
            AutomationStore.Save("play", _run["operationId"].AsString, _run);
        }
        private static void Finish(string status, string reason)
        {
            if (_run == null) return;
            _run["status"] = status; _run["reason"] = reason;
            _run["elapsedSeconds"] = (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _run["startedUtc"].AsNumber) / 1000d;
            _capturePending = false;
            try { _input?.Dispose(); } catch (Exception e) { _run["status"] = "interrupted"; _run["reason"] = "Input cleanup failed: " + e.Message; } finally { _input = null; }
            Persist();
            if (EditorApplication.isPlayingOrWillChangePlaymode) EditorApplication.isPlaying = false;
            else Restore();
        }
        private static void Restore()
        {
            if (_run == null) return;
            var setup = (_run["sceneSetup"].Array ?? new System.Collections.Generic.List<JsonValue>()).Select(s => new SceneSetup { path = s["path"].AsString, isLoaded = s["isLoaded"].AsBool, isActive = s["isActive"].AsBool }).ToArray();
            // Never overwrite changes made while a test was finishing.
            if (!Enumerable.Range(0, SceneManager.sceneCount).Any(i => SceneManager.GetSceneAt(i).isDirty)) {
                if (setup.Length > 0 && setup.All(s => !string.IsNullOrEmpty(s.path))) EditorSceneManager.RestoreSceneManagerSetup(setup);
            } else { _run["status"] = "interrupted"; _run["reason"] = "Scene layout restoration paused because unsaved changes appeared. Inputs were released; no scene was saved or discarded."; }
            _run["cleanupComplete"] = true; Persist();
            string previousWindow = _run["previousWindow"].AsString;
            if (!string.IsNullOrEmpty(previousWindow)) Resources.FindObjectsOfTypeAll<EditorWindow>().FirstOrDefault(w => w.GetType().FullName == previousWindow)?.Focus();
            SessionState.SetBool("UnityIDE.Automation.SeedActive", false);
            SessionState.EraseString(ActiveKey); _run = null; _frame = -1;
        }
        private static JsonValue Cancel(JsonValue p)
        {
            string id = p["operationId"].AsString;
            if (_run != null && _run["operationId"].AsString == id) Finish("cancelled", "Cancelled by task.");
            return PublicReport(RecoverReport(id), false);
        }
        internal static JsonValue Status(JsonValue p) => PublicReport(RecoverReport(p["operationId"].AsString), p["includeCaptures"].AsBool);
        private static JsonValue RecoverReport(string id)
        {
            var report = AutomationStore.Read("play", id);
            if ((_run == null || _run["operationId"].AsString != id) &&
                (report["status"].AsString == "queued" || report["status"].AsString == "running" || !report["cleanupComplete"].IsNull && !report["cleanupComplete"].AsBool)) {
                // SessionState is lost across editor restarts. Never resume a
                // durable acknowledgement without the live owner or stop Play
                // Mode that may now belong to the user.
                report["status"] = "interrupted";
                report["reason"] = "Playtest ownership was lost across an editor restart. Inspect scene state and rerun with a new operation ID.";
                report["cleanupComplete"] = !EditorApplication.isPlayingOrWillChangePlaymode;
                AutomationStore.Save("play", id, report);
            }
            return report;
        }
        private static JsonValue PublicReport(JsonValue run, bool captures)
        {
            var report = AutomationStore.Report(run["operationId"].AsString, run["status"].AsString, run["reason"].AsString);
            report["taskId"] = run["taskId"];
            report["observations"] = run["observations"]; report["consoleErrors"] = run["consoleErrors"]; report["elapsedSeconds"] = run["elapsedSeconds"];
            report["cleanupComplete"] = run["cleanupComplete"]; report["payloadHash"] = run["payloadHash"]; report["performance"] = run["performance"];
            if (captures) {
                var images = JsonValue.NewArray();
                foreach (var item in (run["captureFiles"].Array ?? new System.Collections.Generic.List<JsonValue>())) {
                    string file = Path.Combine(AutomationStore.DirectoryPath, Path.GetFileName(item["file"].AsString));
                    if (!File.Exists(file)) { report["status"] = "interrupted"; report["reason"] = "Captured frame missing."; continue; }
                    var image = JsonValue.NewObject(); image["label"] = item["label"]; image["mimeType"] = "image/png"; image["data"] = Convert.ToBase64String(File.ReadAllBytes(file)); images.Add(image);
                }
                report["captures"] = images;
            }
            return report;
        }
    }
}
