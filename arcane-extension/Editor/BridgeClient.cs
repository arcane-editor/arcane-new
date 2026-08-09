// BridgeClient.cs — the journal transport. Owns the background worker thread that
// waits for bridge.json, handshakes, then runs a single poll loop: drain the
// outbox into to-ide.jsonl, read new lines out of to-unity.jsonl, heartbeat.
//
// THREADING MODEL
//   * One background "worker" thread per BridgeClient lifetime. It does all file
//     I/O. Public Send(JsonValue) is thread-safe; callers are usually Unity hooks
//     on the main thread. Messages enqueue and the worker flushes them.
//   * Inbound lines are decoded on the worker thread, then dispatched: control
//     messages (playmode, step) and RPCs marshal Unity work via the
//     MainThreadDispatcher. We never touch Unity APIs on the worker thread.
//
// TRANSPORT
//   Two append-only newline-delimited JSON files under Library/ArcaneIDE/. Only
//   System.IO is involved, so this works at EVERY Unity API Compatibility Level —
//   unlike UnixDomainSocketEndPoint, which does not exist on the .NET Framework
//   profile and cannot be shimmed, reflected around, or polyfilled.
//
// SESSION MODEL
//   There is no socket, so "connected" is defined by session ids. bridge.json
//   carries the IDE's; connection_init echoes it back alongside Unity's own. A
//   domain reload restores both ids plus the read position from SessionState and
//   resumes mid-stream — no reconnect, and no disconnect flicker in the IDE,
//   which the socket transport could not avoid on every script recompile.

using System;
using System.Collections.Generic;
using System.Threading;
using UnityEngine;

namespace Arcane.Bridge
{
    internal sealed class BridgeClient
    {
        private const int PollActiveMs = 25;
        private const int PollIdleMs = 250;
        private const int IdleAfterMs = 3000;
        private const int HeartbeatMs = 2000;
        private const int DiscoveryPollMs = 1000;

        // Outbound queue (worker drains it). Guarded by _sendLock.
        private readonly Queue<string> _outbox = new Queue<string>();
        private readonly object _sendLock = new object();
        private readonly AutoResetEvent _sendSignal = new AutoResetEvent(false);

        private readonly string _projectRoot;
        private readonly Func<JsonValue> _connectionInitPayloadFactory;

        private Thread _worker;
        private volatile bool _running;
        private volatile bool _connected;

        private JournalWriter _writer;   // to-ide.jsonl — we are its only writer
        private JournalReader _reader;   // to-unity.jsonl
        private string _unitySessionId;
        private string _ideSessionId;    // the IDE session we handshook against
        private long _restoreOffset = -1;
        private long _restoreEpoch;
        private bool _handshakeSent;
        private bool _warnedUnwritable;
        private bool _warnedProtocol;

        /// <summary>
        /// Raised when the connection state flips. Always delivered on the MAIN
        /// THREAD (see SetConnected), so handlers may call Unity APIs freely.
        /// </summary>
        public event Action<bool> ConnectionStateChanged;

        public bool IsConnected { get { return _connected; } }

        /// <param name="projectRoot">Folder above Assets/ (for discovery).</param>
        /// <param name="connectionInitPayloadFactory">
        /// Builds the UnityProjectInfo payload for connection_init. Invoked on the
        /// MAIN THREAD (it reads PlayerSettings/Application), so the factory is run
        /// via the dispatcher right before the first send after each handshake.
        /// </param>
        public BridgeClient(string projectRoot, Func<JsonValue> connectionInitPayloadFactory)
        {
            _projectRoot = projectRoot;
            _connectionInitPayloadFactory = connectionInitPayloadFactory;
        }

        // ── Session persistence across domain reloads ────────────────────────

        /// <summary>
        /// Restore identity + read position captured before a domain reload. A null
        /// <paramref name="unitySessionId"/> means cold start, which is what
        /// triggers a fresh handshake. The epoch must come along with the offset:
        /// if the IDE rotated to-unity.jsonl while our AppDomain was down, the
        /// saved offset points into a journal that no longer exists.
        /// </summary>
        public void RestoreSession(string unitySessionId, string ideSessionId,
                                   long readOffset, long readEpoch)
        {
            _unitySessionId = unitySessionId;
            _ideSessionId = ideSessionId;
            _restoreOffset = readOffset;
            _restoreEpoch = readEpoch;
        }

