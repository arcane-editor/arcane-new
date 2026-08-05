//! Loopback HTTP listener for browser sign-in (RFC 8252 §7.3).
//!
//! Deep links need OS-level scheme registration, which macOS grants only to an
//! installed .app bundle — so under `tauri dev` on macOS a deep link launches
//! the (stale) bundled build rather than the dev process. This listener is the
//! transport used wherever the scheme is not registered: the website redirects
//! the browser to `http://127.0.0.1:<port>/callback?code=…&state=…`, we read
//! the query and EMIT it to the frontend as an event.
//!
//! The listener KEEPS serving after each callback — it does not shut down on
//! the first one. Rust deliberately does not know the correct `state` (that
//! comparison lives in browser-login.ts, in one place, shared with the
//! deep-link path), so a forged/mismatched `GET /callback?code=x&state=WRONG`
//! must NOT tear the listener down: the frontend's state check ignores the
//! forged callback and the genuine one still lands. The listener is closed
//! explicitly — via `auth_loopback_stop`, driven by the frontend's teardown
//! (consume, cancel, timeout, supersede) — or reaped by `LISTENER_TTL`.
//!
//! This module TRANSPORTS ONLY. It never validates `state`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Process-wide monotonic id, one per `auth_loopback_start` attempt. Lets a
/// spawned task tell whether the map entry under its port still belongs to
/// it before self-removing — ephemeral ports get reused, so the port alone
/// is not a reliable ownership check (see `LoopbackState` doc).
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

/// Event carrying the callback params to the frontend.
pub const LOOPBACK_EVENT: &str = "auth-loopback-callback";

/// Matches the frontend's 10-minute login timeout, so an abandoned attempt
/// cannot leak a bound socket indefinitely.
const LISTENER_TTL: Duration = Duration::from_secs(600);

/// Per-connection read timeout. A connection that accepts but never sends
/// bytes (port scanner, security tool probe, browser preconnect) must not
/// block the serve loop from calling `accept()` again — otherwise it starves
/// the listener until `LISTENER_TTL` fires and drops a legitimate callback
/// that arrives in the meantime.
///
/// Shortened under `cfg(test)` so the regression test proving this doesn't
/// have to burn 5 real seconds of wall-clock (tokio's virtual-time test
/// utilities aren't in this crate's feature set) — production always uses
/// the 5s value.
#[cfg(not(test))]
const READ_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const READ_TIMEOUT: Duration = Duration::from_millis(200);

/// Backoff after a transient `accept()` error (e.g. EMFILE), so a persistent
/// error retries instead of busy-spinning the CPU for the remainder of
/// `LISTENER_TTL`.
const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(100);

const RESPONSE_BODY: &str = concat!(
    "<!doctype html><meta charset=\"utf-8\"><title>Signed in</title>",
    "<body style=\"font-family:system-ui;text-align:center;padding-top:4rem\">",
    "<h1>You're signed in</h1><p>You can close this tab and return to Arcane.</p></body>"
);

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoopbackCallback {
    pub code: String,
    pub state: String,
}

/// Managed state: maps each live loopback listener's port to a stopper that
/// closes it. `auth_loopback_stop` takes the port's sender and fires it; the
/// spawned serve task removes its own entry when it exits (stop signal, TTL,
/// or bind teardown). Keyed by port because that is the only handle the
/// frontend has to identify which listener to close.
///
/// The value also carries the attempt's unique `id` (see `NEXT_ID`). Ports
/// are ephemeral and get reused: if attempt A's task is still unwinding when
/// attempt B binds the very port A just freed, A's task must NOT delete B's
/// freshly-inserted entry out from under it. Each task therefore only
/// self-removes the map entry if it still holds ITS OWN id.
pub struct LoopbackState {
    stoppers: Mutex<HashMap<u16, (u64, oneshot::Sender<()>)>>,
}

