//! One-shot loopback HTTP listener for browser sign-in (RFC 8252 §7.3).
//!
//! Deep links need OS-level scheme registration, which macOS grants only to an
//! installed .app bundle — so under `tauri dev` on macOS a deep link launches
//! the (stale) bundled build rather than the dev process. This listener is the
//! transport used wherever the scheme is not registered: the website redirects
//! the browser to `http://127.0.0.1:<port>/callback?code=…&state=…`, we read
//! the query once, hand it to the frontend as an event, and shut down.
//!
//! This module TRANSPORTS ONLY. It never validates `state` — that comparison
//! lives in browser-login.ts, in one place, shared with the deep-link path.

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Event carrying the callback params to the frontend.
pub const LOOPBACK_EVENT: &str = "auth-loopback-callback";

/// Matches the frontend's 10-minute login timeout, so an abandoned attempt
/// cannot leak a bound socket indefinitely.
const LISTENER_TTL: Duration = Duration::from_secs(600);

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
/// port scanner) and must not consume the listener's single shot.
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

/// Accept until one request parses as a callback, then return it and drop the
/// listener. Requests that don't parse get a 404 and are ignored — a browser
/// prefetching `/favicon.ico` must not burn the single shot.
async fn serve_once(listener: TcpListener) -> Option<LoopbackCallback> {
    loop {
        let (mut stream, _) = listener.accept().await.ok()?;
        let mut buf = [0u8; 8192];
        let Ok(n) = stream.read(&mut buf).await else { continue };
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

        if parsed.is_some() {
            return parsed; // listener drops here — single-use
        }
    }
}

/// Bind a one-shot loopback listener and return its port. The socket is live
/// BEFORE this returns, so the port embedded in the auth URL is always real.
///
/// A cancelled attempt does not close this eagerly and does not need to: the
/// frontend has already discarded its pending attempt, so a late callback
/// fails the state check and is ignored. The TTL reaps the socket regardless.
#[tauri::command]
pub async fn auth_loopback_start(app: AppHandle) -> Result<u16, String> {
    // 127.0.0.1 explicitly — never 0.0.0.0, which would expose the callback to
    // the local network. Port 0 lets the OS pick a free ephemeral port.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Could not bind loopback listener: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not read loopback port: {e}"))?
        .port();

    tauri::async_runtime::spawn(async move {
        if let Ok(Some(cb)) = tokio::time::timeout(LISTENER_TTL, serve_once(listener)).await {
            let _ = app.emit(LOOPBACK_EVENT, cb);
        }
    });

    Ok(port)
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

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[tokio::test]
    async fn serves_one_callback_then_stops() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(port >= 1024, "OS must assign a non-privileged ephemeral port");

        let server = tokio::spawn(serve_once(listener));

        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"), "got: {response}");
        assert!(!response.contains("abc"), "response must not echo the code");
        assert!(!response.contains("xyz"), "response must not echo the state");
        assert_eq!(
            server.await.unwrap(),
            Some(LoopbackCallback { code: "abc".into(), state: "xyz".into() })
        );

        // Single-use: the listener is dropped, so the port no longer accepts.
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }

    #[tokio::test]
    async fn non_callback_request_does_not_consume_the_single_shot() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(serve_once(listener));

        // A browser prefetching /favicon.ico must get a 404 and be ignored.
        let mut junk = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        junk.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n").await.unwrap();
        let mut junk_response = String::new();
        junk.read_to_string(&mut junk_response).await.unwrap();
        assert!(junk_response.starts_with("HTTP/1.1 404"), "got: {junk_response}");

        // The real callback still lands.
        let mut client = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        client
            .write_all(b"GET /callback?code=real&state=s HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut ok = String::new();
        client.read_to_string(&mut ok).await.unwrap();

        assert_eq!(
            server.await.unwrap(),
            Some(LoopbackCallback { code: "real".into(), state: "s".into() })
        );
    }
}
