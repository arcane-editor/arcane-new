use crate::sync_util::lock_recover;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Window};

/// VS Code's flow-control constants, verbatim
/// (`src/vs/platform/terminal/common/terminal.ts`). Units are UTF-16 code
/// units — see [`utf16_len`].
const HIGH_WATERMARK_CHARS: usize = 100_000;
const LOW_WATERMARK_CHARS: usize = 5_000;

/// How long a paused reader sleeps before re-checking, independent of any
/// notify. Purely a liveness backstop: a missed wakeup should cost a beat, not
/// wedge a thread that still owns a live PTY.
const FC_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Output batching window. VS Code's `terminalDataBuffering.ts` uses the same
/// 5ms, trailing — far below the ~30-50ms where added latency starts to feel
/// like lag, so echo stays crisp while bulk output coalesces.
const FLUSH_INTERVAL: Duration = Duration::from_millis(5);

/// Ceiling on one batch, so a fast writer can't grow an unbounded JS string
/// before the window closes.
const MAX_BATCH_BYTES: usize = 64 * 1024;

/// Length in UTF-16 code units — i.e. what JavaScript's `String.length` counts.
///
/// The flow-control ledger is incremented here and decremented by an ack the
/// frontend computes as `data.length`. Rust's `String::len()` is *bytes*, so
/// using it would make the two units disagree: a 3-byte CJK glyph would add 3
/// and subtract 1, and `pending` would climb monotonically on any non-ASCII
/// output until it pinned above the high watermark and the terminal froze for
/// good. They must count the same thing.
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

struct FcState {
    /// Unacknowledged UTF-16 units in flight to the frontend.
    pending: usize,
    paused: bool,
    /// False until the frontend has a listener attached.
    attached: bool,
    closing: bool,
}

/// Backpressure between a PTY reader thread and the webview that renders it.
///
/// xterm's input buffer is finite and it *discards* data on overflow, so a fast
/// writer (`cat` of a big file, a noisy build) can silently corrupt the stream.
/// VS Code's answer, which this mirrors: the renderer acks from xterm's own
/// write callback — i.e. only once the data is really parsed — and the reader
/// stops pulling from the PTY while too much is unacknowledged. The shell then
/// blocks on its own write, which is exactly the backpressure a real terminal
/// applies.
///
/// "Not yet attached" is modelled as "paused" rather than as a buffer. Buffering
/// pre-attach output would mean choosing between dropping bytes — never safe,
/// since a dropped byte desynchronises the escape parser permanently — and an
/// unbounded buffer. Blocking the reader until someone is listening has neither
/// problem, and the kernel's PTY buffer absorbs the slack.
struct FlowControl {
    m: Mutex<FcState>,
    cv: Condvar,
}

impl FlowControl {
    fn new() -> Self {
        Self {
            m: Mutex::new(FcState {
                pending: 0,
                paused: false,
                attached: false,
                closing: false,
            }),
            cv: Condvar::new(),
        }
    }

    /// Blocks until this reader may pull from the PTY again.
    /// Returns `false` when the terminal is shutting down — exit the thread.
    fn acquire_read_slot(&self) -> bool {
        let mut st = lock_recover(&self.m);
        loop {
            if st.closing {
                return false;
            }
            if st.attached && !st.paused {
                return true;
            }
            let (next, _) = self
                .cv
                .wait_timeout(st, FC_POLL_INTERVAL)
                .unwrap_or_else(|p| p.into_inner());
            st = next;
        }
    }

    /// Records data handed to the frontend. Called by the reader, not the
    /// sender: the ledger must bound what has actually left the PTY, or a
    /// reader racing ahead of a slow sender would grow the queue without limit.
    fn on_read(&self, units: usize) {
        let mut st = lock_recover(&self.m);
        st.pending = st.pending.saturating_add(units);
        if st.pending > HIGH_WATERMARK_CHARS {
            st.paused = true;
        }
    }

    fn on_ack(&self, units: usize) {
        let mut st = lock_recover(&self.m);
        // Saturating, not checked: a webview reload can ack data the previous
        // page received, and over-acking must not underflow.
        st.pending = st.pending.saturating_sub(units);
        if st.paused && st.pending < LOW_WATERMARK_CHARS {
            st.paused = false;
            self.cv.notify_all();
        }
    }

    fn attach(&self) {
        let mut st = lock_recover(&self.m);
        st.attached = true;
        self.cv.notify_all();
    }

    fn close(&self) {
        let mut st = lock_recover(&self.m);
        st.closing = true;
        self.cv.notify_all();
    }

    #[cfg(test)]
    fn is_paused(&self) -> bool {
        lock_recover(&self.m).paused
    }

    #[cfg(test)]
    fn pending(&self) -> usize {
        lock_recover(&self.m).pending
    }
}

struct PtyInstance {
    master: Box<dyn MasterPty + Send>,
    /// Behind its own lock so a blocking write can't be taken while the global
    /// window map is held — see `terminal_write`.
    ///
    /// Boxed rather than a `File`: ConPTY has no file descriptor to hand back,
    /// so the Windows writer is whatever portable-pty's `take_writer` returns.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Signalling handle only. The `Child` itself lives on the sender thread,
    /// which blocks in `wait()` to reap it.
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    fc: Arc<FlowControl>,
    /// Never joined: a reader can be blocked inside `read()`, which only
    /// returns once the pty is torn down, so joining under the state lock would
    /// deadlock. They exit on their own once the master drops.
    _reader_thread: Option<thread::JoinHandle<()>>,
    _sender_thread: Option<thread::JoinHandle<()>>,
}