impl LoopbackState {
    pub fn new() -> Self {
        Self { stoppers: Mutex::new(HashMap::new()) }
    }
}

impl Default for LoopbackState {
    fn default() -> Self {
        Self::new()
    }
}

/// Minimal percent-decoder for query values. `+` is deliberately NOT decoded
/// as space: these values are base64url tokens and `encodeURIComponent` never
/// emits `+`, so treating it as a literal keeps a `+`-bearing code intact.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Parse `code` + `state` out of an HTTP request line such as
/// `GET /callback?code=abc&state=xyz HTTP/1.1`. Returns None unless the method
/// is GET, the path is exactly `/callback`, and BOTH params are present and
/// non-empty. Anything else is somebody else's request (favicon prefetch, a
/// port scanner) and gets a 404 — it must not be emitted as a callback.
pub fn parse_request_line(line: &str) -> Option<LoopbackCallback> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let (path, query) = parts.next()?.split_once('?')?;
    if path != "/callback" {
        return None;
    }
    let mut code = None;
    let mut state = None;
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else { continue };
        match k {
            "code" => code = percent_decode(v),
            "state" => state = percent_decode(v),
            _ => {}
        }
    }
    Some(LoopbackCallback {
        code: code.filter(|s| !s.is_empty())?,
        state: state.filter(|s| !s.is_empty())?,
    })
}

/// Accept connections and hand each parsed callback to `on_callback`, then KEEP
/// serving. Never returns on its own — the caller's `tokio::select!` stops it
/// via the stop signal or `LISTENER_TTL`.
///
/// A request that doesn't parse as a callback gets a 404 and is ignored (a
/// browser prefetching `/favicon.ico` must not disturb the listener). A parsed
/// callback — INCLUDING a forged/mismatched one, which this layer cannot tell
/// apart because it never sees the correct `state` — is emitted and the loop
/// continues, so the genuine callback still lands after any decoys. The HTTP
/// response body never echoes `code` or `state`.
async fn serve_loop<F>(listener: TcpListener, on_callback: F)
where
    F: Fn(LoopbackCallback) + Send,
{
    loop {
        let (mut stream, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(_) => {
                // A transient accept error (e.g. EMFILE) must not end the
                // sign-in attempt outright, but retrying with no backoff
                // could busy-spin the CPU for the whole LISTENER_TTL if the
                // error is persistent — so back off briefly before retrying.
                tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                continue;
            }
        };
        let mut buf = [0u8; 8192];
        let Ok(Ok(n)) = tokio::time::timeout(READ_TIMEOUT, stream.read(&mut buf)).await else {
            continue;
        };
        let text = String::from_utf8_lossy(&buf[..n]);
        let parsed = parse_request_line(text.lines().next().unwrap_or(""));

        let response = match &parsed {
            Some(_) => format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                RESPONSE_BODY.len(),
                RESPONSE_BODY
            ),
            None => "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
        };
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;

        if let Some(cb) = parsed {
            // Emit and keep serving. A mismatched/forged callback is ignored by
            // the state check in browser-login.ts; tearing the listener down
            // here would let a forged callback strand the genuine sign-in.
            on_callback(cb);
        }
    }
}

