using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityIDE.Bridge;
using NUnit.Framework;

namespace UnityIDE.Tests
{
    /// <summary>
    /// Pins the journal wire format so it cannot drift between C# and Rust.
    /// The Rust half lives in
    /// editor/src-tauri/src/unity_journal.rs::parses_the_golden_fixture_shared_with_the_csharp_side
    /// and makes the same assertions against the same bytes.
    /// </summary>
    public class ContractTests
    {
        // Byte-identical to editor/src-tauri/fixtures/unity-journal/sample.jsonl.
        // If you change one, change BOTH — that file is the source of truth and
        // this literal is its shipped copy (the package cannot reach editor/).
        //
        // Line 2 is the important one: "\\n" here is the two-character JSON
        // ESCAPE, not a line break. If Json.cs ever emitted a raw newline inside
        // a string, one message would split into two lines and the whole
        // line-delimited transport would corrupt — Unity stack traces are full of
        // newlines, so this is the realistic failure, not a theoretical one.
        // Line 3 pins multi-byte UTF-8 (and a surrogate pair) for byte offsets.
        private const string Fixture =
            "{\"type\":\"connection_init\",\"payload\":{\"unitySessionId\":\"u1\",\"ideSessionId\":\"i1\",\"projectName\":\"Demo\"},\"timestamp\":1.5}\n" +
            "{\"type\":\"log\",\"payload\":{\"message\":\"line one\\nline two\",\"stackTrace\":\"at Foo()\\n  at Bar()\"},\"timestamp\":2.5}\n" +
            "{\"type\":\"log\",\"payload\":{\"message\":\"日本語 → emoji 🎮\"},\"timestamp\":3.5}\n" +
            "{\"type\":\"heartbeat\",\"payload\":{},\"timestamp\":4.5}\n";

        private string _dir;

        [SetUp]
        public void SetUp()
        {
            _dir = Path.Combine(Path.GetTempPath(), "unityide-contract-" + Path.GetRandomFileName());
            Directory.CreateDirectory(_dir);
        }

        [TearDown]
        public void TearDown()
        {
            try { Directory.Delete(_dir, true); } catch { }
        }

        [Test]
        public void ParsesTheGoldenFixture()
        {
            string journal = Path.Combine(_dir, "g.jsonl");
            File.WriteAllBytes(journal, Encoding.UTF8.GetBytes(Fixture));

            using (var r = new JournalReader(journal, Path.Combine(_dir, "g.ack")))
            {
                Assert.IsTrue(r.TryOpen());
                List<string> lines = r.Poll();
                Assert.AreEqual(4, lines.Count,
                    "an escaped \\n inside a JSON string must not split a record");

                JsonValue init = JsonValue.TryParse(lines[0]);
                Assert.AreEqual("connection_init", init["type"].AsString);
                Assert.AreEqual("i1", init["payload"]["ideSessionId"].AsString);

                JsonValue log = JsonValue.TryParse(lines[1]);
                Assert.AreEqual("line one\nline two", log["payload"]["message"].AsString);

                JsonValue uni = JsonValue.TryParse(lines[2]);
                Assert.AreEqual("日本語 → emoji 🎮", uni["payload"]["message"].AsString);

                Assert.AreEqual(new FileInfo(journal).Length, r.AckOffset,
                    "every byte of the fixture must be consumed");
            }
        }

        [Test]
        public void SerializeNeverEmitsARawNewline()
        {
            // The precondition the entire line-delimited format rests on. A Unity
            // stack trace routinely contains newlines, tabs and carriage returns.
            var v = JsonValue.NewObject();
            v["message"] = "line one\nline two\r\nand a tab\there";
            string s = v.Serialize();

            Assert.IsFalse(s.Contains("\n"), "Serialize must escape newlines, not emit them");
            Assert.IsFalse(s.Contains("\r"), "Serialize must escape carriage returns");
            Assert.IsFalse(s.Contains("\t"), "Serialize must escape tabs");

            // And it must still round-trip to the original text.
            JsonValue back = JsonValue.TryParse(s);
            Assert.AreEqual("line one\nline two\r\nand a tab\there", back["message"].AsString);
        }

        [Test]
        public void ARealisticStackTraceSurvivesTheJournalRoundTrip()
        {
            string trace =
                "NullReferenceException: Object reference not set to an instance of an object\n" +
                "  at PlayerController.Update () [0x00012] in /proj/Assets/PlayerController.cs:42\n" +
                "  at UnityEngine.Debug.LogError (System.Object) [0x00000]\n";

            var payload = JsonValue.NewObject();
            payload["message"] = "Something broke";
            payload["stackTrace"] = trace;
            string line = Protocol.Envelope(MsgType.Log, payload).Serialize();

            string journal = Path.Combine(_dir, "trace.jsonl");
            string ack = Path.Combine(_dir, "trace.ack");
            using (var w = new JournalWriter(journal, ack))
            using (var r = new JournalReader(journal, ack))
            {
                Assert.IsTrue(w.Open());
                Assert.IsTrue(w.Append(line));
                w.Flush();

                Assert.IsTrue(r.TryOpen());
                List<string> lines = r.Poll();
                Assert.AreEqual(1, lines.Count,
                    "a multi-line stack trace must stay ONE journal record");

                JsonValue back = JsonValue.TryParse(lines[0]);
                Assert.AreEqual(trace, back["payload"]["stackTrace"].AsString);
            }
        }
    }
}
