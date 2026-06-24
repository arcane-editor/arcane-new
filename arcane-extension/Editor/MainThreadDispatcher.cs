// MainThreadDispatcher.cs — marshal work onto Unity's main thread.
//
// WHY: nearly every Unity API (Selection, EditorApplication, AssetDatabase,
// SerializedObject, scene access) MUST be touched only on the main thread.
// The bridge's socket read loop and the threaded log callback run on background
// threads, so they enqueue any Unity work here. The queue is drained once per
// EditorApplication.update tick.
//
// Two modes:
//   Enqueue(action)        — fire-and-forget (e.g. apply an inbound playmode cmd).
//   EnqueueAndWait<T>(fn)  — RPC handlers that must compute a result ON the main
//                            thread and hand it back to the (background) socket
//                            thread. Blocks the caller until the tick runs it.
//
// EnqueueAndWait must NEVER be called from the main thread itself (it would
// deadlock — the pump can't run while you block it). The dispatcher guards
// against this by running the function inline when called on the main thread.

using System;
using System.Collections.Concurrent;
using System.Threading;
using UnityEngine;

namespace Arcane.Bridge
{
    internal static class MainThreadDispatcher
    {
        private static readonly ConcurrentQueue<Action> Queue = new ConcurrentQueue<Action>();

        // Captured when the pump is installed (which happens on the main thread).
        private static int _mainThreadId = -1;

        /// <summary>Record the main-thread id. Call once from the bootstrap.</summary>
        public static void CaptureMainThread()
        {
            _mainThreadId = Thread.CurrentThread.ManagedThreadId;
        }

        public static bool IsMainThread =>
            _mainThreadId != -1 && Thread.CurrentThread.ManagedThreadId == _mainThreadId;

        /// <summary>Queue an action to run on the next editor tick. Thread-safe.</summary>
        public static void Enqueue(Action action)
        {
            if (action == null) return;
            Queue.Enqueue(action);
        }

        /// <summary>
        /// Drain and run all queued actions. MUST be called from the main thread
        /// (wired to EditorApplication.update). Each action is wrapped so one
        /// throwing handler cannot break the pump or starve the rest of the queue.
        /// </summary>
        public static void Pump()
        {
            while (Queue.TryDequeue(out var action))
            {
                try { action(); }
                catch (Exception e) { Debug.LogError("[ArcaneBridge] main-thread action threw: " + e); }
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
            using (var done = new ManualResetEventSlim(false))
            {
                Queue.Enqueue(() =>
                {
                    try { result = fn(); }
                    catch (Exception e) { captured = e; }
                    finally { done.Set(); }
                });

                if (!done.Wait(timeoutMs))
                    throw new TimeoutException("Main-thread RPC handler timed out after " + timeoutMs + "ms");
            }

            if (captured != null)
                throw captured;
            return result;
        }

        /// <summary>Clear pending work (used on shutdown so nothing runs post-dispose).</summary>
        public static void Clear()
        {
            while (Queue.TryDequeue(out _)) { }
        }
    }
}
