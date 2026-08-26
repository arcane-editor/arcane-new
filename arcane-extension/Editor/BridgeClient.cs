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
//   Two append-only newline-delimited JSON files under Library/UnityIDE/. Only
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

namespace UnityIDE.Bridge
{
    /// <summary>Why the bridge is stopping — decides what the IDE is told.</summary>
    internal enum StopReason
    {
        /// <summary>Domain reload: the session resumes in the next AppDomain.</summary>
        Reload,
        /// <summary>The editor is closing: the session is over.</summary>
        Quit,
    }

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
        /// <summary>Set by Stop() before clearing _running; read by the worker as it unwinds.</summary>
        private StopReason _stopReason = StopReason.Quit;
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
                Name = "UnityIDEBridgeClient",
                IsBackground = true, // never block editor shutdown
            };
            _worker.Start();
        }

        /// <summary>
        /// Stop the worker and close the journals.
        ///
        /// The reason decides what the IDE is told, and the two cases are not
        /// interchangeable. A domain reload tears this AppDomain down and rebuilds
        /// it seconds later against the SAME session — announcing a disconnect for
        /// that dropped in-flight RPCs and drove a visible reconnect on every
        /// script recompile, which the journal transport exists to avoid.
        /// </summary>
        public void Stop(StopReason reason)
        {
            // Publish the reason BEFORE clearing _running: the worker writes the
            // farewell itself on its way out, and _running (volatile) is what
            // orders the two writes.
            //
            // The farewell CANNOT be written from here. WorkerLoop closes the
            // journals as it unwinds, and Join() by definition returns only after
            // that has happened — so a farewell appended after the join always
            // found a disposed writer and silently wrote nothing. That is why the
            // pre-existing clean-quit `disconnect` never actually reached the IDE.
            _stopReason = reason;
            _running = false;
            _sendSignal.Set(); // wake the worker so it observes _running == false

            var w = _worker;
            _worker = null;
            if (w != null && w.IsAlive)
            {
                try { w.Join(1500); } catch { /* worker is wedged; its handles die with the AppDomain */ }
            }

            // A reload keeps the session: reporting "disconnected" here would fire
            // ConnectionStateChanged and re-log the reconnect on every recompile.
            if (reason != StopReason.Reload) SetConnected(false);
        }

        /// <summary>
        /// Tell the IDE why the journal is about to go quiet. Runs on the WORKER
        /// thread as it unwinds, because the worker owns the writer.
        ///
        /// `reloading` is what keeps a recompile from looking like a death: the
        /// IDE widens its liveness deadline instead of dropping the session.
        /// Without it the only signal is silence, and silence past PEER_DEAD_MS
        /// is indistinguishable from Unity crashing.
        /// </summary>
        private void WriteFarewell()
        {
            if (_writer == null) return;
            try
            {
                string type = _stopReason == StopReason.Reload ? MsgType.Reloading : MsgType.Disconnect;
                _writer.Append(Protocol.Envelope(type, JsonValue.NewObject()).Serialize());
                _writer.Flush();
            }
            catch { /* the IDE falls back to the heartbeat timeout */ }
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
                Debug.LogWarning("[UnityIDEBridge] failed to serialize outbound message: " + e.Message);
                return;
            }
            lock (_sendLock) { _outbox.Enqueue(line); }
            _sendSignal.Set();
        }

        // ── Worker thread ────────────────────────────────────────────────────

        private void WorkerLoop()
        {
            // try/finally, and `break` rather than `return`, so EVERY exit path
            // runs the farewell before the journals close. The farewell has to
            // happen here because this thread owns the writer — see Stop().
            try
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
                            if (!SleepInterruptible(DiscoveryPollMs)) break;
                            continue;
                        }

                        if (disc.ProtocolVersion > Discovery.ProtocolVersion)
                        {
                            WarnOnce(ref _warnedProtocol,
                                "[UnityIDEBridge] The UnityIDE speaks bridge protocol v" +
                                disc.ProtocolVersion + " but this package speaks v" +
                                Discovery.ProtocolVersion + ". Update the com.unityide.editor package.");
                            if (!SleepInterruptible(DiscoveryPollMs)) break;
                            continue;
                        }

                        if (!EnsureSession(disc))
                        {
                            if (!SleepInterruptible(DiscoveryPollMs)) break;
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
                        if (_running) Debug.LogWarning("[UnityIDEBridge] journal error: " + e.Message);
                        CloseJournals();
                        SetConnected(false);
                        if (!SleepInterruptible(DiscoveryPollMs)) break;
                    }
                }
            }
            finally
            {
                FlushOutboxFinal();
                WriteFarewell();
                CloseJournals();
            }
        }

        /// <summary>
        /// Final outbox drain on the way out, IGNORING _running. FlushOutbox
        /// stops at _running == false, so a message enqueued by the main thread
        /// just before a reload shutdown (the compilation_finished of a
        /// SUCCESSFUL compile — success always triggers a reload) was silently
        /// discarded, and the IDE's compile gate never learned the compile
        /// worked. Safe: this runs on the worker as it unwinds, strictly before
        /// Stop()'s Join returns, so the next AppDomain does not exist yet and
        /// cannot own the journal.
        /// </summary>
        private void FlushOutboxFinal()
        {
            if (_writer == null) return;
            try
            {
                bool wrote = false;
                for (;;)
                {
                    string line;
                    lock (_sendLock)
                    {
                        if (_outbox.Count == 0) break;
                        line = _outbox.Dequeue();
                    }
                    if (_writer.Append(line)) wrote = true;
                }
                if (wrote) _writer.Flush();
            }
            catch { /* best-effort — the journal may be mid-teardown */ }
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
                        "[UnityIDEBridge] cannot write " + Discovery.BridgeDir(_projectRoot) +
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
                string unityId = Guid.NewGuid().ToString("N");
                // Safe to truncate: the IDE writes nothing until connection_init
                // echoes its session id back, so nothing of ours is live in here.
                _writer.Truncate();
                DrainOutbox();

                // Commit the ids ONLY once the handshake is actually queued.
                // Committing first and failing to send would make the next attempt
                // compute freshHandshake == false and resume a session the IDE has
                // never heard of.
                if (!SendConnectionInit(unityId, disc.IdeSessionId)) return false;
                _unitySessionId = unityId;
                _ideSessionId = disc.IdeSessionId;
            }
            // A warm resume — same IDE session, new AppDomain after a domain
            // reload — deliberately does NOT re-announce. The IDE never dropped
            // us, and building the payload needs a main-thread round trip at the
            // exact moment the main thread is busiest.

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
            // `_running` is re-checked every iteration, not just on entry: a worker
            // that outlives its Stop() must never append to a journal the next
            // AppDomain has already claimed as its own.
            while (_running)
            {
                string line;
                lock (_sendLock)
                {
                    if (_outbox.Count == 0) break;
                    line = _outbox.Dequeue();
                }
                if (!_writer.Append(line))
                    Debug.LogWarning("[UnityIDEBridge] outbound message exceeds the 16 MB cap — dropped.");
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
        }

        // ── Outbound builders ────────────────────────────────────────────────

        /// <returns>
        /// false when the handshake could not be built — the caller must NOT commit
        /// the session ids, so the next attempt retries as a fresh handshake.
        /// </returns>
        private bool SendConnectionInit(string unitySessionId, string ideSessionId)
        {
            // The payload reads PlayerSettings/Application → must run on the main
            // thread. Marshal it, then queue.
            JsonValue payload;
            try
            {
                payload = MainThreadDispatcher.EnqueueAndWait(_connectionInitPayloadFactory, 6000);
            }
            catch (OperationCanceledException)
            {
                // Teardown began while we were waiting. Announcing now would write
                // into a journal the next AppDomain is about to take over.
                return false;
            }
            catch (Exception e)
            {
                Debug.LogWarning("[UnityIDEBridge] failed to build connection_init payload: " + e.Message);
                payload = JsonValue.NewObject();
            }
            // The handshake: the IDE writes nothing back until it sees its own
            // session id echoed here, which is what closes the startup race.
            payload["unitySessionId"] = unitySessionId ?? "";
            payload["ideSessionId"] = ideSessionId ?? "";
            Send(Protocol.Envelope(MsgType.ConnectionInit, payload));
            return true;
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
            catch (Exception e) { Debug.LogError("[UnityIDEBridge] ConnectionStateChanged handler threw: " + e); }
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
