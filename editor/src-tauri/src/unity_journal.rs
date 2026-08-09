//! Append-only newline-delimited JSON journals — the Unity bridge transport.
//!
//! Mirrors `arcane-extension/Editor/Journal.cs`. The two sides must agree on line
//! splitting, the epoch/ack handshake, and every constant below; the golden
//! fixture in `fixtures/unity-journal/` pins the wire format across languages.
//!
//! SINGLE WRITER PER FILE is the invariant: the IDE owns `to-unity.jsonl`,
//! `to-unity.epoch` and `to-ide.ack`; Unity owns the mirror set. Nothing locks.
//!
//! This replaced a Unix-domain-socket / named-pipe pair because
//! `UnixDomainSocketEndPoint` does not exist on Unity's `.NET Framework` API
//! compatibility profile, which left the bridge dead for any project on it.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const MAX_LINE_BYTES: u64 = 16 * 1024 * 1024;
pub const ROTATE_THRESHOLD: u64 = 4 * 1024 * 1024;
pub const MAX_READ_PER_POLL: u64 = 4 * 1024 * 1024;
pub const ACK_INTERVAL_MS: u64 = 500;

/// Sidecar holding a journal's truncation epoch: `to-ide.jsonl` → `to-ide.epoch`.
///
/// A reader CANNOT detect truncation from file length alone. If the writer
/// truncates and rewrites to the same-or-greater length before the reader's next
/// poll, `len < offset` is false and the reader silently skips the new content —
/// exactly what a session reset does (truncate, then append a fat
/// `connection_init`). The epoch is the length-independent signal.
pub fn epoch_path_for(journal: &Path) -> PathBuf {
    journal.with_extension("epoch")
}

/// Read an epoch sidecar. Absent or unreadable means "never truncated" (0).
pub fn read_epoch(path: &Path) -> u64 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

/// The append side of one journal. Owns the only write handle to its file.
pub struct JournalWriter {
    file: File,
    ack_path: PathBuf,
    epoch_path: PathBuf,
    epoch: u64,
}

impl JournalWriter {
    pub fn open(journal: &Path, ack: &Path) -> std::io::Result<Self> {
        if let Some(dir) = journal.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(journal)?;
        file.seek(SeekFrom::End(0))?;
        let epoch_path = epoch_path_for(journal);
        // Resume the existing epoch rather than restarting at 0, so a reader that
        // outlived us never sees the counter go backwards.
        let epoch = read_epoch(&epoch_path);
        Ok(Self {
            file,
            ack_path: ack.to_path_buf(),
            epoch_path,
            epoch,
        })
    }

    pub fn len(&self) -> u64 {
        self.file.metadata().map(|m| m.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Empty the journal and bump the epoch so the reader detects the reset even
    /// when the rewritten content lands at the same byte length.
    ///
    /// Order matters: truncate FIRST, publish the epoch SECOND, and only then let
    /// the caller append. A reader polling in between sees an empty file
    /// (`len 0 < offset`) and resets by the other route, so no interleaving loses
    /// data.
    pub fn truncate(&mut self) -> std::io::Result<()> {
        self.file.set_len(0)?;
        self.file.seek(SeekFrom::Start(0))?;
        self.file.flush()?;
        self.epoch += 1;
        std::fs::write(&self.epoch_path, self.epoch.to_string())?;
        Ok(())
    }

    /// Returns `Ok(false)` when the line exceeds the cap — caller warns and drops.
    pub fn append(&mut self, line: &str) -> std::io::Result<bool> {
        let bytes = line.as_bytes();
        if bytes.len() as u64 + 1 > MAX_LINE_BYTES {
            return Ok(false);
        }
        self.file.write_all(bytes)?;
        self.file.write_all(b"\n")?;
        Ok(true)
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }

    /// Ack-gated rotation: truncate only when the reader has consumed every byte,
    /// so nothing is ever in flight. A missing, unparseable or stale ack skips
    /// this round — the failure mode is delayed rotation, never data loss, which
    /// is why the ack file needs no atomic-write dance.
    pub fn maybe_rotate(&mut self) {
        let size = self.len();
        if size <= ROTATE_THRESHOLD {
            return;
        }
        let ack = std::fs::read_to_string(&self.ack_path)
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok());
        if ack != Some(size) {
            return;
        }
        let _ = self.truncate();
    }
}

/// The polling side of one journal. Tracks a byte position and publishes an ack
/// so the peer (the journal's writer) knows when rotation is safe.
pub struct JournalReader {
    file: File,
    ack_path: PathBuf,
    epoch_path: PathBuf,
    buf: Vec<u8>,
    read_pos: u64,
    epoch: Option<u64>,
    did_reset: bool,
    last_ack_value: Option<u64>,
    last_ack_written_ms: Option<u64>,
}

impl JournalReader {
    /// Fails when the journal does not exist yet — a reader never creates the
    /// peer's file; the caller retries on its next poll.
    pub fn open(journal: &Path, ack: &Path) -> std::io::Result<Self> {
        // std::fs::File is unbuffered, so unlike C#'s FileStream there is no
        // stale-cache hazard when seeking back to 0 after a truncation.
        let file = OpenOptions::new().read(true).open(journal)?;
        Ok(Self {
            file,
            ack_path: ack.to_path_buf(),
            epoch_path: epoch_path_for(journal),
            buf: Vec::new(),
            read_pos: 0,
            epoch: None,
            did_reset: false,
            last_ack_value: None,
            last_ack_written_ms: None,
        })
    }