/// Signals everything still running under this pty, then lets it go.
///
/// `killer.kill()` alone is not enough, and neither is signalling the shell's
/// own process group: portable-pty already `setsid()`s the shell, so it leads
/// the session with PGID == PID — but job control puts each *foreground job*
/// (`claude`, vim) in a process group of its own. Signalling the shell's group
/// therefore never reaches them, and closing a pane would orphan whatever was
/// running in it. The group we actually want is the pty's foreground group,
/// which is what `tcgetpgrp` reports.
///
/// Order matters: the foreground group must be read while the master fd is
/// still open.
fn kill_pty_session(
    master: &dyn MasterPty,
    killer: &mut Box<dyn portable_pty::ChildKiller + Send + Sync>,
) {
    #[cfg(unix)]
    {
        if let Some(fg) = master.process_group_leader() {
            // SAFETY: a plain kill(2) on a pgid we just read from this pty.
            unsafe {
                libc::killpg(fg, libc::SIGHUP);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = master;

    // Note this is SIGHUP, not SIGKILL (portable-pty's ChildKiller for unix).
    let _ = killer.kill();
}

/// A one-shot terminal created on an external agent's behalf via the ACP
/// `terminal/*` methods.
///
/// Unlike `PtyInstance` (an interactive xterm the user types into), this runs
/// ONE command, buffers its output into a capped in-memory ring, and captures
/// the exit code — the shape `terminal/output` and `terminal/wait_for_exit`
/// expect. It runs on a PTY rather than plain pipes because agents run tools
/// that behave differently without a TTY: colour, progress bars, and anything
/// that checks `isatty` before deciding to be interactive.
struct AcpTerminal {
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    master: Box<dyn MasterPty + Send>,
    output: Arc<Mutex<Vec<u8>>>,
    truncated: Arc<AtomicBool>,
    /// The exit code once reaped; `None` while the command is still running.
    exit: Arc<Mutex<Option<i32>>>,
    _reader_thread: Option<thread::JoinHandle<()>>,
}

fn kill_acp_terminal(term: &AcpTerminal) {
    let mut child = lock_recover(&term.child);
    let _ = child.kill();
}

struct WindowSlot {
    instances: HashMap<u32, PtyInstance>,
    /// One-shot terminals created for an external agent (see the ACP section
    /// at the bottom of this file). Kept in the same slot as the interactive
    /// ones so a window teardown reaps both — an agent's `npm test` must not
    /// outlive the window that asked for it.
    acp: HashMap<u32, AcpTerminal>,
    next_id: u32,
}

impl WindowSlot {
    fn new() -> Self {
        Self {
            instances: HashMap::new(),
            acp: HashMap::new(),
            next_id: 1,
        }
    }
}

pub struct TerminalState {
    windows: Arc<Mutex<HashMap<String, WindowSlot>>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            windows: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn drop_window(&self, label: &str) {
        let mut map = lock_recover(&self.windows);
        if let Some(mut slot) = map.remove(label) {
            let ids: Vec<u32> = slot.instances.keys().copied().collect();
            for id in ids {
                if let Some(mut inst) = slot.instances.remove(&id) {
                    kill_pty_session(inst.master.as_ref(), &mut inst.killer);
                    // Wake a reader parked waiting to be attached or acked —
                    // e.g. a webview that reloaded before it ever attached, so
                    // no ack is ever coming.
                    inst.fc.close();
                }
            }
            // Agent terminals have no flow control to wake and no killer handle
            // — killing the child is what ends their reader thread.
            for (_id, term) in slot.acp.drain() {
                kill_acp_terminal(&term);
            }
        }
    }
}

/// Reassembles UTF-8 text from arbitrarily-chunked PTY bytes.
///
/// `read(2)` on a PTY master returns whatever bytes happen to be buffered — it
/// has no idea where UTF-8 characters end. Decoding each chunk independently
/// with `from_utf8_lossy` therefore destroys any character that straddles a
/// chunk boundary: the leading bytes become one U+FFFD at the tail of chunk N
/// and the orphaned continuation bytes become another at the head of chunk
/// N+1. The original bytes are gone before xterm.js ever sees them, so the
/// frontend cannot recover them.
///
/// That is not a rare edge case for a TUI. A Claude Code / Ink frame is mostly
/// box-drawing (U+2500 block, 3 bytes each), spinners (`⠋`) and `✓`/`✗`, so
/// roughly a third of arbitrary split points land mid-character. Because Ink
/// repaints cursor-relatively — it wraps to the width it believes and then
/// erases exactly that many lines — a single injected replacement char shifts
/// where a line wraps, the erase count goes wrong, and the damage compounds
/// with every subsequent frame instead of self-correcting.
///
/// So the split must be healed here, at the only place that still has the
/// bytes: hold an incomplete trailing sequence back and prepend it to the next
/// read.
struct Utf8Stitcher {
    /// Bytes of an incomplete trailing sequence, awaiting the next read.
    /// Never exceeds 3 bytes (the longest possible UTF-8 prefix).
    carry: Vec<u8>,
}

impl Utf8Stitcher {
    fn new() -> Self {
        Self {
            carry: Vec::with_capacity(4),
        }
    }

    /// Decodes `bytes`, resuming from any sequence left incomplete last time.
    ///
    /// A trailing *incomplete* sequence is held back for the next call. Bytes
    /// that are genuinely invalid UTF-8 (a shell dumping binary, say) still
    /// become U+FFFD here — they are not held back, since no future byte can
    /// ever make them valid.
    ///
    /// The incomplete/invalid distinction is exactly what `Utf8Error` already
    /// draws, so we let it do the classifying rather than re-deriving it:
    /// `error_len() == None` means "valid so far, ran out of input" (carry it),
    /// `Some(n)` means "definitively wrong" (replace it). A lone continuation
    /// byte reports `Some(1)`, not `None`, which is what keeps `carry` bounded
    /// at the 3 bytes a partial sequence can occupy.
    fn push(&mut self, bytes: &[u8]) -> String {
        if self.carry.is_empty() && bytes.is_empty() {
            return String::new();
        }

        // Resume from whatever the last read left dangling.
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(bytes);

        let mut out = String::with_capacity(buf.len());
        let mut start = 0usize;

        while start < buf.len() {
            match std::str::from_utf8(&buf[start..]) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(err) => {
                    let valid = err.valid_up_to();
                    if valid > 0 {
                        out.push_str(
                            std::str::from_utf8(&buf[start..start + valid])
                                .expect("valid_up_to() bytes are valid UTF-8 by contract"),
                        );
                    }
                    match err.error_len() {
                        None => {
                            // Truncated mid-character: the rest of it is in the
                            // next read. This is the whole point of the type.
                            self.carry.extend_from_slice(&buf[start + valid..]);
                            break;
                        }
                        Some(bad) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            start += valid + bad;
                        }
                    }
                }
            }
        }

        out
    }
}

#[derive(Clone, Serialize)]
struct TerminalOutputPayload {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExitPayload {
    id: u32,
    exit_code: Option<u32>,
}

/// Builds the child shell's environment from the app process's own.
///
/// Extracted from the spawn path purely so it can be tested: reading
/// `std::env` inline made this untestable, and it has two failure modes that
/// only show up in builds you don't run day to day.
///
/// `portable-pty`'s `CommandBuilder` starts from an empty env and `env_clear()`s
/// before applying, so the child sees exactly what this returns — nothing else
/// leaks in, and nothing we omit is inherited by accident.
fn build_child_env(base: impl Iterator<Item = (String, String)>) -> Vec<(String, String)> {
    // Dropped rather than inherited. Two groups:
    //  - the identity of whatever terminal launched *us*. Under `tauri dev`
    //    from iTerm these leak straight through, so the child would advertise
    //    capabilities we don't have — and dev vs bundled builds would disagree.
    //    We set our own below.
    //  - stale geometry, which would fight the winsize set on the pty itself.
    const STRIPPED: &[&str] = &[
        "TERM",
        "COLORTERM",
        "TERMINFO",
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "TERM_SESSION_ID",
        "ITERM_SESSION_ID",
        "ITERM_PROFILE",
        "LC_TERMINAL",
        "LC_TERMINAL_VERSION",
        "COLUMNS",
        "LINES",
    ];

    let mut out: Vec<(String, String)> = base
        .filter(|(k, _)| !STRIPPED.contains(&k.as_str()))
        .collect();

    // Without a real terminfo entry the shell drops to a "dumb" mode where
    // readline/zle line editing — including backspace — is broken.
    out.push(("TERM".to_string(), "xterm-256color".to_string()));
    out.push(("COLORTERM".to_string(), "truecolor".to_string()));
    out.push(("TERM_PROGRAM".to_string(), "Arcane".to_string()));
    out.push((
        "TERM_PROGRAM_VERSION".to_string(),
        env!("CARGO_PKG_VERSION").to_string(),
    ));

    // Launched from Finder/Dock, launchd hands us a minimal environment with no
    // locale at all and the child falls back to C/POSIX — where the box-drawing
    // and emoji a TUI is built from degrade. Only ever *default* it: LC_ALL and
    // LC_CTYPE outrank LANG, so an explicit choice of either must win.
    let has_locale = out
        .iter()
        .any(|(k, _)| matches!(k.as_str(), "LC_ALL" | "LC_CTYPE" | "LANG"));
    if !has_locale {
        out.push(("LANG".to_string(), "en_US.UTF-8".to_string()));
    }

    out
}

fn detect_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

#[cfg(unix)]
fn clone_master_as_writer(master: &dyn MasterPty) -> Result<Box<dyn Write + Send>, String> {
    use std::os::unix::io::FromRawFd;

    let raw_fd = master
        .as_raw_fd()
        .ok_or_else(|| "Failed to get raw fd from master PTY".to_string())?;

    let dup_fd = unsafe { libc::dup(raw_fd) };
    if dup_fd < 0 {
        return Err("Failed to duplicate master PTY fd".to_string());
    }

    Ok(Box::new(unsafe { std::fs::File::from_raw_fd(dup_fd) }))
}

/// ConPTY exposes no descriptor to `dup`, so take portable-pty's own writer.
///
/// This was a stub returning `Err("Windows PTY writer not implemented")`, and
/// `terminal_spawn` propagates it with `?` — so the integrated terminal could
/// never open on Windows, which is the platform most Unity developers use. It
/// was invisible because every PTY test in this file was `#[cfg(unix)]` and no
/// CI job ran the Rust suite on Windows at all.
///
/// `take_writer` may only be called once per master. That is exactly how it is
/// used: `terminal_spawn` calls it a single time and stores the result.
#[cfg(windows)]
fn clone_master_as_writer(master: &dyn MasterPty) -> Result<Box<dyn Write + Send>, String> {
    master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {}", e))
}

/// Reap every PTY belonging to this window's *previous* incarnation.
/// `TerminalState` is keyed by window label and otherwise only
/// ever cleaned up on window destroy, so a webview reload (e.g. Cmd+R, which
/// resets the frontend's terminal store but leaves the Rust process tree
/// alone) would otherwise orphan every shell that was running before the
/// reload. Call this once at boot, before spawning any new terminal for the
/// window — it's a no-op on first launch since there's no prior slot yet.
#[tauri::command]
pub fn terminal_reset_window(window: Window, state: tauri::State<'_, TerminalState>) {
    state.drop_window(window.label());
}

/// Batches PTY output to the frontend, then reaps the child and reports its
/// exit.
///
/// Batching matters because Tauri delivers every event by building a
/// JavaScript source string and `eval`ing it, with each ESC byte inflating to a
/// 6-character `\u001b` escape in the JSON — and a TUI frame is almost all
/// escapes. Un-batched, one full-screen repaint is dozens of evals fighting
/// React for the main thread.
///
/// The window is VS Code's: `terminalDataBuffering.ts` throttles by 5ms,
/// trailing. That is well under the ~30-50ms threshold where added latency
/// becomes perceptible, so keystroke echo still feels immediate while bulk
/// output coalesces.
///
/// Reaping lives here rather than in a third thread so that ordering is free:
/// the channel closing means the reader is done, so the final output flushes
/// strictly before `[Process exited]`.
fn run_output_sender(
    rx: std::sync::mpsc::Receiver<String>,
    handle: AppHandle,
    label: String,
    id: u32,
    child: &mut Box<dyn portable_pty::Child + Send + Sync>,
) {
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Instant;

    let flush = |batch: &mut String| -> bool {
        if batch.is_empty() {
            return true;
        }
        let data = std::mem::take(batch);
        handle
            .emit_to(
                label.as_str(),
                "terminal-output",
                TerminalOutputPayload { id, data },
            )
            .is_ok()
    };

    let mut batch = String::new();
    // Blocks until there is anything at all to send; ends when the reader drops
    // its sender.
    'outer: while let Ok(first) = rx.recv() {
        batch.push_str(&first);

        // Coalesce whatever else arrives inside the window.
        let deadline = Instant::now() + FLUSH_INTERVAL;
        while batch.len() < MAX_BATCH_BYTES {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            match rx.recv_timeout(left) {
                Ok(more) => batch.push_str(&more),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    flush(&mut batch);
                    break 'outer;
                }
            }
        }
        if !flush(&mut batch) {
            break;
        }
    }

    // Reap. Without this every dead shell stays a zombie for the life of the
    // app process, and the real exit status is never available.
    let exit_code = child.wait().ok().map(|status| status.exit_code());
    let _ = handle.emit_to(
        label.as_str(),
        "terminal-exit",
        TerminalExitPayload { id, exit_code },
    );
}