/// Bind a loopback listener and return its port. The socket is live BEFORE this
/// returns, so the port embedded in the auth URL is always real.
///
/// The listener is registered in `LoopbackState` keyed by port so the frontend
/// can close it via `auth_loopback_stop` (called on consume, cancel, timeout,
/// and supersede). It also self-reaps after `LISTENER_TTL`. Either way the
/// spawned task removes its own map entry on exit.
#[tauri::command]
pub async fn auth_loopback_start(
    app: AppHandle,
    state: State<'_, LoopbackState>,
) -> Result<u16, String> {
    // 127.0.0.1 explicitly — never 0.0.0.0, which would expose the callback to
    // the local network. Port 0 lets the OS pick a free ephemeral port.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not bind loopback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not read loopback port: {e}"))?
        .port();

    // Register the stopper BEFORE spawning, so a stop that races immediately
    // after this returns still finds the entry. The id identifies THIS
    // attempt so the spawned task can tell, on exit, whether the entry under
    // `port` is still its own (see `LoopbackState` doc re: port reuse).
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel::<()>();
    {
        let mut stoppers = state.stoppers.lock().unwrap();
        stoppers.insert(port, (id, tx));
    }

    let app_task = app.clone();
    tauri::async_runtime::spawn(async move {
        let app_emit = app_task.clone();
        // serve_loop never completes on its own; whichever of the stop signal
        // or the TTL fires first drops the serve future (and thus the socket).
        tokio::select! {
            _ = serve_loop(listener, move |cb| { let _ = app_emit.emit(LOOPBACK_EVENT, cb); }) => {}
            _ = tokio::time::sleep(LISTENER_TTL) => {}
            _ = rx => {}
        }
        // On any exit, drop our own entry — but ONLY if it's still ours. The
        // port this task bound may already have been rebound by a newer
        // attempt (its TcpListener dropped, freeing the port, and a fresh
        // `auth_loopback_start` grabbed it before this remove ran); in that
        // case the map holds a different id and must be left alone, or we'd
        // delete the new attempt's stopper and spuriously tear it down.
        // (A `stop` already removed our entry before firing the sender; this
        // remove is then a harmless no-op either way.)
        if let Some(state) = app_task.try_state::<LoopbackState>() {
            let mut map = state.stoppers.lock().unwrap();
            if map.get(&port).map(|(entry_id, _)| *entry_id) == Some(id) {
                map.remove(&port);
            }
        }
    });

    Ok(port)
}

