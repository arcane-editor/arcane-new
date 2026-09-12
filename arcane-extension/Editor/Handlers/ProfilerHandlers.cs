// Unity owns capture and player transport; the IDE owns offline analysis.
// Bulk data never enters the bridge journal. Completed gzip chunks are published
// atomically and removed only after the IDE has committed them to its database.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.Profiling;
using UnityEditorInternal;
using UnityEngine;

namespace UnityIDE.Bridge
{
    internal static class ProfilerHandlers
    {
        const int ChunkSamples = 2048;
        const int MaxPending = 32;
        static string _id, _directory, _error;
        static bool _recording, _previousEnabled;
        static int _target, _previousTarget, _nextFrame, _sequence, _dropped, _stopFrame = -1;
        static long _bytes, _limit = 2L * 1024 * 1024 * 1024;
        static IEnumerator _export;
        static readonly object Gate = new object();
        static readonly List<int> Ready = new List<int>();
        static Task _writer;
        static JsonValue _metadata;
        const string SessionKey = "UnityIDE.Profiler.Capture";

        public static void Register(BridgeClient client)
        {
            Recover();
            RpcDispatcher.Register("getProfilerCapabilities", Capabilities);
            RpcDispatcher.Register("startProfilerCapture", Start);
            RpcDispatcher.Register("stopProfilerCapture", Stop);
            RpcDispatcher.Register("getProfilerStatus", Status);
            RpcDispatcher.Register("ackProfilerChunks", Ack);
        }
        static JsonValue Capabilities(JsonValue p)
        {
            var r = JsonValue.NewObject();
            r["unityVersion"] = Application.unityVersion;
            r["cpu"] = true;
            r["gpuNote"] = "GPU measurements depend on the target graphics API and Unity profiler support.";
            var targets = JsonValue.NewArray();
            foreach (int id in ProfilerDriver.GetAvailableProfilers())
            {
                var t = JsonValue.NewObject(); t["id"] = id;
                t["label"] = ProfilerDriver.GetConnectionIdentifier(id); targets.Add(t);
            }
            r["targets"] = targets;
            r["selectedTarget"] = ProfilerDriver.connectedProfiler;
            return r;
        }
        static JsonValue Start(JsonValue p)
        {
            if (_recording || _export != null || (_writer != null && !_writer.IsCompleted)) throw new InvalidOperationException("Finish the current capture first.");
            lock (Gate) { if (Ready.Count != 0) throw new InvalidOperationException("Wait for the previous capture to finish saving."); }
            _target = p.ContainsKey("target") ? (int)p["target"].AsNumber : ProfilerDriver.connectedProfiler;
            bool found = false;
            foreach (int id in ProfilerDriver.GetAvailableProfilers()) if (id == _target) found = true;
            if (!found) throw new InvalidOperationException("The selected Unity profiler target is no longer connected.");
            _previousTarget = ProfilerDriver.connectedProfiler;
            ProfilerDriver.connectedProfiler = _target;
            _previousEnabled = ProfilerDriver.enabled;
            _id = Guid.NewGuid().ToString("N");
            _directory = Path.Combine(Path.GetDirectoryName(Application.dataPath), "Library", "UnityIDE", "Profiler", _id);
            Directory.CreateDirectory(_directory);
            _sequence = 0; _dropped = 0; _bytes = 0; _error = null; _stopFrame = -1;
            _limit = p.ContainsKey("limitBytes") ? (long)p["limitBytes"].AsNumber : 2L * 1024 * 1024 * 1024;
            _limit = Math.Max(16L * 1024 * 1024, Math.Min(_limit, 16L * 1024 * 1024 * 1024));
            _metadata = JsonValue.NewObject();
            _metadata["id"] = _id; _metadata["unityVersion"] = Application.unityVersion;
            _metadata["target"] = ProfilerDriver.GetConnectionIdentifier(_target);
            _metadata["capturedAt"] = DateTime.UtcNow.ToString("o");
            _metadata["project"] = Application.productName;
            _metadata["deepProfiling"] = ProfilerDriver.deepProfiling;
            _metadata["limitBytes"] = (double)_limit;
            File.WriteAllText(Path.Combine(_directory, "metadata.json"), _metadata.ToString());
            SessionState.SetString(SessionKey, _id);
            _nextFrame = ProfilerDriver.lastFrameIndex + 1;
            ProfilerDriver.enabled = true; _recording = true;
            return Status(p);
        }
        static JsonValue Stop(JsonValue p)
        {
            if (_recording) _stopFrame = ProfilerDriver.lastFrameIndex;
            _recording = false;
            if (ProfilerDriver.connectedProfiler == _target && ProfilerDriver.enabled) ProfilerDriver.enabled = _previousEnabled;
            return Status(p);
        }
        static JsonValue Status(JsonValue p)
        {
            var r = JsonValue.NewObject(); r["captureId"] = _id ?? "";
            r["recording"] = _recording; r["saving"] = _export != null || _nextFrame <= _stopFrame || (_writer != null && !_writer.IsCompleted);
            r["metadata"] = _metadata ?? JsonValue.NewObject(); r["error"] = _error ?? "";
            r["droppedFrames"] = _dropped; r["bytes"] = (double)_bytes;
            var ready = JsonValue.NewArray(); lock (Gate) foreach (int index in Ready) ready.Add(index);
            r["chunks"] = ready; return r;
        }
        static JsonValue Ack(JsonValue p)
        {
            if (p["captureId"].AsString != _id) throw new InvalidOperationException("Capture changed.");
            foreach (JsonValue value in p["chunks"].Array)
            {
                int index = (int)value.AsNumber;
                bool removed; lock (Gate) removed = Ready.Remove(index);
                if (removed) { try { File.Delete(Path.Combine(_directory, index + ".json.gz")); } catch { } }
            }
            return Status(p);
        }
        static void Recover()
        {
            if (_id != null) return;
            string id = SessionState.GetString(SessionKey, "");
            Guid parsed;
            if (!Guid.TryParseExact(id, "N", out parsed)) return;
            string directory = Path.Combine(Path.GetDirectoryName(Application.dataPath), "Library", "UnityIDE", "Profiler", id);
            try
            {
                _metadata = JsonValue.Parse(File.ReadAllText(Path.Combine(directory, "metadata.json")));
                _id = id; _directory = directory;
                foreach (string file in Directory.GetFiles(directory, "*.json.gz"))
                {
                    int sequence;
                    if (int.TryParse(Path.GetFileName(file).Replace(".json.gz", ""), out sequence) && sequence >= 0)
                    { Ready.Add(sequence); _sequence = Math.Max(_sequence, sequence + 1); _bytes += new FileInfo(file).Length; }
                }
                Ready.Sort();
                _error = "Capture interrupted by an Editor reload. Completed chunks were recovered; start a new capture to continue.";
                _target = _previousTarget = ProfilerDriver.connectedProfiler;
                _previousEnabled = ProfilerDriver.enabled;
            }
            catch (Exception e) { _error = "Capture recovery failed: " + e.Message; }
        }
        public static void Tick()
        {
            if (_id == null) return;
            if (_writer != null && !_writer.IsCompleted) return;
            if (_writer != null && _writer.IsFaulted) { _error = _writer.Exception.GetBaseException().Message; Stop(JsonValue.Null); _stopFrame = -1; _writer = null; DisposeExport(); return; }
            if (_bytes >= _limit) { _error = "Recording size limit reached. Completed data is preserved."; Stop(JsonValue.Null); _stopFrame = -1; DisposeExport(); return; }
            lock (Gate) { if (Ready.Count >= MaxPending) return; }
            if ((_recording || _export != null || _nextFrame <= _stopFrame) && ProfilerDriver.connectedProfiler != _target) { _error = "Unity profiler target changed. Recording ended."; Stop(JsonValue.Null); _stopFrame = -1; DisposeExport(); return; }
            try
            {
                if (_export == null && (_recording || _nextFrame <= _stopFrame))
                {
                    if (_nextFrame < ProfilerDriver.firstFrameIndex) { _dropped += ProfilerDriver.firstFrameIndex - _nextFrame; _nextFrame = ProfilerDriver.firstFrameIndex; }
                    if (!_recording && _nextFrame > _stopFrame) return;
                    if (_nextFrame > ProfilerDriver.lastFrameIndex) return;
                    _export = ExportFrame(_nextFrame++);
                }
                var budget = Stopwatch.StartNew();
                while (_export != null && budget.ElapsedMilliseconds < 4)
                {
                    if (!_export.MoveNext()) { DisposeExport(); break; }
                    if (_writer != null && !_writer.IsCompleted) break;
                }
            }
            catch (Exception e) { _error = e.Message; Stop(JsonValue.Null); _stopFrame = -1; DisposeExport(); }
        }
        static void DisposeExport() { var disposable = _export as IDisposable; if (disposable != null) disposable.Dispose(); _export = null; }
        public static void Uninstall()
        {
            if (_id == null) return;
            Stop(JsonValue.Null); DisposeExport();
            if (_writer != null) { try { _writer.Wait(1500); } catch { } }
            if (ProfilerDriver.connectedProfiler == _target) ProfilerDriver.connectedProfiler = _previousTarget;
        }
        static IEnumerator ExportFrame(int frame)
        {
            for (int thread = 0; thread < 1024; ++thread)
            {
                using (var view = ProfilerDriver.GetRawFrameDataView(frame, thread))
                {
                    if (!view.valid) break;
                    var parents = new Stack<KeyValuePair<int, int>>();
                    var samples = JsonValue.NewArray();
                    for (int i = 0; i < view.sampleCount; ++i)
                    {
                        while (parents.Count > 0 && parents.Peek().Value < i) parents.Pop();
                        var sample = JsonValue.NewObject();
                        sample["id"] = i; sample["parent"] = parents.Count == 0 ? -1 : parents.Peek().Key;
                        sample["depth"] = parents.Count; sample["name"] = view.GetSampleName(i);
                        sample["startMs"] = view.GetSampleStartTimeMs(i) - view.frameStartTimeMs;
                        sample["durationMs"] = view.GetSampleTimeMs(i);
                        sample["category"] = (int)view.GetSampleCategoryIndex(i);
                        if (view.GetSampleName(i) == "GC.Alloc" && view.GetSampleMetadataCount(i) > 0) sample["allocationBytes"] = (double)view.GetSampleMetadataAsLong(i, 0);
                        var stack = new List<ulong>(); view.GetSampleCallstack(i, stack);
                        var locations = JsonValue.NewArray();
                        foreach (ulong address in stack)
                        {
                            var method = view.ResolveMethodInfo(address);
                            var location = JsonValue.NewObject(); location["method"] = method.methodName ?? "";
                            location["path"] = method.sourceFileName ?? ""; location["line"] = method.sourceFileLine;
                            locations.Add(location);
                        }
                        sample["callstack"] = locations;
                        samples.Add(sample);
                        int children = view.GetSampleChildrenCountRecursive(i);
                        if (children > 0) parents.Push(new KeyValuePair<int, int>(i, i + children));
                        if (samples.Count >= ChunkSamples || i == view.sampleCount - 1)
                        {
                            var chunk = JsonValue.NewObject(); chunk["frame"] = frame; chunk["thread"] = thread;
                            chunk["threadName"] = view.threadGroupName + "/" + view.threadName;
                            chunk["durationMs"] = view.frameTimeMs;
                            if (view.frameGpuTimeMs > 0) chunk["gpuMs"] = view.frameGpuTimeMs;
                            chunk["samples"] = samples; chunk["counters"] = Counters(view);
                            Publish(chunk.ToString()); samples = JsonValue.NewArray();
                            yield return null;
                            while (_writer != null && !_writer.IsCompleted) yield return null;
                        }
                        else if (i % 128 == 0) yield return null;
                    }
                }
            }
        }
        static JsonValue Counters(RawFrameDataView view)
        {
            var counters = JsonValue.NewArray();
            var markers = new List<FrameDataView.MarkerInfo>(); view.GetMarkers(markers);
            foreach (var marker in markers)
            {
                if (!view.HasCounterValue(marker.id)) continue;
                var c = JsonValue.NewObject(); c["name"] = marker.name; c["category"] = (int)marker.category;
                // Counter storage is typed. Do not reinterpret a float counter as an integer.
                var info = view.GetMarkerMetadataInfo(marker.id);
                if (info.Length == 0) continue;
                int type = (int)info[0].type;
                c["unit"] = (int)info[0].unit;
                c["value"] = type == 0 ? view.GetCounterValueAsInt(marker.id) : type == 1 ? (uint)view.GetCounterValueAsInt(marker.id) : type == 4 ? view.GetCounterValueAsFloat(marker.id) : type == 5 ? view.GetCounterValueAsDouble(marker.id) : type == 3 ? (double)(ulong)view.GetCounterValueAsLong(marker.id) : (double)view.GetCounterValueAsLong(marker.id);
                counters.Add(c);
            }
            return counters;
        }
        static void Publish(string json)
        {
            int sequence = _sequence++; string directory = _directory;
            _writer = Task.Run(() =>
            {
                string path = Path.Combine(directory, sequence + ".json.gz");
                using (var stream = File.Create(path + ".tmp"))
                using (var gzip = new GZipStream(stream, System.IO.Compression.CompressionLevel.Fastest))
                using (var writer = new StreamWriter(gzip)) writer.Write(json);
                File.Move(path + ".tmp", path);
                long length = new FileInfo(path).Length;
                lock (Gate) { _bytes += length; Ready.Add(sequence); }
            });
        }
    }
}
