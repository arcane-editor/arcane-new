// BridgeClient.cs — the socket client. Owns the background worker thread that
// resolves the socket, connects, sends connection_init, runs the read loop, and
// pushes queued outbound frames. Reconnects with capped exponential backoff.
//
// THREADING MODEL
//   * One background "worker" thread per BridgeClient lifetime. It does the
//     blocking connect, the blocking socket reads, and writes (under a lock).
//   * Public Send(JsonValue) is thread-safe; callers are usually Unity hooks on
//     the main thread. Messages enqueue and the worker flushes them.
//   * Inbound frames are decoded on the worker thread, then dispatched: control
//     messages (playmode, step) and RPCs marshal Unity work via the
//     MainThreadDispatcher. We never touch Unity APIs on the worker thread.
//
// SOCKET TYPE
//   System.Net.Sockets.Socket + UnixDomainSocketEndPoint. This REQUIRES the
//   project's API Compatibility Level = .NET Standard 2.1 (Unity 2021.2+). On the
//   .NET Framework profile the type is missing and construction throws — we catch
//   that once and surface a single friendly Debug.LogWarning (see TryCreateSocket).

using System;
using System.Net.Sockets;
using System.Threading;
using UnityEngine;

namespace Arcane.Bridge
{
    internal sealed class BridgeClient
    {
        // Tunables (seconds → ms where noted). Backoff: 1→2→4→8 capped at 8s.
        private const int HeartbeatIntervalMs = 5000;
        private const int DiscoveryPollIntervalMs = 2000;
        private const int ConnectTimeoutMs = 4000;
        private const int ReadChunkSize = 16 * 1024;
        private static readonly int[] BackoffSecs = { 1, 2, 4, 8 };

        // Outbound queue (worker drains it). Guarded by _sendLock + signaled by
        // _sendSignal so the worker can block instead of busy-spinning.
        private readonly System.Collections.Generic.Queue<byte[]> _outbox =
            new System.Collections.Generic.Queue<byte[]>();
        private readonly object _sendLock = new object();
        private readonly AutoResetEvent _sendSignal = new AutoResetEvent(false);

        private readonly string _projectRoot;
        private readonly Func<JsonValue> _connectionInitPayloadFactory;

        private Thread _worker;
        private volatile bool _running;
        private volatile bool _connected;
        private Socket _socket; // current connection (null when disconnected)
        private bool _warnedUnsupported; // emit the .NET-profile warning at most once

        /// <summary>Raised (on the worker thread) when the connection state flips.</summary>
        public event Action<bool> ConnectionStateChanged;

        public bool IsConnected => _connected;

        /// <param name="projectRoot">Folder above Assets/ (for discovery).</param>
        /// <param name="connectionInitPayloadFactory">
        /// Builds the UnityProjectInfo payload for connection_init. Invoked on the
        /// MAIN THREAD (it reads PlayerSettings/Application), so the factory is run
        /// via the dispatcher right before the first send after each connect.
        /// </param>
        public BridgeClient(string projectRoot, Func<JsonValue> connectionInitPayloadFactory)
        {
            _projectRoot = projectRoot;
            _connectionInitPayloadFactory = connectionInitPayloadFactory;
        }

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
        /// Stop the worker and close the socket. Called on beforeAssemblyReload and
        /// EditorApplication.quitting. Joins briefly so we don't leak the thread or
        /// the socket file descriptor across a domain reload.
        /// </summary>
        public void Stop()
        {
            _running = false;
            _sendSignal.Set(); // wake the worker so it can observe _running == false
            try { _socket?.Close(); } catch { /* ignore */ }
            _socket = null;

            var w = _worker;
            _worker = null;
            if (w != null && w.IsAlive)
            {
                // Short join — the worker checks _running between blocking ops.
                try { w.Join(1500); } catch { /* ignore */ }
            }
            SetConnected(false);
        }

        // ── Public send API (thread-safe) ────────────────────────────────────

        /// <summary>
        /// Queue a fully-formed envelope for delivery. Drops silently if the bridge
        /// is stopped. Frame encoding happens here so the worker only does I/O.
        /// </summary>
        public void Send(JsonValue envelope)
        {
            if (!_running || envelope == null) return;
            byte[] frame;
            try
            {
                frame = Framing.Encode(envelope.Serialize());
            }
            catch (Framing.InvalidOperationExceptionFrameTooLarge e)
            {
                Debug.LogWarning("[ArcaneBridge] " + e.Message + " — message dropped.");
                return;
            }
            lock (_sendLock)
            {
                _outbox.Enqueue(frame);
            }
            _sendSignal.Set();
        }

        // ── Worker thread ────────────────────────────────────────────────────

