// MainThreadDispatcher.cs — marshal work onto Unity's main thread.
//
// WHY: nearly every Unity API (Selection, EditorApplication, AssetDatabase,
// SerializedObject, scene access) MUST be touched only on the main thread.
// The bridge's journal poll loop and the threaded log callback run on background
// threads, so they enqueue any Unity work here. The queue is drained once per
// EditorApplication.update tick.
//
// Three modes:
//   Enqueue(action)        — fire-and-forget (e.g. apply an inbound playmode cmd).
//   EnqueueCoalesced(...)  — fire-and-forget, but at most ONE unrun action per
//                            key is ever queued (see PUMP LIVENESS below).
//   EnqueueAndWait<T>(fn)  — RPC handlers that must compute a result ON the main
//                            thread and hand it back to the (background) worker
//                            thread. Blocks the caller until the tick runs it.
//
// EnqueueAndWait must NEVER be called from the main thread itself (it would
// deadlock — the pump can't run while you block it). The dispatcher guards
// against this by running the function inline when called on the main thread.
//
// ── PUMP LIVENESS ────────────────────────────────────────────────────────────
//
// Unity all but stops ticking EditorApplication.update while its window is not
// focused. The bridge's worker thread does NOT stop — it is a plain Thread on a
// Thread.Sleep cadence — so the whole system used to fail in a uniquely
// confusing way: the worker kept heartbeating, the IDE kept showing a healthy
// green bridge, and every single RPC quietly timed out against a main thread
// that was asleep. The bridge reported process liveness and called it a
// connection.
//
// Three things here fix that:
//
//   1. `Pump()` stamps `_lastPumpTick`, readable from ANY thread via
//      `MsSincePump`. That is the difference between "Unity's process is alive"
//      and "Unity is servicing work", and it is what the heartbeat now carries
//      to the IDE and what EditorWakeup escalates on.
//
//   2. Queued work carries an expiry and an `Abandoned` flag. A timed-out
//      EnqueueAndWait used to LEAVE its action in the queue, so a dozen RPCs
//      that had already failed all fired the instant the user clicked back into
//      Unity — the "it recompiles everything at once when I focus it" symptom.
//      Dead work is now dropped rather than replayed.
//
//   3. Coalescing keys collapse repeat asks (refresh, compile) to one pending
//      action, so an agent writing ten files while Unity sleeps queues one
//      refresh, not ten.
//
// Enqueueing from a background thread also nudges the main thread awake via
// EditorWakeup, which is what lets a queued refresh actually run without the
// user touching the Unity window. Starting the work is only half of it, so
// `RequestWake` holds the editor ticking for as long as the work it triggered
// needs — the worker loop nudges on every iteration while `WantsWake`.

using System;
using System.Collections.Concurrent;
using System.Threading;
using UnityEngine;

namespace UnityIDE.Bridge
{
    /// <summary>
    /// One unit of queued main-thread work. Mutable by design: `Abandoned` is
    /// set from the waiting background thread after the pump has already taken
    /// ownership of the item, which is the whole point.
    /// </summary>
    internal sealed class PendingAction
    {
        public Action Run;

        /// <summary>
        /// Environment.TickCount past which this is dropped unrun. 0 = never
        /// expires. Compared with the codebase's `unchecked(a - b)` idiom so a
        /// TickCount wrap is a non-event.
        /// </summary>
        public int ExpiresAt;

        /// <summary>
        /// Set by a timed-out or cancelled EnqueueAndWait so the pump skips this
        /// item instead of running it minutes later against a caller that gave
        /// up long ago.
        /// </summary>
        public volatile bool Abandoned;

        /// <summary>Non-null for coalescing work; see EnqueueCoalesced.</summary>
        public string CoalesceKey;
    }

    internal static class MainThreadDispatcher
    {
        private static readonly ConcurrentQueue<PendingAction> Queue =
            new ConcurrentQueue<PendingAction>();

