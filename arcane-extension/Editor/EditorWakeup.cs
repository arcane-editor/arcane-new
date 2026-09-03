// EditorWakeup.cs — wake Unity's sleeping main thread from a background thread.
//
// THE PROBLEM: Unity parks its main thread when the editor window is not
// focused. Every bridge RPC has to run there (MainThreadDispatcher), so with
// the IDE in front and Unity behind, queued work simply sat until the user
// clicked Unity. From the agent's side that looked like an 8s RPC timeout on a
// bridge that was still heartbeating happily — and a script the AI wrote did
// not compile until a human tabbed over.
//
// THE FIX: the bridge's worker thread is NOT parked (it is a plain Thread on a
// Sleep cadence), so it can poke the main thread from underneath Unity, through
// the OS rather than through any Unity API. Both pokes below are documented as
// safe to call from a thread that is not the target:
//
//   Windows — PostThreadMessage(mainThreadId, WM_NULL). A WM_NULL is a no-op
//             message whose only effect is to return a GetMessage-blocked
//             message pump. This is the standard way to wake a Win32 UI thread
//             and it does NOT touch focus or z-order.
//
//   macOS   — CFRunLoopWakeUp(CFRunLoopGetMain()). Unity's editor loop idles
//             inside the main run loop; waking it makes the loop return early
//             and run another iteration. CFRunLoopWakeUp is explicitly
//             thread-safe, and like WM_NULL it is invisible to the user.
//
//   Linux   — no equivalent that does not depend on the window system in use,
//             so `Supported` is false. The IDE is told (`canWake:false`) and
//             tells the user to focus Unity, rather than pretending to wait.
//
// HONEST LIMITS. Waking the loop is not the same as guaranteeing a full editor
// tick, and how much work Unity does per background iteration is its business,
// not ours. So this is deliberately built as a best-effort accelerator that
// REPORTS rather than assumes: the heartbeat carries `editorIdleMs` and
// `canWake`, and nothing downstream is allowed to depend on a nudge landing.
// When it does not land, the IDE resolves the wait as `editor-asleep` and says
// so — `canWake:false` (Linux, or a latched-off P/Invoke) changes that message
// from "Unity will pick this up shortly" to "focus Unity to compile", because
// those are genuinely different situations for the person reading it.
//
// One nudge only starts work. Holding the editor awake THROUGH a compile is
// MainThreadDispatcher.RequestWake + the worker loop nudging while WantsWake.
//
// Rate-limited, self-disabling on the first P/Invoke failure, and never throws:
// a wake-up hint is never worth an exception on the bridge's worker thread.

using System;
using System.Runtime.InteropServices;

namespace UnityIDE.Bridge
{
    internal static class EditorWakeup
    {
        /// <summary>
        /// Don't bother poking a pump that is keeping up. Below this, the editor
        /// is plainly ticking and a nudge is pure noise. Above it, the editor is
        /// either backgrounded or busy inside a long import — and a wake costs
        /// nothing in the second case because the loop is already awake.
        /// </summary>
        private const int StalledAfterMs = 250;

        /// <summary>
        /// Floor between two pokes. A sleeping editor is woken repeatedly, since
        /// each iteration may go straight back to sleep — so this rate IS the
        /// effective tick rate of a backgrounded editor being driven through a
        /// compile. 100ms was too slow to be that: 20/s costs nothing measurable
        /// on the worker thread and is close enough to a real editor cadence for
        /// an assembly build to make progress.
        /// </summary>
        private const int MinIntervalMs = 50;

        // Touched from whichever thread enqueues work. A torn read costs at
        // most one redundant nudge, but volatile is free and spares the next
        // reader the analysis.
        private static volatile int _lastNudgeTick;
        private static volatile bool _lastNudgeValid;

        /// <summary>Native id of Unity's main thread; Windows only, 0 = unknown.</summary>
        private static uint _mainNativeThreadId;

        /// <summary>Latched off after the first failure so we never spam logs.</summary>
        private static bool _disabled;

        private static readonly bool IsWindows =
            RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
        private static readonly bool IsMacOS =
            RuntimeInformation.IsOSPlatform(OSPlatform.OSX);

        /// <summary>
        /// Whether a focus-free wake is possible on this platform at all. Sent
        /// to the IDE so it can decide between waiting and offering to bring
        /// Unity forward, instead of guessing.
        /// </summary>
        public static bool Supported
        {
            get
            {
                if (_disabled) return false;
                if (IsMacOS) return true;
                return IsWindows && _mainNativeThreadId != 0;
            }
        }

        /// <summary>
        /// Record what the OS calls Unity's main thread. MUST be called ON the
        /// main thread (the bootstrap does, right after CaptureMainThread).
        /// Only Windows needs it; elsewhere it is a cheap no-op.
        /// </summary>
        public static void CaptureMainThread()
        {
            if (!IsWindows) return;
            try { _mainNativeThreadId = GetCurrentThreadId(); }
            catch { _mainNativeThreadId = 0; }
        }

        /// <summary>
        /// Ask the OS to run another iteration of Unity's main loop.
        /// Safe from any thread, never throws, cheap enough to call on every
        /// enqueue.
        /// </summary>
        /// <param name="msSincePump">
        /// How long the pump has been quiet, from MainThreadDispatcher. A
        /// responsive pump is left alone.
        /// </param>
        public static void Nudge(int msSincePump)
        {
            if (_disabled) return;
            if (msSincePump < StalledAfterMs) return;

            int now = Environment.TickCount;
            if (_lastNudgeValid && unchecked(now - _lastNudgeTick) < MinIntervalMs) return;
            _lastNudgeTick = now;
            _lastNudgeValid = true;

            try
            {
                if (IsWindows)
                {
                    if (_mainNativeThreadId == 0) return;
                    PostThreadMessage(_mainNativeThreadId, WM_NULL, IntPtr.Zero, IntPtr.Zero);
                }
                else if (IsMacOS)
                {
                    IntPtr mainLoop = CFRunLoopGetMain();
                    if (mainLoop == IntPtr.Zero) return;
                    CFRunLoopWakeUp(mainLoop);
                }
            }
            catch (Exception)
            {
                // DllNotFound / EntryPointNotFound / anything else: this is an
                // optimisation, and the bridge is correct without it. Latch off.
                _disabled = true;
            }
        }

        /// <summary>Reset per-AppDomain state. Called from the bootstrap.</summary>
        public static void Reset()
        {
            _lastNudgeValid = false;
            _mainNativeThreadId = 0;
            _disabled = false;
        }

        // ── Win32 ────────────────────────────────────────────────────────────

        private const uint WM_NULL = 0x0000;

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);

        // ── CoreFoundation (macOS) ───────────────────────────────────────────

        private const string CoreFoundation =
            "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

        [DllImport(CoreFoundation)]
        private static extern IntPtr CFRunLoopGetMain();

        [DllImport(CoreFoundation)]
        private static extern void CFRunLoopWakeUp(IntPtr rl);
    }
}