/// Open a PTY for this window.
///
/// `shell` defaults to the user's login shell. `args`, when given, is the exact
/// argv to run instead — and suppresses the `-l` login flag, because the caller
/// wants one specific program on a real TTY rather than an interactive shell.
/// That is what an external agent's sign-in flow needs: its CLI login is a TUI,
/// so it has to run on a PTY the user can actually type into, and reusing the
/// terminal panel means it lands in a tab they already know how to use.
#[tauri::command]
pub fn terminal_spawn(
    app_handle: AppHandle,
    window: Window,
    state: tauri::State<'_, TerminalState>,
    cwd: String,
    shell: Option<String>,
    args: Option<Vec<String>>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<u32, String> {
    let label = window.label().to_string();
    let id = {
        let mut map = lock_recover(&state.windows);
        let slot = map.entry(label.clone()).or_insert_with(WindowSlot::new);
        let current = slot.next_id;
        slot.next_id += 1;
        current
    };

    let pty_system = native_pty_system();
    let pty_size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pair = pty_system
        .openpty(pty_size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell_path = shell.unwrap_or_else(detect_shell);
    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.cwd(&cwd);

    // portable-pty's CommandBuilder starts from an empty env, so the child gets
    // exactly what this returns and nothing else. See build_child_env.
    for (key, value) in build_child_env(std::env::vars()) {
        cmd.env(key, value);
    }

    match args {
        Some(argv) => {
            for arg in argv {
                cmd.arg(arg);
            }
        }
        None => {
            // A login shell, so the user's profile (and therefore their PATH,
            // aliases and prompt) is what they see in the terminal panel.
            #[cfg(unix)]
            {
                cmd.arg("-l");
            }
        }
    }

    // Take the writer and reader BEFORE spawning. Both can fail, and on the
    // old ordering that failure returned after `spawn_command` had already
    // started a shell — which nothing then killed, so every failed attempt
    // orphaned a process. Nothing between here and the spawn needs the child.
    let writer = clone_master_as_writer(pair.master.as_ref())?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Split the signalling handle off the child: `child` itself moves to the
    // sender thread, which blocks in wait() to reap it, and a killer can't be
    // taken from a handle someone else is blocked on.
    let killer = child.clone_killer();

    let master = pair.master;
    let fc = Arc::new(FlowControl::new());

    // reader -> sender. The reader must block in read(); the sender needs a
    // timer to batch. One thread cannot do both, hence the channel.
    let (tx, rx) = std::sync::mpsc::channel::<String>();

    let reader_fc = Arc::clone(&fc);
    let reader_thread = thread::spawn(move || {
        // 64KB rather than 4KB: ~16x fewer syscalls when a shell dumps bulk
        // output, and the stitcher makes the boundary irrelevant now.
        let mut buf = [0u8; 65536];
        let mut stitcher = Utf8Stitcher::new();
        loop {
            // Blocks while the frontend is behind, or before it has attached.
            // The shell then blocks on its own write — real backpressure,
            // rather than letting xterm's buffer overflow and discard.
            if !reader_fc.acquire_read_slot() {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // `read` splits wherever the kernel happens to stop, which
                    // is routinely mid-character for a TUI's box-drawing and
                    // spinner glyphs. Decode across reads, not within one.
                    let data = stitcher.push(&buf[..n]);
                    if data.is_empty() {
                        // The whole read was a partial character; nothing to
                        // show until its remaining bytes arrive.
                        continue;
                    }
                    reader_fc.on_read(utf16_len(&data));
                    if tx.send(data).is_err() {
                        break;
                    }
                }
            }
        }
        // Dropping tx tells the sender to drain, reap and report the exit.
    });

    let handle = app_handle.clone();
    let target_label = label.clone();
    let sender_thread = thread::spawn(move || {
        run_output_sender(rx, handle, target_label, id, &mut child);
    });

    let instance = PtyInstance {
        master,
        writer: Arc::new(Mutex::new(writer)),
        killer,
        fc,
        _reader_thread: Some(reader_thread),
        _sender_thread: Some(sender_thread),
    };

    let mut map = lock_recover(&state.windows);
    let slot = map.entry(label).or_insert_with(WindowSlot::new);
    slot.instances.insert(id, instance);

    Ok(id)
}

/// Starts the flow of output, once the frontend is genuinely listening.
///
/// `terminal_spawn` deliberately leaves the reader parked. Otherwise the shell
/// is already running — sourcing `.zprofile`, printing a prompt — while the
/// frontend is still mounting, and Tauri *silently discards* an emit with no
/// registered listener (it returns `Ok(())`), so that output is simply lost.
/// Parking until attach costs nothing: the kernel's pty buffer holds the slack
/// and the shell blocks if it fills, which is ordinary terminal behaviour.
///
/// Idempotent — React re-runs effects in StrictMode, and a second attach must
/// not disturb a running terminal.
#[tauri::command]
pub fn terminal_attach(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let label = window.label();
    let map = lock_recover(&state.windows);
    let slot = map
        .get(label)
        .ok_or_else(|| format!("No terminal window slot for {}", label))?;
    let instance = slot
        .instances
        .get(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;

    // Size before unparking, so the first thing the shell's output is measured
    // against is the real geometry rather than the 80x24 placeholder.
    let _ = instance.master.resize(PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    });
    instance.fc.attach();
    Ok(())
}

/// Acknowledges rendered output, in UTF-16 units to match JS `String.length`.
/// The frontend sends this from xterm's write callback, so it means "parsed",
/// not merely "received".
#[tauri::command]
pub fn terminal_ack(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
    count: usize,
) -> Result<(), String> {
    let label = window.label();
    let map = lock_recover(&state.windows);
    let Some(slot) = map.get(label) else {
        return Ok(());
    };
    // A late ack for a pane that's already gone is normal, not an error.
    if let Some(instance) = slot.instances.get(&id) {
        instance.fc.on_ack(count);
    }
    Ok(())
}

/// `async` so this runs on the threadpool rather than the IPC thread: a
/// non-async `#[tauri::command]` is dispatched as "sync", and `write_all` on a
/// pty master blocks whenever the child stops draining stdin (a big paste into
/// something not reading). Blocking the IPC thread would stall every command in
/// the app, not just this terminal.
#[tauri::command(async)]
pub fn terminal_write(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let label = window.label();
    // Clone the per-terminal writer handle out and release the global map lock
    // before touching the fd, for the same reason: holding it across a blocking
    // write would serialise every other terminal — including their resizes —
    // behind one stuck child.
    let writer = {
        let map = lock_recover(&state.windows);
        let slot = map
            .get(label)
            .ok_or_else(|| format!("No terminal window slot for {}", label))?;
        let instance = slot
            .instances
            .get(&id)
            .ok_or_else(|| format!("Terminal {} not found", id))?;
        Arc::clone(&instance.writer)
    };

    lock_recover(&writer)
        .write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to terminal {}: {}", id, e))?;

    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let label = window.label();
    let map = lock_recover(&state.windows);
    let slot = map
        .get(label)
        .ok_or_else(|| format!("No terminal window slot for {}", label))?;
    let instance = slot
        .instances
        .get(&id)
        .ok_or_else(|| format!("Terminal {} not found", id))?;

    instance
        .master
        // Clamped: a hidden or mid-teardown pane can measure zero, and a 0x0
        // winsize is meaningless to the child.
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to resize terminal {}: {}", id, e))?;

    Ok(())
}

/// Writes the clipboard's image, if there is one, to a PNG in the temp dir and
/// returns its path. `Ok(None)` means "no image on the clipboard" — the
/// ordinary case for a text paste, not an error.
///
/// A terminal is a byte stream: there is no way to hand a TUI an actual image
/// through a paste, which is why Claude Code reads the system clipboard itself
/// on Ctrl+V rather than trusting the terminal to deliver one. For Cmd+V —
/// which macOS routes through the webview as a text-only paste, so the image
/// never survives — the closest honest equivalent is to spill the image to
/// disk and paste its path, which Claude Code accepts.
///
/// This lives in Rust because the clipboard yields *raw RGBA*, not an encoded
/// image: a 1920x1080 screenshot is ~8MB of pixels, and shipping that across
/// the IPC to re-encode it in a canvas would be silly when the encoder can sit
/// next to the reader.
#[tauri::command]
pub fn terminal_clipboard_image_to_temp(app_handle: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let image = match app_handle.clipboard().read_image() {
        Ok(img) => img,
        // Every platform reports "there is no image here" as an error of some
        // kind; none of them are worth surfacing to the user mid-paste.
        Err(_) => return Ok(None),
    };

    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 {
        return Ok(None);
    }

    let dir = std::env::temp_dir().join("unityide-terminal-paste");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create paste dir: {}", e))?;

    // Nanos keep repeated pastes from clobbering each other; a previously
    // pasted path may still be referenced by a running agent.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("pasted-image-{}.png", stamp));

    let file =
        std::fs::File::create(&path).map_err(|e| format!("Failed to create paste file: {}", e))?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("Failed to write PNG header: {}", e))?;
    writer
        .write_image_data(image.rgba())
        .map_err(|e| format!("Failed to encode pasted image: {}", e))?;
    writer
        .finish()
        .map_err(|e| format!("Failed to finish PNG: {}", e))?;

    Ok(Some(path.to_string_lossy().into_owned()))
}