        /// <summary>
        /// Keys with an unrun action already in the queue. A plain set would
        /// need a lock; the value byte is ignored.
        /// </summary>
        private static readonly ConcurrentDictionary<string, byte> Coalescing =
            new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);

        /// <summary>
        /// Signalled once teardown starts, so blocked EnqueueAndWait callers stop
        /// waiting for a pump that will never tick again.
        ///
        /// This is load-bearing, not tidiness. The bridge worker calls
        /// EnqueueAndWait to build connection_init, and a domain reload begins by
        /// removing the pump — so without this the worker sits out the full
        /// timeout, BridgeClient.Stop()'s Join(1500) fails, and the journals are
        /// never closed. The next AppDomain then opens its own writer on a file
        /// the old worker can still append to: two writers on one journal, which
        /// is the single invariant the whole transport rests on.
        /// </summary>
        private static readonly ManualResetEventSlim Cancelled = new ManualResetEventSlim(false);

        // Captured when the pump is installed (which happens on the main thread).
        private static int _mainThreadId = -1;

        // Written by Pump() on the main thread, read from the worker thread.
        private static volatile int _lastPumpTick;
        private static volatile bool _pumpHasRun;

        /// <summary>
        /// True while the pump is INSIDE one of our queued actions.
        ///
        /// A quiet pump has two opposite causes and they must not be conflated.
        /// AssetDatabase.Refresh() on a large project blocks the main thread for
        /// many seconds, so `MsSincePump` climbs exactly as it does for a parked
        /// editor — and reporting that as asleep would abandon the import we
        /// asked for, at the moment it was working hardest. If the main thread
        /// is stuck in our own work, it is busy, which is the opposite of idle.
        /// </summary>
        private static volatile bool _runningAction;

        // Deadline (Environment.TickCount) until which the worker keeps nudging
        // the main thread even with an empty queue. See RequestWake.
        private static volatile int _wakeUntilTick;
        private static volatile bool _wakeRequested;

        /// <summary>
        /// Record the main-thread id and clear any cancellation left by the
        /// previous AppDomain. Call once from the bootstrap.
        /// </summary>
        public static void CaptureMainThread()
        {
            _mainThreadId = Thread.CurrentThread.ManagedThreadId;
            // Seed liveness so the window between bootstrap and the first tick
            // does not read as a sleeping editor.
            _lastPumpTick = Environment.TickCount;
            _pumpHasRun = true;
            _wakeRequested = false;
            Cancelled.Reset();
        }

        public static bool IsMainThread =>
            _mainThreadId != -1 && Thread.CurrentThread.ManagedThreadId == _mainThreadId;

        /// <summary>
        /// Whether the main thread is currently executing queued bridge work.
        /// Readable from any thread; see <see cref="_runningAction"/> for why a
        /// quiet pump alone is not enough to call the editor asleep.
        /// </summary>
        public static bool IsBusy => _runningAction;

        /// <summary>
        /// Milliseconds since the pump last ticked, from any thread.
        /// int.MaxValue before the first tick of this AppDomain.
        ///
        /// This is the bridge's only honest answer to "can Unity actually do
        /// work right now" — the worker thread's own liveness says nothing about
        /// it. Callers treat a large value as "the editor is asleep (unfocused)"
        /// rather than as a failure.
        /// </summary>
        public static int MsSincePump
        {
            get
            {
                if (!_pumpHasRun) return int.MaxValue;
                int delta = unchecked(Environment.TickCount - _lastPumpTick);
                // A negative delta means TickCount wrapped between the stamp and
                // this read. Zero is the truthful answer, not a huge number.
                return delta < 0 ? 0 : delta;
            }
        }

        /// <summary>Queue an action to run on the next editor tick. Thread-safe.</summary>
        public static void Enqueue(Action action)
        {
            Enqueue(action, 0);
        }