        public string UnitySessionId { get { return _unitySessionId; } }
        public string HandshakenIdeSessionId { get { return _ideSessionId; } }
        public long ReadOffset { get { return _reader != null ? _reader.AckOffset : _restoreOffset; } }
        public long ReadEpoch { get { return _reader != null ? _reader.Epoch : _restoreEpoch; } }

        // ── Lifecycle ────────────────────────────────────────────────────────

        public void Start()
        {
            if (_running) return;
            _running = true;
            _worker = new Thread(WorkerLoop)
            {
                Name = "ArcaneBridgeClient",
                IsBackground = true, // never block editor shutdown
            };
            _worker.Start();
        }

        /// <summary>
        /// Stop the worker and close the journals. Called on beforeAssemblyReload
        /// and EditorApplication.quitting.
        /// </summary>
        public void Stop()
        {
            _running = false;
            _sendSignal.Set(); // wake the worker so it observes _running == false

            bool joined = true;
            var w = _worker;
            _worker = null;
            if (w != null && w.IsAlive)
            {
                try { joined = w.Join(1500); } catch { joined = false; }
            }

            // Best-effort clean close so the IDE sees a disconnect immediately
            // rather than waiting out the heartbeat timeout. Only safe once the
            // worker has actually joined — it owns the writer otherwise.
            if (joined)
            {
                try
                {
                    if (_writer != null)
                    {
                        _writer.Append(Protocol.Envelope(MsgType.Disconnect, JsonValue.NewObject()).Serialize());
                        _writer.Flush();
                    }
                }
                catch { /* the IDE falls back to the heartbeat timeout */ }

                CloseJournals();
            }
            SetConnected(false);
        }

        // ── Public send API (thread-safe) ────────────────────────────────────

        /// <summary>
        /// Queue a fully-formed envelope for delivery. Drops silently if the bridge
        /// is stopped. Serialization happens here so the worker only does I/O.
        /// </summary>
        public void Send(JsonValue envelope)
        {
            if (!_running || envelope == null) return;
            string line;
            try { line = envelope.Serialize(); }
            catch (Exception e)
            {
                Debug.LogWarning("[ArcaneBridge] failed to serialize outbound message: " + e.Message);
                return;
            }
            lock (_sendLock) { _outbox.Enqueue(line); }
            _sendSignal.Set();
        }

        // ── Worker thread ────────────────────────────────────────────────────

        private void WorkerLoop()
        {
            while (_running)
            {
                try
                {
                    BridgeDiscovery disc;
                    if (!Discovery.TryResolve(_projectRoot, out disc))
                    {
                        // No IDE has this project open. Not an error — just wait.
                        SetConnected(false);
                        CloseJournals();
                        if (!SleepInterruptible(DiscoveryPollMs)) return;
                        continue;
                    }

                    if (disc.ProtocolVersion > Discovery.ProtocolVersion)
                    {
                        WarnOnce(ref _warnedProtocol,
                            "[ArcaneBridge] The Arcane IDE speaks bridge protocol v" +
                            disc.ProtocolVersion + " but this package speaks v" +
                            Discovery.ProtocolVersion + ". Update the com.arcane.editor package.");
                        if (!SleepInterruptible(DiscoveryPollMs)) return;
                        continue;
                    }

                    if (!EnsureSession(disc))
                    {
                        if (!SleepInterruptible(DiscoveryPollMs)) return;
                        continue;
                    }

                    RunSession();
                }
                catch (ThreadInterruptedException)
                {
                    // shutting down
                }
                catch (Exception e)
                {
                    if (_running) Debug.LogWarning("[ArcaneBridge] journal error: " + e.Message);
                    CloseJournals();
                    SetConnected(false);
                    if (!SleepInterruptible(DiscoveryPollMs)) return;
                }
            }
            CloseJournals();
        }