// ── ACP terminals (`terminal/*` from an external agent) ──────────────────────
//
// These run a specific command rather than a login shell, buffer output into a
// capped ring, and capture the exit code. Output is pulled (`terminal/output`)
// rather than pushed, because ACP's contract is that the agent asks — so there
// is no event, no flow control, and no ack protocol here.

/// 1 MiB. Generous enough for a test run's output, small enough that a runaway
/// command cannot exhaust memory. An agent may request less, never more than it
/// asks for, and never less than 1 KiB.
const ACP_DEFAULT_OUTPUT_LIMIT: usize = 1024 * 1024;

#[derive(Deserialize)]
pub struct AcpEnvVar {
    name: String,
    value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpTerminalOutputResult {
    output: String,
    truncated: bool,
    exited: bool,
    exit_code: Option<i32>,
    signal: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpTerminalWaitResult {
    exit_code: Option<i32>,
    signal: Option<String>,
}

#[tauri::command]
pub fn acp_terminal_create(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Vec<AcpEnvVar>,
    output_byte_limit: Option<usize>,
) -> Result<u32, String> {
    let label = window.label().to_string();
    let id = {
        let mut map = lock_recover(&state.windows);
        let slot = map.entry(label.clone()).or_insert_with(WindowSlot::new);
        let current = slot.next_id;
        slot.next_id += 1;
        current
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new(&command);
    for arg in &args {
        cmd.arg(arg);
    }
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
    }
    // Inherit the parent environment, force a real terminfo entry, then apply
    // the agent's overrides last so they win.
    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    for ev in &env {
        cmd.env(&ev.name, &ev.value);
    }
    // Note the absence of `-l`: this is a direct command, not a login shell.

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to run '{}': {}", command, e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

    let limit = output_byte_limit
        .unwrap_or(ACP_DEFAULT_OUTPUT_LIMIT)
        .max(1024);
    let output = Arc::new(Mutex::new(Vec::<u8>::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let exit = Arc::new(Mutex::new(None::<i32>));
    let child = Arc::new(Mutex::new(child));

    let output_c = output.clone();
    let truncated_c = truncated.clone();
    let exit_c = exit.clone();
    let child_c = child.clone();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut out = lock_recover(&output_c);
                    if out.len() >= limit {
                        truncated_c.store(true, Ordering::Relaxed);
                    } else {
                        let space = limit - out.len();
                        if n <= space {
                            out.extend_from_slice(&buf[..n]);
                        } else {
                            // Keep the head, not the tail: the agent asked for a
                            // byte limit, and a command's first output is where
                            // its errors usually are.
                            out.extend_from_slice(&buf[..space]);
                            truncated_c.store(true, Ordering::Relaxed);
                        }
                    }
                }
            }
        }
        // EOF on the PTY. Poll for the exit status rather than blocking on
        // wait(), so a concurrent `terminal/kill` can still take the child lock.
        loop {
            {
                let mut ch = lock_recover(&child_c);
                match ch.try_wait() {
                    Ok(Some(status)) => {
                        *lock_recover(&exit_c) = Some(status.exit_code() as i32);
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        *lock_recover(&exit_c) = Some(-1);
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    });

    let term = AcpTerminal {
        child,
        master: pair.master,
        output,
        truncated,
        exit,
        _reader_thread: Some(reader_thread),
    };

    let mut map = lock_recover(&state.windows);
    let slot = map.entry(label).or_insert_with(WindowSlot::new);
    slot.acp.insert(id, term);
    Ok(id)
}

#[tauri::command]
pub fn acp_terminal_output(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<AcpTerminalOutputResult, String> {
    let label = window.label();
    let map = lock_recover(&state.windows);
    let slot = map
        .get(label)
        .ok_or_else(|| format!("No terminal slot for window {}", label))?;
    let term = slot
        .acp
        .get(&id)
        .ok_or_else(|| format!("Agent terminal {} not found", id))?;

    let bytes = lock_recover(&term.output).clone();
    // Lossy on purpose: the buffer is capped mid-stream, so its tail can be a
    // partial UTF-8 sequence. Replacement characters beat refusing to report.
    let output = String::from_utf8_lossy(&bytes).to_string();
    let exit_code = *lock_recover(&term.exit);
    Ok(AcpTerminalOutputResult {
        output,
        truncated: term.truncated.load(Ordering::Relaxed),
        exited: exit_code.is_some(),
        exit_code,
        signal: None,
    })
}

#[tauri::command]
pub async fn acp_terminal_wait(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<AcpTerminalWaitResult, String> {
    let label = window.label().to_string();
    loop {
        {
            let map = lock_recover(&state.windows);
            let slot = map
                .get(&label)
                .ok_or_else(|| format!("No terminal slot for window {}", label))?;
            let term = slot
                .acp
                .get(&id)
                .ok_or_else(|| format!("Agent terminal {} not found", id))?;
            // Bound to a local first: an `if let` on the deref would keep the
            // MutexGuard temporary alive to the end of the block, outliving the
            // `map` guard it borrows from.
            let exit_code = *lock_recover(&term.exit);
            if let Some(code) = exit_code {
                return Ok(AcpTerminalWaitResult {
                    exit_code: Some(code),
                    signal: None,
                });
            }
        }
        // Every guard above is released before this await. Holding a std Mutex
        // across an await point would deadlock the whole terminal subsystem.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tauri::command]
pub fn acp_terminal_kill(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<(), String> {
    let label = window.label();
    let map = lock_recover(&state.windows);
    if let Some(term) = map.get(label).and_then(|slot| slot.acp.get(&id)) {
        kill_acp_terminal(term);
    }
    Ok(())
}

/// Drop a terminal the agent is finished with. Kills it first: ACP lets an
/// agent release a terminal it never waited on, and a released handle with a
/// live process behind it is a leak.
#[tauri::command]
pub fn acp_terminal_release(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<(), String> {
    let label = window.label();
    let mut map = lock_recover(&state.windows);
    if let Some(slot) = map.get_mut(label) {
        if let Some(term) = slot.acp.remove(&id) {
            kill_acp_terminal(&term);
            drop(term.master);
        }
    }
    Ok(())
}

#[cfg(test)]
mod env_tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        build_child_env(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<Vec<_>>()
                .into_iter(),
        )
    }

    fn get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    fn count(env: &[(String, String)], key: &str) -> usize {
        env.iter().filter(|(k, _)| k == key).count()
    }

    #[test]
    fn forces_a_real_terminfo_entry() {
        let env = env_of(&[("TERM", "dumb")]);
        assert_eq!(get(&env, "TERM"), Some("xterm-256color"));
        assert_eq!(get(&env, "COLORTERM"), Some("truecolor"));
        // Exactly one, or the child's behaviour depends on which wins.
        assert_eq!(count(&env, "TERM"), 1, "TERM must not be defined twice");
    }

    #[test]
    fn passes_through_unrelated_variables() {
        let env = env_of(&[("PATH", "/usr/bin"), ("HOME", "/Users/me")]);
        assert_eq!(get(&env, "PATH"), Some("/usr/bin"));
        assert_eq!(get(&env, "HOME"), Some("/Users/me"));
    }

    /// Under `tauri dev` the app inherits the launching terminal's identity, so
    /// without stripping it the child would claim to be iTerm — and dev and
    /// bundled builds would present different environments for the same code.
    #[test]
    fn replaces_the_launching_terminals_identity_with_our_own() {
        let env = env_of(&[
            ("TERM_PROGRAM", "iTerm.app"),
            ("TERM_PROGRAM_VERSION", "3.5.0"),
        ]);
        assert_eq!(get(&env, "TERM_PROGRAM"), Some("Arcane"));
        assert_eq!(count(&env, "TERM_PROGRAM"), 1);
        assert_ne!(get(&env, "TERM_PROGRAM_VERSION"), Some("3.5.0"));
    }

    #[test]
    fn strips_launching_terminal_session_variables() {
        let env = env_of(&[
            ("ITERM_SESSION_ID", "w0t0p0"),
            ("ITERM_PROFILE", "Default"),
            ("TERM_SESSION_ID", "abc"),
            ("LC_TERMINAL", "iTerm2"),
            ("LC_TERMINAL_VERSION", "3.5.0"),
        ]);
        for k in [
            "ITERM_SESSION_ID",
            "ITERM_PROFILE",
            "TERM_SESSION_ID",
            "LC_TERMINAL",
            "LC_TERMINAL_VERSION",
        ] {
            assert_eq!(get(&env, k), None, "{k} leaked into the child");
        }
    }

    /// Launched from Finder/Dock, launchd hands the app a minimal environment
    /// with no locale, so the shell falls back to C/POSIX and every non-ASCII
    /// glyph a TUI draws degrades. Only bites bundled builds, never `tauri dev`.
    #[test]
    fn defaults_the_locale_when_launchd_provides_none() {
        let env = env_of(&[("PATH", "/usr/bin")]);
        assert_eq!(get(&env, "LANG"), Some("en_US.UTF-8"));
    }

    #[test]
    fn never_overrides_an_explicit_locale() {
        assert_eq!(get(&env_of(&[("LANG", "de_DE.UTF-8")]), "LANG"), Some("de_DE.UTF-8"));
        assert_eq!(count(&env_of(&[("LANG", "de_DE.UTF-8")]), "LANG"), 1);
    }

    /// LC_ALL/LC_CTYPE outrank LANG, so defaulting LANG when either is set
    /// would be pointless at best and confusing at worst.
    #[test]
    fn an_existing_lc_setting_suppresses_the_lang_default() {
        assert_eq!(get(&env_of(&[("LC_ALL", "C")]), "LANG"), None);
        assert_eq!(get(&env_of(&[("LC_CTYPE", "en_GB.UTF-8")]), "LANG"), None);
    }

    /// Stale sizes from the launching terminal would fight the winsize we set
    /// on the pty itself.
    #[test]
    fn strips_inherited_terminal_dimensions() {
        let env = env_of(&[("COLUMNS", "80"), ("LINES", "24")]);
        assert_eq!(get(&env, "COLUMNS"), None);
        assert_eq!(get(&env, "LINES"), None);
    }
}

#[cfg(test)]
mod flow_control_tests {
    use super::*;
    use std::sync::mpsc;

    /// Runs `acquire_read_slot` on another thread and reports what it did
    /// within `wait`. `None` == still blocked, which is the assertion most of
    /// these tests actually care about.
    fn slot_within(fc: &Arc<FlowControl>, wait: Duration) -> Option<bool> {
        let (tx, rx) = mpsc::channel();
        let fc2 = Arc::clone(fc);
        thread::spawn(move || {
            let _ = tx.send(fc2.acquire_read_slot());
        });
        rx.recv_timeout(wait).ok()
    }

    #[test]
    fn utf16_len_counts_what_javascript_counts() {
        // The unit the frontend's `data.length` ack will use. Getting this
        // wrong makes `pending` drift up forever on non-ASCII output.
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("─"), 1); // 3 bytes, 1 UTF-16 unit
        assert_eq!(utf16_len("⠋"), 1);
        assert_eq!(utf16_len("🚀"), 2); // surrogate pair
        assert_eq!(utf16_len("a🚀─"), 4);
        assert_ne!(utf16_len("─"), "─".len(), "bytes and UTF-16 units differ");
    }

    #[test]
    fn reader_is_blocked_until_attached() {
        let fc = Arc::new(FlowControl::new());
        assert_eq!(
            slot_within(&fc, Duration::from_millis(150)),
            None,
            "reader must not pull from the PTY before anyone is listening"
        );

        fc.attach();
        assert_eq!(slot_within(&fc, Duration::from_secs(2)), Some(true));
    }

    #[test]
    fn reader_runs_freely_below_the_high_watermark() {
        let fc = Arc::new(FlowControl::new());
        fc.attach();
        fc.on_read(HIGH_WATERMARK_CHARS - 1);
        assert!(!fc.is_paused());
        assert_eq!(slot_within(&fc, Duration::from_secs(2)), Some(true));
    }

    #[test]
    fn reader_pauses_once_pending_exceeds_the_high_watermark() {
        let fc = Arc::new(FlowControl::new());
        fc.attach();
        fc.on_read(HIGH_WATERMARK_CHARS + 1);
        assert!(fc.is_paused());
        assert_eq!(
            slot_within(&fc, Duration::from_millis(150)),
            None,
            "reader must stop pulling while the frontend is behind"
        );
    }

    /// The hysteresis test. Resuming as soon as `pending` drops below HIGH
    /// would flap: one read pushes it over, one small ack pulls it under, and
    /// the reader thrashes. It must stay paused all the way down to LOW.
    #[test]
    fn reader_stays_paused_between_the_low_and_high_watermarks() {
        let fc = Arc::new(FlowControl::new());
        fc.attach();
        fc.on_read(HIGH_WATERMARK_CHARS + 1);
        assert!(fc.is_paused());

        // Ack back to just above LOW — below HIGH, but not low enough.
        fc.on_ack(HIGH_WATERMARK_CHARS + 1 - (LOW_WATERMARK_CHARS + 1));
        assert_eq!(fc.pending(), LOW_WATERMARK_CHARS + 1);
        assert!(
            fc.is_paused(),
            "resuming above the low watermark would flap the reader"
        );
        assert_eq!(slot_within(&fc, Duration::from_millis(150)), None);
    }

    #[test]
    fn reader_resumes_once_pending_drops_below_the_low_watermark() {
        let fc = Arc::new(FlowControl::new());
        fc.attach();
        fc.on_read(HIGH_WATERMARK_CHARS + 1);
        fc.on_ack(HIGH_WATERMARK_CHARS + 1);
        assert!(!fc.is_paused());
        assert_eq!(fc.pending(), 0);
        assert_eq!(slot_within(&fc, Duration::from_secs(2)), Some(true));
    }

    /// The anti-deadlock test. A paused reader owns a live PTY; if close can't
    /// wake it the thread leaks and the shell is never reaped.
    #[test]
    fn close_wakes_a_paused_reader() {
        let fc = Arc::new(FlowControl::new());
        fc.attach();
        fc.on_read(HIGH_WATERMARK_CHARS + 1);
        assert_eq!(slot_within(&fc, Duration::from_millis(150)), None);

        fc.close();
        assert_eq!(
            slot_within(&fc, Duration::from_secs(2)),
            Some(false),
            "close must wake a paused reader and tell it to stop"
        );
    }

    /// The webview died before it ever attached — e.g. a reload between spawn
    /// and attach. The reader is parked on a condition that will never come.
    #[test]
    fn close_wakes_a_reader_that_never_attached() {
        let fc = Arc::new(FlowControl::new());
        assert_eq!(slot_within(&fc, Duration::from_millis(150)), None);
        fc.close();
        assert_eq!(slot_within(&fc, Duration::from_secs(2)), Some(false));
    }

    #[test]
    fn closing_beats_attached_so_a_closed_terminal_never_resumes() {
        let fc = Arc::new(FlowControl::new());
        fc.attach();
        fc.close();
        assert_eq!(slot_within(&fc, Duration::from_secs(2)), Some(false));
    }

    /// A reload can ack data the previous page consumed, so an ack may exceed
    /// what we think is outstanding. It must floor at zero, not underflow.
    #[test]
    fn an_ack_larger_than_pending_saturates_to_zero() {
        let fc = Arc::new(FlowControl::new());
        fc.attach();
        fc.on_read(10);
        fc.on_ack(999_999);
        assert_eq!(fc.pending(), 0);
        assert!(!fc.is_paused());
    }

    /// The gate, against a real pty and the real reader-loop shape.
    ///
    /// This is the one that matters: attach is now the single thing standing
    /// between a spawned shell and any output at all, so a gate that holds shut
    /// means a permanently blank terminal. It also pins the reason the gate is
    /// safe — the shell runs to completion while parked and nothing is lost,
    /// because the kernel's pty buffer holds it until someone reads.
    #[cfg(unix)]
    #[test]
    fn parked_reader_loses_nothing_and_delivers_it_all_on_attach() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let pty = native_pty_system();
        let Ok(pair) = pty.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }) else {
            return; // sandboxed CI without a pty: skip, don't fail
        };

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("printf 'hello ─ ⠋'");
        let Ok(mut child) = pair.slave.spawn_command(cmd) else {
            return;
        };
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("clone reader");

        let fc = Arc::new(FlowControl::new());
        let (tx, rx) = mpsc::channel::<String>();
        let reader_fc = Arc::clone(&fc);
        thread::spawn(move || {
            let mut buf = [0u8; 65536];
            let mut stitcher = Utf8Stitcher::new();
            loop {
                if !reader_fc.acquire_read_slot() {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = stitcher.push(&buf[..n]);
                        if data.is_empty() {
                            continue;
                        }
                        reader_fc.on_read(utf16_len(&data));
                        if tx.send(data).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // The shell has already run and written by now. Nothing may reach the
        // frontend while it isn't listening.
        assert!(
            rx.recv_timeout(Duration::from_millis(250)).is_err(),
            "output escaped before attach — it would have been discarded"
        );

        fc.attach();

        let mut got = String::new();
        while let Ok(chunk) = rx.recv_timeout(Duration::from_secs(2)) {
            got.push_str(&chunk);
            if got.contains('⠋') {
                break;
            }
        }
        assert!(
            got.contains("hello ─ ⠋"),
            "output written before attach was lost; got {got:?}"
        );

        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every platform this app ships on must be able to write to a PTY.
    ///
    /// Deliberately NOT `#[cfg(unix)]`. The Windows implementation was a stub
    /// that always returned `Err`, so the terminal could not open at all on the
    /// platform most Unity developers use — and it survived because every test
    /// that touched a real PTY was gated to unix, making the Windows path
    /// literally untested. A gate here would recreate that blind spot exactly.
    #[test]
    fn master_writer_is_available_on_every_platform() {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let writer = clone_master_as_writer(pair.master.as_ref());
        assert!(
            writer.is_ok(),
            "no PTY writer on this platform: {:?}",
            writer.err()
        );
    }

    /// A frame shaped like the real thing: box-drawing borders, a spinner
    /// frame, a check mark and an emoji — i.e. the 2- 3- and 4-byte sequences
    /// a Claude Code repaint is actually made of.
    fn tui_frame() -> String {
        let mut s = String::new();
        s.push('╭');
        for _ in 0..78 {
            s.push('─');
        }
        s.push_str("╮\n");
        for i in 0..40 {
            s.push_str(&format!("│ \u{1b}[32m⠋\u{1b}[0m Thinking… ✓ ✗ 🚀 line {i} │\n"));
        }
        s.push('╰');
        for _ in 0..78 {
            s.push('─');
        }
        s.push_str("╯\n");
        s
    }

    /// The regression gate. Every offset is a boundary the kernel could
    /// actually hand us, so every offset must round-trip byte-identically.
    #[test]
    fn reassembles_multibyte_glyphs_split_at_every_byte_offset() {
        let frame = tui_frame();
        let bytes = frame.as_bytes();

        for split in 0..=bytes.len() {
            let mut stitcher = Utf8Stitcher::new();
            let mut out = String::new();
            out.push_str(&stitcher.push(&bytes[..split]));
            out.push_str(&stitcher.push(&bytes[split..]));

            assert_eq!(
                out, frame,
                "stream corrupted when split at byte offset {split}"
            );
        }
    }

    /// The same stream through many small reads, the way a busy PTY actually
    /// delivers a repaint.
    #[test]
    fn reassembles_a_stream_delivered_in_small_reads() {
        let frame = tui_frame();
        let bytes = frame.as_bytes();

        for chunk_size in [1usize, 2, 3, 5, 7, 64, 4096] {
            let mut stitcher = Utf8Stitcher::new();
            let mut out = String::new();
            for chunk in bytes.chunks(chunk_size) {
                out.push_str(&stitcher.push(chunk));
            }
            assert_eq!(out, frame, "stream corrupted at chunk size {chunk_size}");
        }
    }

    #[test]
    fn holds_back_an_incomplete_trailing_sequence_until_it_completes() {
        let mut stitcher = Utf8Stitcher::new();

        // '─' is E2 94 80. Feed only the first two bytes.
        assert_eq!(stitcher.push(&[0xE2, 0x94]), "");
        // The final byte completes it.
        assert_eq!(stitcher.push(&[0x80]), "─");
    }

    #[test]
    fn emits_ready_text_immediately_and_only_holds_back_the_partial_tail() {
        let mut stitcher = Utf8Stitcher::new();

        // "ok" plus the first 2 bytes of '─'.
        assert_eq!(stitcher.push(b"ok\xE2\x94"), "ok");
        assert_eq!(stitcher.push(&[0x80]), "─");
    }

    /// Genuinely invalid bytes can never become valid, so they must be
    /// replaced now rather than held back — otherwise a shell dumping binary
    /// would stall the stream forever.
    #[test]
    fn replaces_genuinely_invalid_bytes_without_carrying_them() {
        let mut stitcher = Utf8Stitcher::new();

        // 0xFF is never valid in UTF-8.
        assert_eq!(stitcher.push(&[b'a', 0xFF, b'b']), "a\u{FFFD}b");
        // Nothing was carried: the next read stands on its own.
        assert_eq!(stitcher.push(b"c"), "c");
    }

    /// A lone continuation byte is invalid, not "incomplete" — it must not be
    /// carried, or a stream of them would grow the buffer without bound.
    #[test]
    fn never_carries_more_than_three_bytes() {
        let mut stitcher = Utf8Stitcher::new();

        let junk = vec![0x80u8; 8192];
        let out = stitcher.push(&junk);

        assert!(!out.is_empty(), "orphaned continuation bytes must surface");
        assert!(
            stitcher.carry.len() <= 3,
            "carry grew to {} bytes; a partial UTF-8 prefix is at most 3",
            stitcher.carry.len()
        );
    }

    /// Binary output must not stall the stream or corrupt what follows it.
    #[test]
    fn recovers_after_binary_garbage() {
        let mut stitcher = Utf8Stitcher::new();

        stitcher.push(&[0xFF, 0xFE, 0x00, 0x80, 0xC0]);
        assert_eq!(stitcher.push("─ back to normal ✓".as_bytes()), "─ back to normal ✓");
    }

    /// ANSI escapes are pure ASCII, so they were never damaged by the old
    /// lossy decode — but they must survive the new path untouched, including
    /// when a CSI sequence is split across reads.
    #[test]
    fn passes_ansi_escape_sequences_through_byte_identical() {
        let mut stitcher = Utf8Stitcher::new();
        let mut out = String::new();

        out.push_str(&stitcher.push(b"\x1b[3"));
        out.push_str(&stitcher.push(b"2m green \x1b[0m"));

        assert_eq!(out, "\u{1b}[32m green \u{1b}[0m");
    }

    #[test]
    fn empty_reads_are_harmless() {
        let mut stitcher = Utf8Stitcher::new();
        assert_eq!(stitcher.push(b""), "");
        assert_eq!(stitcher.push("✓".as_bytes()), "✓");
    }

    /// End-to-end through a real PTY, because the synthetic tests above only
    /// prove the stitcher is correct in isolation — they cannot prove the
    /// reader thread actually uses it, and this panel has a history of being
    /// "fixed" while the real path stayed broken.
    ///
    /// The read buffer is deliberately 3 bytes so that a 3-byte box-drawing
    /// glyph is split by nearly every read, which is the worst case the kernel
    /// can hand us and the one that shredded Claude Code.
    #[cfg(unix)]
    #[test]
    fn real_pty_output_survives_reads_that_split_every_glyph() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let expected = "╭─────╮\n│ ⠋ ✓ ✗ 🚀 │\n╰─────╯\n";

        let pty = native_pty_system();
        let pair = match pty.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(p) => p,
            // Sandboxed CI may not grant a pty; skip rather than fail.
            Err(_) => return,
        };

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg(format!("printf '%s' '{expected}'"));
        let mut child = match pair.slave.spawn_command(cmd) {
            Ok(c) => c,
            Err(_) => return,
        };
        // Drop the slave so the reader sees EOF once the child is done.
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("clone reader");
        let mut stitcher = Utf8Stitcher::new();
        let mut out = String::new();
        // Decode the same reads the old way too, so this test can prove it
        // actually reproduces the bug rather than passing for free.
        let mut naive = String::new();
        // 3 bytes: small enough to split essentially every multi-byte glyph.
        let mut buf = [0u8; 3];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    out.push_str(&stitcher.push(&buf[..n]));
                    naive.push_str(&String::from_utf8_lossy(&buf[..n]));
                }
            }
        }
        let _ = child.wait();

        // The pty is in canonical mode and translates \n to \r\n on output;
        // normalise that, it is not what this test is about.
        let normalised = out.replace("\r\n", "\n");
        assert!(
            !normalised.contains('\u{FFFD}'),
            "replacement chars in real pty output: {normalised:?}"
        );
        assert_eq!(
            normalised, expected,
            "real pty output was corrupted by chunked reads"
        );

        // Guards the guard: if this ever stops holding, the reads stopped
        // landing mid-glyph and the assertions above have gone vacuous.
        assert!(
            naive.contains('\u{FFFD}'),
            "expected the old per-read from_utf8_lossy to corrupt this stream — \
             it did not, so this test no longer reproduces the bug it guards"
        );
    }
}

#[tauri::command]
pub fn terminal_kill(
    window: Window,
    state: tauri::State<'_, TerminalState>,
    id: u32,
) -> Result<(), String> {
    let label = window.label();
    let mut map = lock_recover(&state.windows);
    if let Some(slot) = map.get_mut(label) {
        if let Some(mut instance) = slot.instances.remove(&id) {
            // Signal the whole foreground group, not just the shell, or a
            // `claude`/vim running in this pane is orphaned and survives it.
            kill_pty_session(instance.master.as_ref(), &mut instance.killer);
            // Wake the reader if it's parked rather than blocked in read().
            instance.fc.close();
            // Closing the master lets a reader blocked in read() return, which
            // ends the sender, which reaps the child.
            drop(instance.master);
        }
    }
    Ok(())
}