        /// <summary>
        /// Queue an action, dropped unrun if the pump has not reached it within
        /// <paramref name="ttlMs"/> (0 = never expires).
        /// </summary>
        public static void Enqueue(Action action, int ttlMs)
        {
            if (action == null) return;
            Queue.Enqueue(new PendingAction
            {
                Run = action,
                ExpiresAt = ttlMs > 0 ? unchecked(Environment.TickCount + ttlMs) : 0,
            });
            NudgeIfBackground();
        }

        /// <summary>
        /// Queue an action unless one with the same <paramref name="key"/> is
        /// already waiting to run.
        ///
        /// This is what keeps a sleeping editor from accumulating a backlog. An
        /// agent that writes ten scripts asks for ten refreshes; nine of them
        /// are the same ask, and running all ten on wake is how a five-second
        /// import turned into a minute of thrash.
        /// </summary>
        /// <returns>False when an identical action was already pending.</returns>
        public static bool EnqueueCoalesced(string key, Action action, int ttlMs)
        {
            if (action == null || string.IsNullOrEmpty(key)) return false;
            if (!Coalescing.TryAdd(key, 0))
            {
                // Still nudge: the pending action is the one that matters, and
                // the editor may have gone to sleep since it was queued.
                NudgeIfBackground();
                return false;
            }
            Queue.Enqueue(new PendingAction
            {
                Run = action,
                ExpiresAt = ttlMs > 0 ? unchecked(Environment.TickCount + ttlMs) : 0,
                CoalesceKey = key,
            });
            NudgeIfBackground();
            return true;
        }

        /// <summary>
        /// Drain and run all queued actions. MUST be called from the main thread
        /// (wired to EditorApplication.update). Each action is wrapped so one
        /// throwing handler cannot break the pump or starve the rest of the queue.
        /// </summary>
        public static void Pump()
        {
            // Stamp on entry so the worker can see that the editor loop ticked
            // at all. This alone does NOT cover a long action — the stamp cannot
            // advance while the main thread is inside one — which is what
            // `_runningAction` below is for.
            _lastPumpTick = Environment.TickCount;
            _pumpHasRun = true;

            int now = _lastPumpTick;
            PendingAction item;
            while (Queue.TryDequeue(out item))
            {
                // Release the coalescing slot as the action leaves the queue, so
                // a fresh ask arriving mid-run queues again rather than being
                // swallowed by the one already executing.
                if (item.CoalesceKey != null)
                {
                    byte ignored;
                    Coalescing.TryRemove(item.CoalesceKey, out ignored);
                }

                if (item.Abandoned) continue;
                if (item.ExpiresAt != 0 && unchecked(now - item.ExpiresAt) >= 0) continue;

                _runningAction = true;
                try { item.Run(); }
                catch (Exception e) { Debug.LogError("[UnityIDEBridge] main-thread action threw: " + e); }
                finally { _runningAction = false; }

                // Re-stamp after each action: draining a long backlog is work,
                // and the worker should see progress rather than one stale mark.
                _lastPumpTick = Environment.TickCount;
            }
        }