    pub fn len(&self) -> u64 {
        self.file.metadata().map(|m| m.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Bytes consumed AND dispatched — never includes a buffered partial line.
    pub fn ack_offset(&self) -> u64 {
        self.read_pos.saturating_sub(self.buf.len() as u64)
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.unwrap_or(0)
    }

    /// Set on the poll where the reset rule fired.
    pub fn did_reset(&self) -> bool {
        self.did_reset
    }

    /// Skip everything already present — used on a cold start so a previous
    /// session's messages are not replayed.
    pub fn seek_to_end(&mut self) {
        self.read_pos = self.len();
        self.buf.clear();
        self.epoch = Some(read_epoch(&self.epoch_path));
    }

    pub fn poll(&mut self) -> Vec<String> {
        let mut lines = Vec::new();
        self.did_reset = false;
        let len = self.len();

        // Reset rule, part 1 — AUTHORITATIVE. The epoch changes on every
        // truncation regardless of the length the writer rewrites to.
        let epoch = read_epoch(&self.epoch_path);
        match self.epoch {
            None => self.epoch = Some(epoch), // first poll: adopt, don't reset
            Some(seen) if seen != epoch => {
                self.epoch = Some(epoch);
                self.read_pos = 0;
                self.buf.clear();
                self.did_reset = true;
            }
            _ => {}
        }

        // Part 2 — safety net for the window between the writer's set_len(0) and
        // its epoch publish, where the file is merely short.
        if len < self.read_pos {
            self.read_pos = 0;
            self.buf.clear();
            self.did_reset = true;
        }
        if len <= self.read_pos {
            return lines;
        }

        let to_read = std::cmp::min(len - self.read_pos, MAX_READ_PER_POLL) as usize;
        let mut chunk = vec![0u8; to_read];
        if self.file.seek(SeekFrom::Start(self.read_pos)).is_err() {
            return lines;
        }
        let got = match read_fully(&mut self.file, &mut chunk) {
            Ok(n) => n,
            Err(_) => return lines,
        };
        if got == 0 {
            return lines;
        }

        self.read_pos += got as u64;
        self.buf.extend_from_slice(&chunk[..got]);

        // Split on the 0x0A byte. Safe pre-decode: UTF-8 continuation bytes are
        // always >= 0x80, so 0x0A can only ever be a real newline.
        let mut start = 0usize;
        while let Some(rel) = self.buf[start..].iter().position(|&b| b == b'\n') {
            let nl = start + rel;
            let mut end = nl;
            // Tolerate a stray '\r' so a CRLF-mangled journal still parses.
            if end > start && self.buf[end - 1] == b'\r' {
                end -= 1;
            }
            if end > start {
                lines.push(String::from_utf8_lossy(&self.buf[start..end]).into_owned());
            }
            start = nl + 1;
        }
        self.buf.drain(..start);

        // Bound memory on a corrupt journal: a line that never terminates.
        if self.buf.len() as u64 > MAX_LINE_BYTES {
            self.buf.clear();
            self.read_pos = len;
        }
        lines
    }

    /// Publish the consumed offset — only while the journal exceeds the rotate
    /// threshold, so an ordinary session does zero ack I/O.
    pub fn publish_ack_if_needed(&mut self, now_ms: u64) {
        if self.len() <= ROTATE_THRESHOLD {
            return;
        }
        let ack = self.ack_offset();
        if self.last_ack_value == Some(ack) {
            return;
        }
        if let Some(prev) = self.last_ack_written_ms {
            if now_ms.saturating_sub(prev) < ACK_INTERVAL_MS {
                return;
            }
        }
        if std::fs::write(&self.ack_path, ack.to_string()).is_ok() {
            self.last_ack_value = Some(ack);
            self.last_ack_written_ms = Some(now_ms);
        }
    }
}

fn read_fully(file: &mut File, into: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0usize;
    while total < into.len() {
        match file.read(&mut into[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Unique per call — cargo runs tests on multiple threads, so a shared
    /// directory would have tests deleting each other's fixtures.
    fn tmp() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("arcane-journal-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn paths(dir: &Path, stem: &str) -> (PathBuf, PathBuf) {
        (
            dir.join(format!("{}.jsonl", stem)),
            dir.join(format!("{}.ack", stem)),
        )
    }

    fn append_raw(journal: &Path, text: &str) {
        let mut f = OpenOptions::new().write(true).create(true).open(journal).unwrap();
        f.seek(SeekFrom::End(0)).unwrap();
        f.write_all(text.as_bytes()).unwrap();
        f.flush().unwrap();
    }

    #[test]
    fn round_trips_lines_in_order() {
        let d = tmp();
        let (j, a) = paths(&d, "j");
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"a\":1}").unwrap();
        w.append("{\"a\":2}").unwrap();
        w.flush().unwrap();

        let mut r = JournalReader::open(&j, &a).unwrap();
        assert_eq!(
            r.poll(),
            vec!["{\"a\":1}".to_string(), "{\"a\":2}".to_string()]
        );
    }

    #[test]
    fn does_not_dispatch_a_partial_line() {
        let d = tmp();
        let (j, a) = paths(&d, "p");
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.flush().unwrap();
        let mut r = JournalReader::open(&j, &a).unwrap();

        append_raw(&j, "{\"a\":");
        assert!(r.poll().is_empty(), "a partial line must not be dispatched");

        append_raw(&j, "1}\n");
        assert_eq!(r.poll(), vec!["{\"a\":1}".to_string()]);
    }

    #[test]
    fn advances_offset_by_bytes_for_multibyte_utf8() {
        let d = tmp();
        let (j, a) = paths(&d, "u");
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"m\":\"日本語\"}").unwrap();
        w.append("{\"m\":\"ok\"}").unwrap();
        w.flush().unwrap();

        let mut r = JournalReader::open(&j, &a).unwrap();
        let lines = r.poll();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1], "{\"m\":\"ok\"}");
        assert_eq!(r.ack_offset(), w.len(), "offset must track bytes, not chars");
    }

    #[test]
    fn resets_to_zero_when_the_file_shrinks() {
        let d = tmp();
        let (j, a) = paths(&d, "t");
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"a\":1}").unwrap();
        w.flush().unwrap();
        let mut r = JournalReader::open(&j, &a).unwrap();
        assert_eq!(r.poll().len(), 1);

        w.truncate().unwrap();
        w.append("{\"b\":2}").unwrap();
        w.flush().unwrap();

        let lines = r.poll();
        assert!(r.did_reset(), "a reset must be detected");
        assert_eq!(lines, vec!["{\"b\":2}".to_string()]);
    }