        private void WorkerLoop()
        {
            int attempt = 0;
            while (_running)
            {
                Socket sock = null;
                try
                {
                    string socketPath = ResolveSocketPathBlocking();
                    if (socketPath == null) return; // _running went false while polling

                    // Capability gate: bail to a friendly warning if the runtime
                    // lacks UnixDomainSocketEndPoint (.NET Framework profile). We
                    // check BEFORE touching any code that statically references the
                    // type, so we control the message instead of catching an opaque
                    // TypeLoadException deeper in.
                    if (!UnixSocketsSupported())
                    {
                        WarnUnsupportedOnce(null);
                        SleepBackoff(BackoffSecs[BackoffSecs.Length - 1]);
                        continue;
                    }

                    sock = TryCreateSocket();
                    if (sock == null)
                    {
                        // Socket construction failed for another reason — back off
                        // the maximum and retry later.
                        SleepBackoff(BackoffSecs[BackoffSecs.Length - 1]);
                        continue;
                    }

                    ConnectBlocking(sock, socketPath);
                    _socket = sock;
                    attempt = 0; // reset backoff on a successful connect
                    SetConnected(true);

                    // connection_init MUST be the first message on the wire.
                    SendConnectionInit();

                    // Drive the connection until it drops or we're told to stop.
                    RunConnection(sock);
                }
                catch (ThreadInterruptedException)
                {
                    // shutting down
                }
                catch (Exception e)
                {
                    if (_running)
                        Debug.LogWarning("[ArcaneBridge] connection error: " + e.Message);
                }
                finally
                {
                    SetConnected(false);
                    try { sock?.Close(); } catch { /* ignore */ }
                    if (_socket == sock) _socket = null;
                    DrainOutbox(); // discard stale frames so they don't leak to the next session
                }

                if (!_running) break;

                // Reconnect with capped exponential backoff.
                int secs = BackoffSecs[Math.Min(attempt, BackoffSecs.Length - 1)];
                attempt++;
                SleepBackoff(secs);
            }
        }

        /// <summary>
        /// Poll discovery until a socket path is available (the IDE may not have
        /// opened the project yet). Returns null if we're asked to stop meanwhile.
        /// </summary>
        private string ResolveSocketPathBlocking()
        {
            while (_running)
            {
                if (Discovery.TryResolve(_projectRoot, out var disc) &&
                    !string.IsNullOrEmpty(disc.SocketPath))
                {
                    // If the discovery file gives a path, prefer it. The fallback
                    // path is also returned by TryResolve, so we always get one;
                    // we still poll-wait for the SOCKET FILE to exist to avoid a
                    // guaranteed-failed connect storm before the IDE binds it.
                    if (disc.FromFile || System.IO.File.Exists(disc.SocketPath))
                        return disc.SocketPath;
                }
                // Sleep in small slices so Stop() is responsive.
                if (!SleepInterruptible(DiscoveryPollIntervalMs)) return null;
            }
            return null;
        }

        /// <summary>
        /// True if the runtime exposes System.Net.Sockets.UnixDomainSocketEndPoint
        /// (present only on the .NET Standard 2.1 API profile, Unity 2021.2+).
        /// Resolved by NAME via reflection so this method itself contains no static
        /// reference to the type — that keeps its JIT safe even when the type is
        /// absent (a direct reference would throw TypeLoadException on JIT). The #1
        /// real-world failure mode; we detect it up front and degrade gracefully.
        /// </summary>
        private static bool UnixSocketsSupported()
        {
            try
            {
                // The type lives in System.Net.Primitives / mscorlib depending on
                // the profile; Type.GetType with the simple assembly-qualified name
                // resolves it on .NET Standard 2.1 and returns null otherwise.
                Type t = Type.GetType("System.Net.Sockets.UnixDomainSocketEndPoint, System.Net.Sockets")
                         ?? Type.GetType("System.Net.Sockets.UnixDomainSocketEndPoint, System.Net.Primitives")
                         ?? Type.GetType("System.Net.Sockets.UnixDomainSocketEndPoint");
                return t != null;
            }
            catch
            {
                return false;
            }
        }

        private void WarnUnsupportedOnce(Exception e)
        {
            if (_warnedUnsupported) return;
            _warnedUnsupported = true;
            string detail = e != null ? " Original error: " + e.Message : "";
            Debug.LogWarning(
                "[ArcaneBridge] Unix domain sockets are unavailable in this project's scripting runtime. " +
                "The Arcane IDE bridge requires API Compatibility Level = .NET Standard 2.1 " +
                "(Project Settings → Player → Other Settings → Configuration). The bridge is disabled " +
                "until that is set." + detail);
        }