        /// <summary>
        /// Run <paramref name="fn"/> on the main thread and return its result to
        /// the calling (background) thread. Blocks up to <paramref name="timeoutMs"/>.
        /// On the main thread it runs inline to avoid deadlock. Exceptions from the
        /// function are re-thrown to the caller so the RPC layer can map them to an
        /// error response.
        /// </summary>
        public static T EnqueueAndWait<T>(Func<T> fn, int timeoutMs = 8000)
        {
            if (fn == null) return default;

            // Inline on the main thread: blocking here would deadlock the pump.
            if (IsMainThread)
                return fn();

            T result = default;
            Exception captured = null;
            var done = new ManualResetEventSlim(false);

            var pending = new PendingAction
            {
                Run = () =>
                {
                    try { result = fn(); }
                    catch (Exception e) { captured = e; }
                    finally { done.Set(); }
                },
            };
            Queue.Enqueue(pending);

            // The editor may be asleep (unfocused). Waking it is the difference
            // between this returning a result and timing out for no reason the
            // user can see.
            NudgeIfBackground();

            // Wake on completion, on shutdown, or on the timeout — whichever
            // lands first.
            int signalled = WaitHandle.WaitAny(
                new WaitHandle[] { done.WaitHandle, Cancelled.WaitHandle }, timeoutMs);

            if (signalled == 0)
            {
                // Only release the handle once the queued action is provably
                // finished with it.
                done.Dispose();
                if (captured != null) throw captured;
                return result;
            }

            // Cancelled or timed out: the action is still in the queue. Mark it
            // dead so the pump drops it instead of running it — possibly minutes
            // later, when the user finally focuses Unity — against a caller that
            // is long gone. The handle itself is left to the GC: a stray
            // allocation beats an ObjectDisposedException thrown out of the
            // editor's update loop.
            pending.Abandoned = true;

            if (signalled == 1)
                throw new OperationCanceledException("[UnityIDEBridge] shutting down");

            throw new TimeoutException(
                "Main-thread RPC handler timed out after " + timeoutMs +
                "ms (editor idle for " + MsSincePump + "ms)");
        }

        /// <summary>
        /// Begin teardown: release every blocked <see cref="EnqueueAndWait"/>
        /// caller, then drop pending work so nothing runs post-dispose. Must be
        /// called BEFORE stopping the bridge client, so its worker can observe
        /// the stop and be joined.
        /// </summary>
        public static void BeginShutdown()
        {
            Cancelled.Set();
            Clear();
        }

        /// <summary>Drop pending work without cancelling waiters (test helper).</summary>
        public static void Clear()
        {
            PendingAction ignored;
            while (Queue.TryDequeue(out ignored)) { }
            Coalescing.Clear();
            _wakeRequested = false;
        }

        /// <summary>
        /// Keep nudging the main thread for the next <paramref name="ms"/>, even
        /// with nothing of ours queued.
        ///
        /// WHY THIS EXISTS: waking Unity to START work is not enough. A script
        /// compile is not one tick — the import schedules it, the assembly build
        /// has to be driven, compilationFinished has to fire and a domain reload
        /// has to run, all on the main thread. A nudge sent only when work is
        /// enqueued gets the import going and then stops, Unity re-parks, and
        /// the compile stalls half-done with the IDE waiting out its full cap.
        /// The worker thread is never parked, so it is the right place to hold
        /// the editor awake for as long as the work it triggered needs.
        ///
        /// SETS, not extends: a later call with a smaller window deliberately
        /// shortens the deadline (compilationFinished trims the long
        /// compile-time window down to just enough for the domain reload).
        /// </summary>
        public static void RequestWake(int ms)
        {
            if (ms <= 0)
            {
                _wakeRequested = false;
                return;
            }
            _wakeUntilTick = unchecked(Environment.TickCount + ms);
            _wakeRequested = true;
        }

        /// <summary>
        /// Whether the main thread should be kept ticking: either our queue has
        /// work waiting for it, or something we started is still running there.
        /// </summary>
        public static bool WantsWake
        {
            get
            {
                if (!Queue.IsEmpty) return true;
                if (!_wakeRequested) return false;
                // READ-ONLY on purpose. Clearing the flag here — from the worker
                // thread, while the main thread may be inside RequestWake — can
                // land between that method's two writes and drop the request it
                // just made, stalling the compile it was meant to drive. The
                // deadline comparison expires the window on its own, so the
                // getter has no reason to write anything.
                return unchecked(Environment.TickCount - _wakeUntilTick) < 0;
            }
        }

        /// <summary>
        /// Ask the platform to wake Unity's main thread, but only from a
        /// background thread — on the main thread the pump is by definition
        /// already running.
        /// </summary>
        private static void NudgeIfBackground()
        {
            if (IsMainThread) return;
            EditorWakeup.Nudge(MsSincePump);
        }
    }
}