        /// <summary>
        /// Open the journals and, when this is a cold start or the IDE session
        /// changed, perform the reset + handshake. Returns false to retry later.
        /// </summary>
        private bool EnsureSession(BridgeDiscovery disc)
        {
            bool freshHandshake = _unitySessionId == null || _ideSessionId != disc.IdeSessionId;

            if (_writer == null)
            {
                _writer = new JournalWriter(Discovery.ToIdeJournalPath(_projectRoot),
                                            Discovery.ToIdeAckPath(_projectRoot));
                if (!_writer.Open())
                {
                    WarnOnce(ref _warnedUnwritable,
                        "[ArcaneBridge] cannot write " + Discovery.BridgeDir(_projectRoot) +
                        " — the bridge stays idle until that path is writable.");
                    CloseJournals();
                    return false;
                }
            }

            if (_reader == null)
            {
                _reader = new JournalReader(Discovery.ToUnityJournalPath(_projectRoot),
                                            Discovery.ToUnityAckPath(_projectRoot));
                if (!_reader.TryOpen())
                {
                    // The IDE has not created its journal yet — retry shortly.
                    _reader = null;
                    return false;
                }
                if (freshHandshake) _reader.SeekToEnd();  // skip a previous session's messages
                else _reader.RestorePosition(_restoreOffset, _restoreEpoch);
            }

            if (freshHandshake)
            {
                _unitySessionId = Guid.NewGuid().ToString("N");
                _ideSessionId = disc.IdeSessionId;
                // Safe to truncate: the IDE writes nothing until connection_init
                // echoes its session id back, so nothing of ours is live in here.
                _writer.Truncate();
                DrainOutbox();
                _handshakeSent = false;
            }

            if (!_handshakeSent)
            {
                SendConnectionInit();
                _handshakeSent = true;
            }

            SetConnected(true);
            return true;
        }

        /// <summary>
        /// Single poll loop for one live session. Returns when the IDE session
        /// changes, the IDE closes, or we are told to stop.
        /// </summary>
        private void RunSession()
        {
            int lastHeartbeat = Environment.TickCount;
            int lastTraffic = Environment.TickCount;
            int lastDiscoveryCheck = Environment.TickCount;

            while (_running)
            {
                int now = Environment.TickCount;

                // Outbound.
                bool wrote = FlushOutbox();
                if (unchecked(now - lastHeartbeat) >= HeartbeatMs)
                {
                    lastHeartbeat = now;
                    EnqueueHeartbeat();
                    FlushOutbox();
                }
                _writer.MaybeRotate();

                // Inbound.
                List<string> lines = _reader.Poll();
                for (int i = 0; i < lines.Count; i++) HandleInbound(lines[i]);
                _reader.PublishAckIfNeeded(now);

                // Heartbeats deliberately do NOT reset the backoff — otherwise the
                // 2s heartbeat would pin polling at 25ms forever and idle CPU
                // would never drop.
                if (wrote || lines.Count > 0) lastTraffic = now;
                int interval = unchecked(now - lastTraffic) >= IdleAfterMs ? PollIdleMs : PollActiveMs;

                // Re-check bridge.json about once a second: an IDE restart mints a
                // new session id, and a closed IDE deletes the file entirely.
                if (unchecked(now - lastDiscoveryCheck) >= DiscoveryPollMs)
                {
                    lastDiscoveryCheck = now;
                    BridgeDiscovery disc;
                    if (!Discovery.TryResolve(_projectRoot, out disc) ||
                        disc.IdeSessionId != _ideSessionId)
                    {
                        SetConnected(false);
                        CloseJournals();
                        return; // WorkerLoop re-resolves and re-handshakes
                    }
                }

                if (!SleepInterruptible(interval)) return;
            }
        }

        /// <returns>true when at least one line was written.</returns>
        private bool FlushOutbox()
        {
            bool wrote = false;
            while (true)
            {
                string line;
                lock (_sendLock)
                {
                    if (_outbox.Count == 0) break;
                    line = _outbox.Dequeue();
                }
                if (!_writer.Append(line))
                    Debug.LogWarning("[ArcaneBridge] outbound message exceeds the 16 MB cap — dropped.");
                else
                    wrote = true;
            }
            if (wrote) _writer.Flush();
            return wrote;
        }

        private void DrainOutbox()
        {
            lock (_sendLock) { _outbox.Clear(); }
        }

