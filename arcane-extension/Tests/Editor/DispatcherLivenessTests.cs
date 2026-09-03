using System;
using System.Threading;
using UnityIDE.Bridge;
using NUnit.Framework;

namespace UnityIDE.Tests
{
    /// <summary>
    /// The dispatcher's behaviour when Unity's main thread is PARKED.
    ///
    /// Unity all but stops ticking EditorApplication.update while its window is
    /// unfocused, which is the normal state whenever the user is looking at the
    /// IDE instead of the editor. The bridge's worker thread does not stop, so
    /// the two threads disagree about whether Unity can do anything — and every
    /// bug these tests cover comes from that disagreement going unrepresented:
    ///
    ///   * the bridge reporting a healthy connection while no RPC could run,
    ///   * abandoned work firing in a burst minutes later when the user finally
    ///     clicked into Unity ("it recompiles everything at once"),
    ///   * ten agent file-writes turning into ten separate asset imports.
    /// </summary>
    public class DispatcherLivenessTests
    {
        [SetUp]
        public void SetUp()
        {
            MainThreadDispatcher.Clear();
            MainThreadDispatcher.CaptureMainThread();
        }

        [TearDown]
        public void TearDown()
        {
            MainThreadDispatcher.Clear();
        }

        [Test]
        public void MsSincePumpMeasuresTheEditorLoopNotTheWorkerThread()
        {
            MainThreadDispatcher.Pump();
            Assert.IsTrue(MainThreadDispatcher.MsSincePump < 500,
                "a just-pumped dispatcher must read as awake");

            Thread.Sleep(150);
            Assert.IsTrue(MainThreadDispatcher.MsSincePump >= 100,
                "idle time must accrue while the pump is quiet — this is the whole signal");

            MainThreadDispatcher.Pump();
            Assert.IsTrue(MainThreadDispatcher.MsSincePump < 100,
                "pumping must reset it");
        }

        [Test]
        public void AbandonedWorkIsDroppedRatherThanFiringWhenTheEditorWakesUp()
        {
            int ran = 0;
            var timedOut = new ManualResetEventSlim(false);

            // A worker-thread RPC against a main thread that never ticks. This
            // test thread stands in for that main thread and deliberately does
            // NOT pump while the waiter is blocked.
            var worker = new Thread(() =>
            {
                try
                {
                    MainThreadDispatcher.EnqueueAndWait<object>(() => { ran++; return null; }, 50);
                }
                catch (TimeoutException)
                {
                    timedOut.Set();
                }
            });
            worker.IsBackground = true;
            worker.Start();

            Assert.IsTrue(timedOut.Wait(5000), "the waiter should have timed out");

            // The user finally clicks into Unity and the pump resumes.
            MainThreadDispatcher.Pump();

            Assert.AreEqual(0, ran,
                "work whose caller already gave up must not run later; replaying it is " +
                "what made a dozen dead refreshes all fire on focus");
            worker.Join(1000);
        }

        [Test]
        public void LiveWorkStillRunsWhenThePumpResumes()
        {
            // The converse of the test above: dropping ABANDONED work must not
            // become dropping work in general.
            int ran = 0;
            MainThreadDispatcher.Enqueue(() => ran++);
            Thread.Sleep(80);
            MainThreadDispatcher.Pump();
            Assert.AreEqual(1, ran, "fire-and-forget work survives a sleeping editor");
        }

        [Test]
        public void ALongRunningActionReadsAsBusyNotAsleep()
        {
            // AssetDatabase.Refresh() on a large project blocks the pump for
            // seconds. From the worker thread that is indistinguishable from a
            // parked editor by idle time alone — and if the bridge called it
            // asleep, the IDE would abandon the import at the moment it was
            // actually working.
            var inside = new ManualResetEventSlim(false);
            var release = new ManualResetEventSlim(false);
            bool busyDuring = false;
            int idleDuring = 0;

            var observer = new Thread(() =>
            {
                if (!inside.Wait(5000)) return;
                // Sample only after enough time has passed for idle to accrue —
                // the pump stamps on entry, so an immediate read always looks
                // healthy and would prove nothing.
                Thread.Sleep(150);
                busyDuring = MainThreadDispatcher.IsBusy;
                idleDuring = MainThreadDispatcher.MsSincePump;
                release.Set();
            });
            observer.IsBackground = true;
            observer.Start();

            MainThreadDispatcher.Enqueue(() =>
            {
                inside.Set();
                release.Wait(5000);
            });
            MainThreadDispatcher.Pump();
            observer.Join(2000);

            Assert.IsTrue(idleDuring >= 100,
                "idle time climbs during a long action exactly as it does for a parked editor");
            Assert.IsTrue(busyDuring,
                "…so IsBusy is the only thing that separates the two");
            Assert.IsFalse(MainThreadDispatcher.IsBusy,
                "and it must clear once the action returns");
        }

