using System.Collections.Generic;
using System.IO;
using System.Text;
using Arcane.Bridge;
using NUnit.Framework;

namespace Arcane.Tests
{
    public class JournalTests
    {
        private string _dir;
        private string _journal;
        private string _ack;

        [SetUp]
        public void SetUp()
        {
            _dir = Path.Combine(Path.GetTempPath(), "arcane-journal-" + Path.GetRandomFileName());
            Directory.CreateDirectory(_dir);
            _journal = Path.Combine(_dir, "to-ide.jsonl");
            _ack = Path.Combine(_dir, "to-ide.ack");
        }

        [TearDown]
        public void TearDown()
        {
            try { Directory.Delete(_dir, true); } catch { }
        }

        private void AppendRaw(string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            using (var raw = new FileStream(_journal, FileMode.OpenOrCreate, FileAccess.Write, FileShare.ReadWrite))
            {
                raw.Seek(0, SeekOrigin.End);
                raw.Write(bytes, 0, bytes.Length);
            }
        }

        [Test]
        public void RoundTripsLinesInOrder()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"a\":1}");
                w.Append("{\"a\":2}");
                w.Flush();

                Assert.IsTrue(r.TryOpen());
                List<string> lines = r.Poll();
                Assert.AreEqual(new[] { "{\"a\":1}", "{\"a\":2}" }, lines.ToArray());
            }
        }

        [Test]
        public void DoesNotDispatchAPartialLineUntilItsNewlineArrives()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                Assert.IsTrue(r.TryOpen());

                AppendRaw("{\"a\":");
                Assert.AreEqual(0, r.Poll().Count, "a partial line must not be dispatched");

                AppendRaw("1}\n");
                List<string> lines = r.Poll();
                Assert.AreEqual(1, lines.Count);
                Assert.AreEqual("{\"a\":1}", lines[0]);
            }
        }

        [Test]
        public void AdvancesOffsetByBytesNotCharsForMultiByteUtf8()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"m\":\"日本語\"}");
                w.Append("{\"m\":\"ok\"}");
                w.Flush();
                Assert.IsTrue(r.TryOpen());

                List<string> lines = r.Poll();
                Assert.AreEqual(2, lines.Count);
                Assert.AreEqual("{\"m\":\"ok\"}", lines[1]);
                Assert.AreEqual(w.Length, r.AckOffset, "offset must track bytes, not chars");
            }
        }

        [Test]
        public void ResetsToZeroWhenTheFileShrinks()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"a\":1}");
                w.Flush();
                Assert.IsTrue(r.TryOpen());
                Assert.AreEqual(1, r.Poll().Count);

                w.Truncate();
                w.Append("{\"b\":2}");
                w.Flush();

                List<string> lines = r.Poll();
                Assert.IsTrue(r.DidReset, "shrink must trigger the universal reset rule");
                Assert.AreEqual(1, lines.Count);
                Assert.AreEqual("{\"b\":2}", lines[0]);
            }
        }

        [Test]
        public void RefusesALineOverTheCap()
        {
            using (var w = new JournalWriter(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                Assert.IsFalse(w.Append(new string('x', JournalLimits.MaxLineBytes + 1)));
                Assert.AreEqual(0, w.Length, "an oversized line must not be partially written");
            }
        }

        [Test]
        public void SkipsRotationWhenTheAckFileIsMissingUnparseableOrStale()
        {
            using (var w = new JournalWriter(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                string line = new string('x', 64 * 1024);
                while (w.Length <= JournalLimits.RotateThresholdBytes) w.Append(line);
                w.Flush();
                long grown = w.Length;

                w.MaybeRotate();                       // ack missing
                Assert.AreEqual(grown, w.Length);

                File.WriteAllText(_ack, "not-a-number");
                w.MaybeRotate();                       // ack unparseable
                Assert.AreEqual(grown, w.Length);

                File.WriteAllText(_ack, (grown + 999).ToString());
                w.MaybeRotate();                       // ack stale (> size)
                Assert.AreEqual(grown, w.Length);

                File.WriteAllText(_ack, grown.ToString());
                w.MaybeRotate();                       // ack caught up
                Assert.AreEqual(0, w.Length);
            }
        }

        [Test]
        public void PublishesNoAckBelowTheRotateThreshold()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"a\":1}");
                w.Flush();
                Assert.IsTrue(r.TryOpen());
                r.Poll();
                r.PublishAckIfNeeded(1000);
                Assert.IsFalse(File.Exists(_ack), "a small journal must do zero ack I/O");
            }
        }

        [Test]
        public void SeekToEndSkipsStaleMessages()
        {
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"stale\":1}");
                w.Flush();
                Assert.IsTrue(r.TryOpen());
                r.SeekToEnd();
                Assert.AreEqual(0, r.Poll().Count);

                w.Append("{\"fresh\":1}");
                w.Flush();
                List<string> lines = r.Poll();
                Assert.AreEqual(1, lines.Count);
                Assert.AreEqual("{\"fresh\":1}", lines[0]);
            }
        }

        [Test]
        public void RestorePositionResumesMidStreamAfterADomainReload()
        {
            using (var w = new JournalWriter(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"before\":1}");
                w.Flush();

                long saved, savedEpoch;
                using (var r1 = new JournalReader(_journal, _ack))
                {
                    Assert.IsTrue(r1.TryOpen());
                    Assert.AreEqual(1, r1.Poll().Count);
                    saved = r1.AckOffset;
                    savedEpoch = r1.Epoch;
                }

                w.Append("{\"after\":1}");
                w.Flush();

                // A fresh reader stands in for the post-domain-reload AppDomain.
                using (var r2 = new JournalReader(_journal, _ack))
                {
                    Assert.IsTrue(r2.TryOpen());
                    r2.RestorePosition(saved, savedEpoch);
                    List<string> lines = r2.Poll();
                    Assert.AreEqual(1, lines.Count, "must not replay what the previous domain consumed");
                    Assert.AreEqual("{\"after\":1}", lines[0]);
                }
            }
        }

        [Test]
        public void DetectsTruncationEvenWhenRewrittenToTheSameLength()
        {
            // The trap that length comparison alone cannot see: a session reset
            // truncates and immediately rewrites, and the new content can land at
            // exactly the old byte length. Without the epoch the reader concludes
            // "nothing new" and silently drops the handshake.
            using (var w = new JournalWriter(_journal, _ack))
            using (var r = new JournalReader(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"a\":1}");
                w.Flush();
                Assert.IsTrue(r.TryOpen());
                Assert.AreEqual(1, r.Poll().Count);
                long lengthBefore = w.Length;

                w.Truncate();
                w.Append("{\"b\":2}");   // identical byte length to "{\"a\":1}"
                w.Flush();
                Assert.AreEqual(lengthBefore, w.Length, "test premise: lengths must match");

                List<string> lines = r.Poll();
                Assert.IsTrue(r.DidReset, "the epoch must reveal a same-length truncation");
                Assert.AreEqual(1, lines.Count);
                Assert.AreEqual("{\"b\":2}", lines[0]);
            }
        }

        [Test]
        public void RestorePositionRestartsAtZeroWhenTheJournalRotatedWhileAway()
        {
            using (var w = new JournalWriter(_journal, _ack))
            {
                Assert.IsTrue(w.Open());
                w.Append("{\"old\":1}");
                w.Flush();

                long saved, savedEpoch;
                using (var r1 = new JournalReader(_journal, _ack))
                {
                    Assert.IsTrue(r1.TryOpen());
                    r1.Poll();
                    saved = r1.AckOffset;
                    savedEpoch = r1.Epoch;
                }

                // Rotation happens while our AppDomain is being torn down.
                w.Truncate();
                w.Append("{\"new\":1}");
                w.Flush();

                using (var r2 = new JournalReader(_journal, _ack))
                {
                    Assert.IsTrue(r2.TryOpen());
                    r2.RestorePosition(saved, savedEpoch);
                    List<string> lines = r2.Poll();
                    Assert.AreEqual(1, lines.Count, "a stale offset must not skip the rotated journal");
                    Assert.AreEqual("{\"new\":1}", lines[0]);
                }
            }
        }

        [Test]
        public void EpochSurvivesAWriterReopen()
        {
            // A domain reload reopens the writer. If Open() restarted the epoch at
            // 0 the reader would see it go backwards and reset spuriously.
            using (var w1 = new JournalWriter(_journal, _ack))
            {
                Assert.IsTrue(w1.Open());
                w1.Truncate();
                Assert.AreEqual(1, w1.Epoch);
            }
            using (var w2 = new JournalWriter(_journal, _ack))
            {
                Assert.IsTrue(w2.Open());
                Assert.AreEqual(1, w2.Epoch, "epoch must resume, not restart");
                w2.Truncate();
                Assert.AreEqual(2, w2.Epoch);
            }
        }
    }
}