    #[test]
    fn detects_truncation_even_when_rewritten_to_the_same_length() {
        // The trap length comparison alone cannot see. A session reset truncates
        // and immediately rewrites, and the new content can land at exactly the
        // old byte length — without the epoch the reader drops the handshake.
        let d = tmp();
        let (j, a) = paths(&d, "same");
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"a\":1}").unwrap();
        w.flush().unwrap();
        let mut r = JournalReader::open(&j, &a).unwrap();
        assert_eq!(r.poll().len(), 1);
        let len_before = w.len();

        w.truncate().unwrap();
        w.append("{\"b\":2}").unwrap(); // identical byte length
        w.flush().unwrap();
        assert_eq!(w.len(), len_before, "test premise: lengths must match");

        let lines = r.poll();
        assert!(r.did_reset(), "the epoch must reveal a same-length truncation");
        assert_eq!(lines, vec!["{\"b\":2}".to_string()]);
    }

    #[test]
    fn epoch_survives_a_writer_reopen() {
        let d = tmp();
        let (j, a) = paths(&d, "e");
        {
            let mut w1 = JournalWriter::open(&j, &a).unwrap();
            w1.truncate().unwrap();
            assert_eq!(w1.epoch(), 1);
        }
        let mut w2 = JournalWriter::open(&j, &a).unwrap();
        assert_eq!(w2.epoch(), 1, "epoch must resume, not restart");
        w2.truncate().unwrap();
        assert_eq!(w2.epoch(), 2);
    }