        [Test]
        public void CoalescedWorkCollapsesToOnePendingAction()
        {
            int ran = 0;
            Assert.IsTrue(MainThreadDispatcher.EnqueueCoalesced("refresh", () => ran++, 0),
                "the first ask is accepted");
            Assert.IsFalse(MainThreadDispatcher.EnqueueCoalesced("refresh", () => ran++, 0),
                "a duplicate ask is folded into the pending one");
            Assert.IsFalse(MainThreadDispatcher.EnqueueCoalesced("refresh", () => ran++, 0));

            MainThreadDispatcher.Pump();
            Assert.AreEqual(1, ran,
                "an agent writing ten scripts while Unity sleeps must queue one import, not ten");

            // The slot frees as the action leaves the queue, so a genuinely new
            // ask afterwards is not swallowed.
            Assert.IsTrue(MainThreadDispatcher.EnqueueCoalesced("refresh", () => ran++, 0),
                "a fresh ask after the previous one ran must queue again");
            MainThreadDispatcher.Pump();
            Assert.AreEqual(2, ran);
        }

        [Test]
        public void DifferentCoalescingKeysDoNotCollapseIntoEachOther()
        {
            int a = 0, b = 0;
            Assert.IsTrue(MainThreadDispatcher.EnqueueCoalesced("refresh", () => a++, 0));
            Assert.IsTrue(MainThreadDispatcher.EnqueueCoalesced("hierarchy", () => b++, 0));
            MainThreadDispatcher.Pump();
            Assert.AreEqual(1, a);
            Assert.AreEqual(1, b);
        }

        [Test]
        public void QueuedWorkExpiresRatherThanFiringLongAfterItMattered()
        {
            int ran = 0;
            MainThreadDispatcher.Enqueue(() => ran++, 30);
            Thread.Sleep(120);
            MainThreadDispatcher.Pump();
            Assert.AreEqual(0, ran,
                "past its ttl, Unity's own focus refresh covers the same ground — " +
                "running ours too is duplicated import work");
        }

        [Test]
        public void AnExpiredEntryDoesNotBlockTheRestOfTheQueue()
        {
            int stale = 0, fresh = 0;
            MainThreadDispatcher.Enqueue(() => stale++, 30);
            Thread.Sleep(120);
            MainThreadDispatcher.Enqueue(() => fresh++);
            MainThreadDispatcher.Pump();
            Assert.AreEqual(0, stale);
            Assert.AreEqual(1, fresh, "dropping one entry must not starve the queue behind it");
        }

        // ── Holding the editor awake THROUGH the work it started ─────────────

        [Test]
        public void PendingWorkAloneAsksForTheEditorToBeKeptAwake()
        {
            Assert.IsFalse(MainThreadDispatcher.WantsWake,
                "an idle dispatcher must not pin the worker to its active poll rate");

            MainThreadDispatcher.Enqueue(() => { });
            Assert.IsTrue(MainThreadDispatcher.WantsWake,
                "queued work is useless until the main thread runs it");

            MainThreadDispatcher.Pump();
            Assert.IsFalse(MainThreadDispatcher.WantsWake,
                "once drained there is nothing left to wake the editor for");
        }

        [Test]
        public void RequestWakeOutlivesTheQueueThatTriggeredIt()
        {
            // THE POINT: a compile is not one tick. The import that schedules it
            // drains from the queue immediately, and if the wake died with the
            // queue the editor would fall straight back asleep mid-build — the
            // agent then waits out its whole cap for a compilation_finished that
            // nothing is driving.
            MainThreadDispatcher.EnqueueCoalesced("import", () => { }, 0);
            MainThreadDispatcher.RequestWake(5000);
            MainThreadDispatcher.Pump();

            Assert.IsTrue(MainThreadDispatcher.WantsWake,
                "the wake must survive the queue draining");
        }

        [Test]
        public void RequestWakeExpiresOnItsOwn()
        {
            MainThreadDispatcher.RequestWake(50);
            Thread.Sleep(120);
            Assert.IsFalse(MainThreadDispatcher.WantsWake,
                "a stale wake would nudge a sleeping editor forever");
        }

        [Test]
        public void RequestWakeSetsTheDeadlineRatherThanExtendingIt()
        {
            // compilationFinished trims the long compile window down to just
            // enough for the domain reload; extending would leave the worker
            // spinning at its active poll rate for two more minutes.
            MainThreadDispatcher.RequestWake(120000);
            MainThreadDispatcher.RequestWake(50);
            Thread.Sleep(120);
            Assert.IsFalse(MainThreadDispatcher.WantsWake,
                "a shorter request must shorten, not be ignored");
        }

        [Test]
        public void ClearDropsTheWakeRequestWithTheQueue()
        {
            MainThreadDispatcher.RequestWake(60000);
            MainThreadDispatcher.Clear();
            Assert.IsFalse(MainThreadDispatcher.WantsWake,
                "teardown must not leave the worker nudging a dead editor");
        }
    }
}