        private void CloseJournals()
        {
            if (_reader != null)
            {
                _restoreOffset = _reader.AckOffset;
                _restoreEpoch = _reader.Epoch;
                _reader.Dispose();
                _reader = null;
            }
            if (_writer != null)
            {
                _writer.Dispose();
                _writer = null;
            }
            _handshakeSent = false;
        }

        // ── Outbound builders ────────────────────────────────────────────────

        private void SendConnectionInit()
        {
            // The payload reads PlayerSettings/Application → must run on the main
            // thread. Marshal it, then queue.
            JsonValue payload;
            try
            {
                payload = MainThreadDispatcher.EnqueueAndWait(_connectionInitPayloadFactory, 6000);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[ArcaneBridge] failed to build connection_init payload: " + e.Message);
                payload = JsonValue.NewObject();
            }
            // The handshake: the IDE writes nothing back until it sees its own
            // session id echoed here, which is what closes the startup race.
            payload["unitySessionId"] = _unitySessionId ?? "";
            payload["ideSessionId"] = _ideSessionId ?? "";
            Send(Protocol.Envelope(MsgType.ConnectionInit, payload));
        }

        private void EnqueueHeartbeat()
        {
            // Empty payload per spec. With no socket to close, a journal that stops
            // growing IS the disconnect signal, so this doubles as liveness.
            Send(Protocol.Envelope(MsgType.Heartbeat, JsonValue.NewObject()));
        }

        // ── Inbound handling ─────────────────────────────────────────────────

        private void HandleInbound(string json)
        {
            JsonValue msg = JsonValue.TryParse(json);
            if (msg == null || !msg.IsObject) return;

            string type = msg["type"].AsString;
            if (string.IsNullOrEmpty(type)) return;

            switch (type)
            {
                case MsgType.HeartbeatAck:
                    // Liveness only; nothing required.
                    break;

                case MsgType.RpcRequest:
                    // Dispatcher marshals the handler to the main thread and sends
                    // the rpc_response itself (via our thread-safe Send).
                    RpcDispatcher.Dispatch(msg, Send);
                    break;

                case MsgType.EnterPlaymode:
                case MsgType.ExitPlaymode:
                case MsgType.Pause:
                case MsgType.Step:
                    // Engine control — applied on the main thread by PlayStateHook.
                    PlayStateHook.HandleInboundControl(type);
                    break;

                default:
                    // Unknown inbound type — ignore (forward-compat).
                    break;
            }
        }

        // ── Helpers ──────────────────────────────────────────────────────────

        private void SetConnected(bool value)
        {
            if (_connected == value) return;
            _connected = value;

            var handler = ConnectionStateChanged;
            if (handler == null) return;

            // Raise on the MAIN THREAD. Subscribers legitimately want Unity APIs —
            // BridgeBootstrap reads SessionState to dedupe the "Connected" log
            // across domain reloads — and every Unity API throws off the main
            // thread ("GetBool can only be called from the main thread").
            //
            // Marshalling HERE rather than inside each subscriber makes the
            // guarantee a property of the event, so a future subscriber cannot
            // reintroduce this by forgetting the rule.
            //
            // Inline when already on the main thread (Stop() runs there, via
            // beforeAssemblyReload / quitting): the dispatcher is cleared during
            // shutdown, so a queued action would simply be dropped.
            if (MainThreadDispatcher.IsMainThread)
            {
                Raise(handler, value);
            }
            else
            {
                MainThreadDispatcher.Enqueue(() => Raise(handler, value));
            }
        }

        private static void Raise(Action<bool> handler, bool value)
        {
            try { handler(value); }
            catch (Exception e) { Debug.LogError("[ArcaneBridge] ConnectionStateChanged handler threw: " + e); }
        }

        private static void WarnOnce(ref bool flag, string message)
        {
            if (flag) return;
            flag = true;
            Debug.LogWarning(message);
        }

        /// <summary>Sleep in slices, returning false if asked to stop mid-wait.</summary>
        private bool SleepInterruptible(int totalMs)
        {
            const int slice = 25;
            int waited = 0;
            while (waited < totalMs)
            {
                if (!_running) return false;
                int chunk = Math.Min(slice, totalMs - waited);
                Thread.Sleep(chunk);
                waited += chunk;
            }
            return _running;
        }
    }
}