        /// <summary>
        /// Create a Unix-domain stream socket. Returns null on failure (warning
        /// once). Assumes <see cref="UnixSocketsSupported"/> already passed.
        /// </summary>
        private Socket TryCreateSocket()
        {
            try
            {
                return new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            }
            catch (Exception e)
            {
                WarnUnsupportedOnce(e);
                return null;
            }
        }

        private void ConnectBlocking(Socket sock, string socketPath)
        {
            var endpoint = new UnixDomainSocketEndPoint(socketPath);
            // BeginConnect + wait gives us a connect timeout (Socket.Connect blocks
            // indefinitely otherwise if the IDE is mid-startup).
            var ar = sock.BeginConnect(endpoint, null, null);
            if (!ar.AsyncWaitHandle.WaitOne(ConnectTimeoutMs))
                throw new TimeoutException("connect timed out: " + socketPath);
            sock.EndConnect(ar);
        }

        /// <summary>
        /// Reader + writer + heartbeat for one live connection. The READ is blocking;
        /// the WRITE flush and HEARTBEAT are driven from a separate writer thread so
        /// a quiet inbound stream never delays outbound traffic.
        /// </summary>
        private void RunConnection(Socket sock)
        {
            // Writer/heartbeat pump on its own thread, scoped to this connection.
            var stopWriter = new ManualResetEventSlim(false);
            var writer = new Thread(() => WriterLoop(sock, stopWriter))
            {
                Name = "ArcaneBridgeWriter",
                IsBackground = true,
            };
            writer.Start();

            try
            {
                var reader = new FrameReader();
                var chunk = new byte[ReadChunkSize];
                while (_running)
                {
                    int n;
                    try
                    {
                        n = sock.Receive(chunk);
                    }
                    catch (SocketException) { break; }
                    catch (ObjectDisposedException) { break; }

                    if (n <= 0) break; // peer closed

                    reader.Append(chunk, n);
                    if (reader.Overflowed)
                    {
                        Debug.LogWarning("[ArcaneBridge] inbound frame exceeded 16 MB — dropping connection.");
                        break;
                    }

                    foreach (var json in reader.DrainAll())
                        HandleInbound(json);
                }
            }
            finally
            {
                stopWriter.Set();
                try { if (writer.IsAlive) writer.Join(500); } catch { /* ignore */ }
            }
        }

        private void WriterLoop(Socket sock, ManualResetEventSlim stop)
        {
            var waits = new WaitHandle[] { stop.WaitHandle, _sendSignal };
            long lastHeartbeat = Environment.TickCount;

            while (_running && !stop.IsSet)
            {
                // Flush anything queued.
                FlushOutbox(sock);

                // Heartbeat every 5s.
                long now = Environment.TickCount;
                if (now - lastHeartbeat >= HeartbeatIntervalMs)
                {
                    lastHeartbeat = now;
                    EnqueueHeartbeat();
                    FlushOutbox(sock);
                }

                // Wait until: a new message is queued, we're told to stop, or the
                // heartbeat interval elapses — whichever comes first.
                WaitHandle.WaitAny(waits, HeartbeatIntervalMs);
            }
        }

        private void FlushOutbox(Socket sock)
        {
            while (true)
            {
                byte[] frame;
                lock (_sendLock)
                {
                    if (_outbox.Count == 0) return;
                    frame = _outbox.Dequeue();
                }
                try
                {
                    int sent = 0;
                    while (sent < frame.Length)
                        sent += sock.Send(frame, sent, frame.Length - sent, SocketFlags.None);
                }
                catch (SocketException) { return; }      // connection died; reader will exit
                catch (ObjectDisposedException) { return; }
            }
        }

        private void DrainOutbox()
        {
            lock (_sendLock) { _outbox.Clear(); }
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
            Send(Protocol.Envelope(MsgType.ConnectionInit, payload));
        }

        private void EnqueueHeartbeat()
        {
            // Empty payload per spec; the IDE replies heartbeat_ack.
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
            try { ConnectionStateChanged?.Invoke(value); }
            catch (Exception e) { Debug.LogError("[ArcaneBridge] ConnectionStateChanged handler threw: " + e); }
        }

        private void SleepBackoff(int seconds) => SleepInterruptible(seconds * 1000);

        /// <summary>Sleep in slices, returning false if asked to stop mid-wait.</summary>
        private bool SleepInterruptible(int totalMs)
        {
            const int slice = 100;
            int waited = 0;
            while (waited < totalMs)
            {
                if (!_running) return false;
                Thread.Sleep(Math.Min(slice, totalMs - waited));
                waited += slice;
            }
            return _running;
        }
    }
}