/// Close the loopback listener bound to `port`, if one is live. Idempotent: a
/// port that isn't in the map (already stopped, TTL-reaped, or never started)
/// is a no-op. Send errors are ignored — the serve task may have already
/// exited (TTL), leaving no receiver to signal.
#[tauri::command]
pub fn auth_loopback_stop(port: u16, state: State<'_, LoopbackState>) {
    let entry = state.stoppers.lock().unwrap().remove(&port);
    if let Some((_id, tx)) = entry {
        let _ = tx.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cb(code: &str, state: &str) -> Option<LoopbackCallback> {
        Some(LoopbackCallback { code: code.to_string(), state: state.to_string() })
    }

    #[test]
    fn parses_well_formed_callback() {
        assert_eq!(
            parse_request_line("GET /callback?code=abc123&state=xyz789 HTTP/1.1"),
            cb("abc123", "xyz789")
        );
    }

    #[test]
    fn param_order_does_not_matter() {
        assert_eq!(
            parse_request_line("GET /callback?state=xyz789&code=abc123 HTTP/1.1"),
            cb("abc123", "xyz789")
        );
    }

    #[test]
    fn percent_encoded_values_are_decoded() {
        assert_eq!(
            parse_request_line("GET /callback?code=a%2Bb&state=c%3Dd HTTP/1.1"),
            cb("a+b", "c=d")
        );
    }

    #[test]
    fn extra_params_are_ignored() {
        assert_eq!(
            parse_request_line("GET /callback?code=abc&state=xyz&utm=spam HTTP/1.1"),
            cb("abc", "xyz")
        );
    }

    #[test]
    fn rejects_wrong_path() {
        assert_eq!(parse_request_line("GET /favicon.ico?code=a&state=b HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback-evil?code=a&state=b HTTP/1.1"), None);
    }

    #[test]
    fn rejects_missing_or_empty_params() {
        assert_eq!(parse_request_line("GET /callback?code=abc HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback?state=xyz HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback?code=&state=xyz HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback?code=abc&state= HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback HTTP/1.1"), None);
    }

    #[test]
    fn rejects_non_get_and_junk() {
        assert_eq!(parse_request_line("POST /callback?code=a&state=b HTTP/1.1"), None);
        assert_eq!(parse_request_line(""), None);
        assert_eq!(parse_request_line("garbage"), None);
    }

    #[test]
    fn rejects_malformed_percent_escape() {
        assert_eq!(parse_request_line("GET /callback?code=a%ZZ&state=b HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /callback?code=a%2&state=b HTTP/1.1"), None);
    }

    /// Reproduces the port-reuse race directly on the map-mutation logic (no
    /// sockets needed): attempt A (id1) exits and its trailing self-remove
    /// runs AFTER attempt B (id2) has already rebound the same now-freed port
    /// and inserted its own stopper. A's guarded remove — the fix in
    /// `auth_loopback_start`'s spawned task — must see B's newer id under the
    /// port and leave the entry alone, instead of blindly deleting by port
    /// and dropping B's sender (which would spuriously tear B's listener
    /// down seconds after it started).
    #[test]
    fn guarded_remove_does_not_delete_a_newer_attempts_stopper() {
        let state = LoopbackState::new();
        let port = 54321u16;
        let id1 = 1u64;
        let id2 = 2u64;
        let (tx2, _rx2) = oneshot::channel::<()>();

        // B has already inserted its (newer) stopper under the same port
        // that A previously bound.
        {
            let mut map = state.stoppers.lock().unwrap();
            map.insert(port, (id2, tx2));
        }

        // A's trailing self-remove, guarded by ITS OWN (now-stale) id — this
        // mirrors the `if map.get(&port).map(...) == Some(id)` guard.
        {
            let mut map = state.stoppers.lock().unwrap();
            if map.get(&port).map(|(entry_id, _)| *entry_id) == Some(id1) {
                map.remove(&port);
            }
        }

        // B's entry must still be present — A must not have deleted it, and
        // B's sender (tx2) must not have been dropped.
        let map = state.stoppers.lock().unwrap();
        assert!(
            map.contains_key(&port),
            "a newer attempt's stopper must survive an older attempt's self-remove"
        );
        assert_eq!(map.get(&port).unwrap().0, id2);
    }

    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// Spawn `serve_loop` under a stop channel, collecting emitted callbacks
    /// into a shared Vec. Mirrors the production `tokio::select!` in
    /// `auth_loopback_start`, minus the (AppHandle-bound) TTL arm and map
    /// bookkeeping — this is the "test at the function level" the command
    /// wrapper can't reach because it needs an `AppHandle`/`State`.
    #[allow(clippy::type_complexity)]
    fn spawn_serve(
        listener: TcpListener,
    ) -> (
        Arc<Mutex<Vec<LoopbackCallback>>>,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let received = Arc::new(Mutex::new(Vec::new()));
        let recv = received.clone();
        let (tx, rx) = oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            tokio::select! {
                _ = serve_loop(listener, move |c| recv.lock().unwrap().push(c)) => {}
                _ = rx => {}
            }
        });
        (received, tx, handle)
    }

    /// Send one `GET /callback?...` request and return the full HTTP response.
    async fn send_callback(port: u16, code: &str, state: &str) -> String {
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let req = format!(
            "GET /callback?code={code}&state={state} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
        );
        client.write_all(req.as_bytes()).await.unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        response
    }

    /// `on_callback` runs just after the client's read completes, so poll
    /// briefly for the emitted callbacks rather than reading synchronously.
    async fn wait_for_len(received: &Arc<Mutex<Vec<LoopbackCallback>>>, n: usize) {
        for _ in 0..200 {
            if received.lock().unwrap().len() >= n {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "timed out waiting for {n} callbacks, got {}",
            received.lock().unwrap().len()
        );
    }

    #[tokio::test]
    async fn keeps_serving_after_a_callback_and_stops_only_on_signal() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port >= 1024, "OS must assign a non-privileged ephemeral port");
        let (received, stop, handle) = spawn_serve(listener);

        // First callback: served with 200, never echoing code/state.
        let resp = send_callback(port, "abc", "xyz").await;
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "got: {resp}");
        assert!(!resp.contains("abc"), "response must not echo the code");
        assert!(!resp.contains("xyz"), "response must not echo the state");

        // The KEY behavior of this fix: a first callback (which, from Rust's
        // blind vantage, could be the forged `state=WRONG` one) does NOT tear
        // the listener down — a SECOND connection still gets served, so the
        // genuine callback that follows a forged decoy still lands.
        let resp2 = send_callback(port, "real", "s").await;
        assert!(resp2.starts_with("HTTP/1.1 200 OK"), "got: {resp2}");

        wait_for_len(&received, 2).await;
        assert_eq!(
            *received.lock().unwrap(),
            vec![
                LoopbackCallback { code: "abc".into(), state: "xyz".into() },
                LoopbackCallback { code: "real".into(), state: "s".into() },
            ]
        );

        // Only the explicit stop signal closes the listener.
        stop.send(()).unwrap();
        handle.await.unwrap();
        assert!(
            TcpStream::connect(("127.0.0.1", port)).await.is_err(),
            "port must refuse connections after stop"
        );
    }

    #[tokio::test]
    async fn non_callback_request_gets_404_and_does_not_stop_the_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (received, stop, handle) = spawn_serve(listener);

        // A browser prefetching /favicon.ico must get a 404 and be ignored.
        let mut junk = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        junk.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n").await.unwrap();
        let mut junk_response = String::new();
        junk.read_to_string(&mut junk_response).await.unwrap();
        assert!(junk_response.starts_with("HTTP/1.1 404"), "got: {junk_response}");

        // The real callback still lands afterwards.
        let resp = send_callback(port, "real", "s").await;
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "got: {resp}");
        wait_for_len(&received, 1).await;
        assert_eq!(
            *received.lock().unwrap(),
            vec![LoopbackCallback { code: "real".into(), state: "s".into() }]
        );

        stop.send(()).unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn stalled_connection_does_not_block_a_later_legitimate_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (received, stop, handle) = spawn_serve(listener);

        // Connect but never send a byte — a port scanner, security probe, or
        // browser preconnect that opens the socket and goes silent. Held alive
        // for the whole test so the serve loop must move past it on its own
        // (via the read timeout) rather than the peer disconnecting.
        let stalled = TcpStream::connect(("127.0.0.1", port)).await.unwrap();

        // The real callback, from a second connection made while the first is
        // still open and silent.
        let resp = send_callback(port, "real", "s").await;
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "got: {resp}");
        wait_for_len(&received, 1).await;
        assert_eq!(
            *received.lock().unwrap(),
            vec![LoopbackCallback { code: "real".into(), state: "s".into() }]
        );

        drop(stalled);
        stop.send(()).unwrap();
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn stop_before_any_callback_closes_the_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (received, stop, handle) = spawn_serve(listener);

        stop.send(()).unwrap();

        // Deliberately NOT asserting that the port refuses connections. The
        // kernel is free to hand our just-released ephemeral port to another
        // test binding 127.0.0.1:0, and `cargo test` runs these in parallel,
        // so `connect` succeeds against a stranger's listener and the
        // assertion fires even though our socket closed exactly as intended.
        // That cost ~1 failure in 12 full-suite runs, and none in 60 runs of
        // this test alone — the flake was the assertion, not the listener.
        //
        // The spawned task owns the listener, so a finished task IS a closed
        // socket: returning drops it. Bounding the wait keeps the signal the
        // port probe was really after — a loop that ignored `stop` and stayed
        // parked in `accept()` fails here instead of hanging the suite.
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("serve loop must exit promptly after stop")
            .unwrap();

        assert!(
            received.lock().unwrap().is_empty(),
            "no callback was sent, so none may be recorded"
        );
    }
}