    #[test]
    fn refuses_a_line_over_the_cap() {
        let d = tmp();
        let (j, a) = paths(&d, "c");
        let mut w = JournalWriter::open(&j, &a).unwrap();
        let huge = "x".repeat(MAX_LINE_BYTES as usize + 1);
        assert!(!w.append(&huge).unwrap());
        assert_eq!(w.len(), 0, "an oversized line must not be partially written");
    }

    #[test]
    fn skips_rotation_when_ack_is_missing_unparseable_or_stale() {
        let d = tmp();
        let (j, a) = paths(&d, "r");
        let mut w = JournalWriter::open(&j, &a).unwrap();
        let chunk = "x".repeat(64 * 1024);
        while w.len() <= ROTATE_THRESHOLD {
            w.append(&chunk).unwrap();
        }
        w.flush().unwrap();
        let grown = w.len();

        w.maybe_rotate();
        assert_eq!(w.len(), grown, "missing ack must not rotate");

        std::fs::write(&a, "not-a-number").unwrap();
        w.maybe_rotate();
        assert_eq!(w.len(), grown, "unparseable ack must not rotate");

        std::fs::write(&a, (grown + 999).to_string()).unwrap();
        w.maybe_rotate();
        assert_eq!(w.len(), grown, "stale ack must not rotate");

        std::fs::write(&a, grown.to_string()).unwrap();
        w.maybe_rotate();
        assert_eq!(w.len(), 0, "a caught-up ack rotates");
    }

    #[test]
    fn publishes_no_ack_below_the_rotate_threshold() {
        let d = tmp();
        let (j, a) = paths(&d, "s");
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"a\":1}").unwrap();
        w.flush().unwrap();
        let mut r = JournalReader::open(&j, &a).unwrap();
        r.poll();
        r.publish_ack_if_needed(1000);
        assert!(!a.exists(), "a small journal must do zero ack I/O");
    }

    #[test]
    fn seek_to_end_skips_stale_messages() {
        let d = tmp();
        let (j, a) = paths(&d, "sk");
        let mut w = JournalWriter::open(&j, &a).unwrap();
        w.append("{\"stale\":1}").unwrap();
        w.flush().unwrap();

        let mut r = JournalReader::open(&j, &a).unwrap();
        r.seek_to_end();
        assert!(r.poll().is_empty());

        w.append("{\"fresh\":1}").unwrap();
        w.flush().unwrap();
        assert_eq!(r.poll(), vec!["{\"fresh\":1}".to_string()]);
    }

    #[test]
    fn epoch_sidecar_sits_beside_its_journal() {
        assert_eq!(
            epoch_path_for(Path::new("/x/Library/ArcaneIDE/to-ide.jsonl")),
            PathBuf::from("/x/Library/ArcaneIDE/to-ide.epoch")
        );
    }

    #[test]
    fn parses_the_golden_fixture_shared_with_the_csharp_side() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/unity-journal/sample.jsonl");
        let d = tmp();
        let (j, a) = paths(&d, "g");
        std::fs::copy(&fixture, &j).unwrap();

        let mut r = JournalReader::open(&j, &a).unwrap();
        let lines = r.poll();
        assert_eq!(
            lines.len(),
            4,
            "escaped \\n inside a JSON string must not split a record"
        );

        let log: serde_json::Value = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(log["payload"]["message"], "line one\nline two");

        let uni: serde_json::Value = serde_json::from_str(&lines[2]).unwrap();
        assert_eq!(uni["payload"]["message"], "日本語 → emoji 🎮");

        assert_eq!(r.ack_offset(), std::fs::metadata(&j).unwrap().len());
    }
}
