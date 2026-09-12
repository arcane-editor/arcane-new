//! The Debug Adapter Protocol router.
//!
//! This is what lets the whole existing debugger UI keep working. The frontend
//! already speaks DAP end to end — `dap-client.ts` correlates on `request_seq`,
//! the store reads `DapCapabilities`, and the panels render `stackTrace`,
//! `scopes`, `variables` and `evaluate` shapes. So rather than invent a new
//! command surface and rewrite five panels, the native client answers DAP.
//! Nothing crosses a process boundary: there is no adapter and no framing, just
//! JSON values in and JSON values out.
//!
//! Everything runs in one task. Requests from the editor, events from the
//! runtime, and results from background scans all arrive as `Msg` on a single
//! channel, so there is no lock ordering to get wrong and no shared mutable
//! state between the socket and the UI.
//!
//! Two behaviours are worth knowing about:
//!
//! * **Breakpoints bind lazily and re-bind by themselves.** A `setBreakpoints`
//!   answers immediately with whatever could be resolved from types already
//!   known, then keeps trying: a background scan finds types loaded before we
//!   attached, and `TYPE_LOAD` events catch types loaded afterwards. Because
//!   Unity reloads its script assembly on every recompile and on entering Play
//!   Mode, that second path is what makes breakpoints survive a domain reload.
//! * **The catch-up scan never blocks a request.** It is the command that
//!   stalled on a real Unity editor for long enough that a naive client timed
//!   out and dropped the socket, killing the editor.

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value as Json};
use tokio::sync::mpsc;

use super::assignment::{self, Location as WriteLocation};
use super::conn::Conn;
use super::handles::{Handle, Handles};
use super::objects;
use super::protocol::{self, Composite};
use super::session::{self, StepDepth};
use super::symbols::{self, Location};
use super::values::{self, Value};
use super::{breakpoints, discovery, eval, expr, paths, renderers};

/// Everything the router reacts to.
#[derive(Debug)]
pub enum Msg {
    /// A DAP request from the editor.
    Request(Json),
    /// A composite event from the runtime.
    Sdb(Composite),
    /// The runtime's socket ended.
    SdbClosed,
    /// A background catch-up scan finished.
    TypesFound { path: String, types: Vec<u32> },
}

/// A breakpoint the editor asked for.
#[derive(Debug, Clone)]
struct Wanted {
    line: u32,
    condition: Option<String>,
    hit_condition: Option<String>,
    log_message: Option<String>,
    /// How many times the runtime has stopped here this session. Counted even
    /// for hits that are filtered out, because that is what a hit condition
    /// counts.
    hits: u32,
}

/// Where a wanted breakpoint currently sits in the runtime.
#[derive(Debug, Clone)]
struct Bound {
    request_id: u32,
    location: Location,
}

// Frames are addressed by handle, not by a table here: `stackTrace` allocates a
// `FrameLocals` handle per frame and hands its reference back as the DAP frame
// id, so `scopes` and `variables` resolve through the same table that gets
// invalidated on resume. Keeping a second copy of the stack alongside it would
// be state that can disagree with itself.

pub struct Router {
    out: mpsc::UnboundedSender<Json>,
    self_tx: mpsc::UnboundedSender<Msg>,
    workspace: PathBuf,
    conn: Option<Conn>,
    seq: i64,
    /// What the editor wants, per source path.
    wanted: HashMap<String, Vec<Wanted>>,
    /// Which of those are armed in the runtime.
    bound: HashMap<(String, u32), Bound>,
    /// Event request id back to the breakpoint that owns it, so a stop can be
    /// matched to its condition without searching every file.
    by_request: HashMap<u32, (String, u32)>,
    /// Exception types the editor asked to break on, and whether caught
    /// exceptions count. Re-registered on attach, like breakpoints.
    exception_filters: Vec<String>,
    exception_request: Option<u32>,
    /// The `TYPE_LOAD` subscription covering every watched file.
    watch_request: Option<u32>,
    /// A step in flight, which must be cleared once it lands or the runtime
    /// keeps stepping.
    pending_step: Option<u32>,
    /// A run-to-cursor breakpoint, cleared the moment it is reached. A
    /// breakpoint the user then has to remove is a different feature.
    one_shot: Option<u32>,
    /// Every type seen from a watched source file, so an interactive action
    /// like run-to-cursor can resolve a line without waiting on the slow scan.
    known_types: Vec<u32>,
    /// The thread the runtime is stopped on, if any.
    stopped_thread: Option<u32>,
    handles: Handles,
    write_locations: HashMap<i64, WriteLocation>,
    /// Per type: the id of its `m_CachedPtr` field, or `None` when it is not a
    /// Unity object at all. Cached because finding it means walking the whole
    /// base-type chain, and the answer never changes for a given type.
    unity_ptr_field: HashMap<u32, Option<u32>>,
}

impl Router {
    pub fn new(
        out: mpsc::UnboundedSender<Json>,
        self_tx: mpsc::UnboundedSender<Msg>,
        workspace: PathBuf,
    ) -> Router {
        Router {
            out,
            self_tx,
            workspace,
            conn: None,
            seq: 0,
            wanted: HashMap::new(),
            bound: HashMap::new(),
            by_request: HashMap::new(),
            exception_filters: Vec::new(),
            exception_request: None,
            watch_request: None,
            pending_step: None,
            one_shot: None,
            known_types: Vec::new(),
            stopped_thread: None,
            handles: Handles::new(),
            write_locations: HashMap::new(),
            unity_ptr_field: HashMap::new(),
        }
    }

    pub async fn on(&mut self, msg: Msg) {
        match msg {
            Msg::Request(request) => self.on_request(request).await,
            Msg::Sdb(composite) => self.on_sdb(composite).await,
            Msg::SdbClosed => {
                self.conn = None;
                self.stopped_thread = None;
                self.handles.invalidate();
                self.write_locations.clear();
                self.event("terminated", json!({}));
            }
            Msg::TypesFound { path, types } => {
                for type_id in &types {
                    self.remember_type(*type_id);
                }
                self.bind_against(&types, Some(&path)).await;
            }
        }
    }

    // -- outbound ----------------------------------------------------------

    fn send(&mut self, mut message: Json) {
        self.seq += 1;
        message["seq"] = json!(self.seq);
        let _ = self.out.send(message);
    }

    fn event(&mut self, name: &str, body: Json) {
        self.send(json!({ "type": "event", "event": name, "body": body }));
    }

    fn respond(&mut self, request: &Json, body: Json) {
        let request_seq = request.get("seq").cloned().unwrap_or(json!(0));
        let command = request.get("command").cloned().unwrap_or(json!(""));
        self.send(json!({
            "type": "response",
            "request_seq": request_seq,
            "success": true,
            "command": command,
            "body": body,
        }));
    }

    fn refuse(&mut self, request: &Json, message: impl Into<String>) {
        let request_seq = request.get("seq").cloned().unwrap_or(json!(0));
        let command = request.get("command").cloned().unwrap_or(json!(""));
        self.send(json!({
            "type": "response",
            "request_seq": request_seq,
            "success": false,
            "command": command,
            "message": message.into(),
        }));
    }

    // -- requests ----------------------------------------------------------

    async fn on_request(&mut self, request: Json) {
        let command = request
            .get("command")
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .to_string();

        match command.as_str() {
            "initialize" => {
                let body = json!({
                    "supportsConfigurationDoneRequest": true,
                    "supportsSetVariable": true,
                    "supportsEvaluateForHovers": true,
                    "supportsGotoTargetsRequest": true,
                    // Advertised only when implemented. A capability the UI
                    // believes in but the adapter ignores is a feature that
                    // silently does nothing.
                    "supportsConditionalBreakpoints": true,
                    "supportsHitConditionalBreakpoints": true,
                    "supportsLogPoints": true,
                    "exceptionBreakpointFilters": [
                        {
                            "filter": "uncaught",
                            "label": "Uncaught exceptions",
                            "default": true,
                        },
                        {
                            "filter": "all",
                            "label": "All exceptions (including caught)",
                            // Off by default: Unity's engine throws and catches
                            // routinely, so this stops constantly in code the
                            // user did not write.
                            "default": false,
                        },
                    ],
                });
                self.respond(&request, body);
            }
            "attach" => self.attach(&request).await,
            "setBreakpoints" => self.set_breakpoints(&request).await,
            "setExceptionBreakpoints" => self.set_exception_breakpoints(&request).await,
            "configurationDone" => self.respond(&request, json!({})),
            "threads" => self.threads(&request).await,
            "stackTrace" => self.stack_trace(&request).await,
            "scopes" => self.scopes(&request).await,
            "variables" => self.variables(&request).await,
            "setVariable" => self.set_variable(&request).await,
            "evaluate" => self.evaluate(&request).await,
            "continue" => self.resume_with(&request, None).await,
            "next" => self.resume_with(&request, Some(StepDepth::Over)).await,
            "stepIn" => self.resume_with(&request, Some(StepDepth::Into)).await,
            "stepOut" => self.resume_with(&request, Some(StepDepth::Out)).await,
            "gotoTargets" => self.goto_targets(&request).await,
            "goto" => self.goto(&request).await,
            "runToCursor" => self.run_to_cursor(&request).await,
            "pause" => self.pause(&request).await,
            "disconnect" | "terminate" => self.disconnect(&request).await,
            other => self.refuse(&request, format!("unsupported request '{}'", other)),
        }
    }

    async fn attach(&mut self, request: &Json) {
        let args = request.get("arguments").cloned().unwrap_or(json!({}));
        let explicit = args.get("port").and_then(|p| p.as_u64()).map(|port| {
            let host = args
                .get("host")
                .and_then(|h| h.as_str())
                .unwrap_or("127.0.0.1")
                .to_string();
            (host, port as u16)
        });

        let (host, port) = match explicit {
            Some(pair) => pair,
            None => match discovery::targets_for_workspace(&self.workspace)
                .into_iter()
                .next()
            {
                Some(target) => (target.host, target.port),
                None => {
                    self.refuse(
                        request,
                        "No Unity editor is running for this project. Open the project in Unity, then attach.",
                    );
                    return;
                }
            },
        };

        let addr = match format!("{}:{}", host, port).parse() {
            Ok(addr) => addr,
            Err(_) => {
                self.refuse(
                    request,
                    format!("invalid debugger address {}:{}", host, port),
                );
                return;
            }
        };

        let conn = match Conn::connect(addr).await {
            Ok(conn) => conn,
            Err(e) => {
                self.refuse(request, format!("could not attach to {}: {}", addr, e));
                return;
            }
        };

        // Pump runtime events into this router's own channel, so everything
        // arrives on one queue and the router stays single-threaded.
        {
            let mut events = conn.subscribe();
            let tx = self.self_tx.clone();
            tokio::spawn(async move {
                use tokio::sync::broadcast::error::RecvError;
                loop {
                    match events.recv().await {
                        Ok(composite) => {
                            if tx.send(Msg::Sdb(composite)).is_err() {
                                break;
                            }
                        }
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => {
                            let _ = tx.send(Msg::SdbClosed);
                            break;
                        }
                    }
                }
            });
        }

        self.conn = Some(conn);
        self.rewatch().await;
        // Event requests do not survive a connection, so anything the editor
        // asked for before this attach has to be applied again.
        self.rearm_exceptions().await;
        // A Unity editor is already running, so this is usually refused with
        // "not suspended" — which is fine. It matters for a debuggee started
        // with `suspend=y`.
        if let Some(conn) = &self.conn {
            let _ = session::resume(conn).await;
        }

        self.respond(request, json!({}));
        self.event("initialized", json!({}));
    }

    async fn set_breakpoints(&mut self, request: &Json) {
        let args = request.get("arguments").cloned().unwrap_or(json!({}));
        let path = args
            .get("source")
            .and_then(|s| s.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or_default()
            .to_string();
        if path.is_empty() {
            self.refuse(request, "setBreakpoints needs a source path");
            return;
        }

        let text = |item: &Json, key: &str| -> Option<String> {
            item.get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let requested: Vec<Wanted> = args
            .get("breakpoints")
            .and_then(|b| b.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(Wanted {
                            line: item.get("line").and_then(|l| l.as_u64())? as u32,
                            condition: text(item, "condition"),
                            hit_condition: text(item, "hitCondition"),
                            log_message: text(item, "logMessage"),
                            hits: 0,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let lines: Vec<u32> = requested.iter().map(|w| w.line).collect();

        // Drop whatever is armed for this file; the editor has just replaced
        // the whole set for it.
        let stale: Vec<(String, u32)> = self
            .bound
            .keys()
            .filter(|(p, _)| paths::same_file(p, &path))
            .cloned()
            .collect();
        for key in stale {
            if let Some(bound) = self.bound.remove(&key) {
                self.by_request.remove(&bound.request_id);
                if let Some(conn) = &self.conn {
                    let _ = symbols::clear_event_request(
                        conn,
                        protocol::EVENT_BREAKPOINT,
                        bound.request_id,
                    )
                    .await;
                }
            }
        }

        self.wanted.insert(path.clone(), requested);
        self.rewatch().await;

        // Try the types we already know about, so the common case answers
        // verified straight away...
        let known: Vec<u32> = Vec::new();
        self.bind_against(&known, Some(&path)).await;

        // ...and look for types that loaded before we attached, off the
        // request path. This is the command that stalled a real editor.
        if let Some(conn) = &self.conn {
            let conn = conn.clone();
            let tx = self.self_tx.clone();
            let scan_path = path.clone();
            tokio::spawn(async move {
                if let Ok(types) =
                    symbols::types_for_source_file(&conn, &scan_path, symbols::SCAN_TIMEOUT).await
                {
                    let _ = tx.send(Msg::TypesFound {
                        path: scan_path,
                        types,
                    });
                }
            });
        }

        let body = json!({
            "breakpoints": lines
                .iter()
                .map(|line| self.breakpoint_status(&path, *line))
                .collect::<Vec<_>>(),
        });
        self.respond(request, body);
    }

    fn breakpoint_status(&self, path: &str, line: u32) -> Json {
        // A hit condition the parser rejects is reported here rather than
        // silently ignored — a user who typed one believes it is in force.
        let bad_hit_condition = self
            .wanted
            .get(path)
            .and_then(|list| list.iter().find(|w| w.line == line))
            .and_then(|w| w.hit_condition.as_deref())
            .filter(|text| breakpoints::parse_hit_condition(text).is_none());
        if let Some(text) = bad_hit_condition {
            return json!({
                "verified": false,
                "line": line,
                "message": format!("hit condition '{}' is not understood", text),
            });
        }

        match self.bound.get(&(path.to_string(), line)) {
            Some(bound) => json!({ "verified": true, "line": bound.location.line }),
            None => json!({ "verified": false, "line": line }),
        }
    }

    async fn set_exception_breakpoints(&mut self, request: &Json) {
        let filters: Vec<String> = request
            .get("arguments")
            .and_then(|a| a.get("filters"))
            .and_then(|f| f.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|f| f.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        self.exception_filters = filters;
        self.rearm_exceptions().await;
        self.respond(request, json!({}));
    }

    /// Apply the current exception filters to the runtime.
    ///
    /// Re-applied after attach as well as on request, because an event request
    /// registered against a previous connection does not survive it.
    async fn rearm_exceptions(&mut self) {
        let Some(conn) = self.conn.clone() else {
            return;
        };

        if let Some(previous) = self.exception_request.take() {
            let _ = symbols::clear_event_request(&conn, protocol::EVENT_EXCEPTION, previous).await;
        }

        let uncaught = self
            .exception_filters
            .iter()
            .any(|f| f == "uncaught" || f == "all" || f == "user-unhandled");
        let caught = self.exception_filters.iter().any(|f| f == "all");
        if !uncaught && !caught {
            return;
        }

        // Type 0 means "any exception"; per-type filtering would need the type
        // resolved first, which is a lookup the UI has no way to ask for yet.
        match symbols::arm_exception_breakpoint(&conn, 0, caught, uncaught).await {
            Ok(id) => self.exception_request = Some(id),
            Err(e) => self.output(&format!("Could not set exception breakpoints: {}\n", e)),
        }
    }

    /// Re-register the `TYPE_LOAD` subscription over every watched file.
    async fn rewatch(&mut self) {
        let Some(conn) = self.conn.clone() else {
            return;
        };
        if let Some(previous) = self.watch_request.take() {
            let _ = symbols::clear_event_request(&conn, protocol::EVENT_TYPE_LOAD, previous).await;
        }
        let files: Vec<String> = self.wanted.keys().cloned().collect();
        if files.is_empty() {
            return;
        }
        if let Ok(id) = symbols::watch_source_files(&conn, &files).await {
            self.watch_request = Some(id);
        }
    }

    /// Try to bind unbound breakpoints against a set of types.
    ///
    /// When `only` is given, just that file's breakpoints are considered;
    /// otherwise every file is tried, which is what a `TYPE_LOAD` after a
    /// domain reload needs.
    async fn bind_against(&mut self, types: &[u32], only: Option<&str>) {
        let Some(conn) = self.conn.clone() else {
            return;
        };
        if types.is_empty() {
            return;
        }

        let targets: Vec<(String, Vec<u32>)> = self
            .wanted
            .iter()
            .filter(|(path, _)| only.map_or(true, |p| paths::same_file(p, path)))
            .map(|(path, list)| (path.clone(), list.iter().map(|w| w.line).collect()))
            .collect();

        for (path, lines) in targets {
            for line in lines {
                let key = (path.clone(), line);
                let Ok(Some(location)) = symbols::locate_in_types(&conn, types, &path, line).await
                else {
                    continue;
                };

                // Already armed at exactly this spot: nothing to do. Armed
                // somewhere else means the type reloaded underneath us, so the
                // old request is stale and must go.
                if let Some(existing) = self.bound.get(&key).cloned() {
                    if existing.location == location {
                        continue;
                    }
                    self.by_request.remove(&existing.request_id);
                    let _ = symbols::clear_event_request(
                        &conn,
                        protocol::EVENT_BREAKPOINT,
                        existing.request_id,
                    )
                    .await;
                }

                if let Ok(request_id) = symbols::arm_breakpoint(&conn, location).await {
                    self.by_request.insert(request_id, key.clone());
                    self.bound.insert(
                        key,
                        Bound {
                            request_id,
                            location,
                        },
                    );
                    self.event(
                        "breakpoint",
                        json!({
                            "reason": "changed",
                            "breakpoint": {
                                "verified": true,
                                "line": location.line,
                                "source": { "path": path },
                            }
                        }),
                    );
                }
            }
        }
    }

    async fn threads(&mut self, request: &Json) {
        let Some(conn) = self.conn.clone() else {
            self.respond(request, json!({ "threads": [] }));
            return;
        };
        let ids = session::all_threads(&conn).await.unwrap_or_default();
        let mut threads = Vec::new();
        for id in ids {
            let name = session::thread_name(&conn, id).await.unwrap_or_default();
            threads.push(json!({
                "id": id,
                // Unity's main thread reports an empty name.
                "name": if name.is_empty() { format!("Thread {}", id) } else { name },
            }));
        }
        self.respond(request, json!({ "threads": threads }));
    }

    async fn stack_trace(&mut self, request: &Json) {
        let Some(conn) = self.conn.clone() else {
            self.respond(request, json!({ "stackFrames": [], "totalFrames": 0 }));
            return;
        };
        let thread = request
            .get("arguments")
            .and_then(|a| a.get("threadId"))
            .and_then(|t| t.as_u64())
            .unwrap_or(0) as u32;

        let frames = session::frames(&conn, thread).await.unwrap_or_default();
        let mut rendered = Vec::new();

        for frame in &frames {
            let reference = self.handles.alloc(Handle::FrameLocals {
                thread,
                frame_id: frame.id,
                method: frame.method,
                il_offset: frame.il_offset,
            });
            let name = symbols::method_name(&conn, frame.method)
                .await
                .unwrap_or_default();
            let position = symbols::source_position(&conn, frame.method, frame.il_offset)
                .await
                .ok()
                .flatten();

            let mut rendered_frame = json!({
                "id": reference,
                "name": if name.is_empty() { format!("<method {}>", frame.method) } else { name },
                "line": position.as_ref().map(|(_, line)| *line).unwrap_or(0),
                "column": 1,
            });
            if let Some((file, _)) = position {
                rendered_frame["source"] = json!({
                    "name": paths::file_name(&file),
                    "path": file,
                });
            }
            rendered.push(rendered_frame);
        }

        self.stopped_thread = Some(thread);
        let total = rendered.len();
        self.respond(
            request,
            json!({ "stackFrames": rendered, "totalFrames": total }),
        );
    }

    async fn scopes(&mut self, request: &Json) {
        let frame_id = request
            .get("arguments")
            .and_then(|a| a.get("frameId"))
            .and_then(|f| f.as_i64())
            .unwrap_or(0);

        // The frame id *is* the handle allocated in `stackTrace`, so a scope is
        // just a pointer back to it.
        let body = if self.handles.get(frame_id).is_some() {
            json!({
                "scopes": [{
                    "name": "Locals",
                    "variablesReference": frame_id,
                    "expensive": false,
                }]
            })
        } else {
            json!({ "scopes": [] })
        };
        self.respond(request, body);
    }

    async fn variables(&mut self, request: &Json) {
        let reference = request
            .get("arguments")
            .and_then(|a| a.get("variablesReference"))
            .and_then(|r| r.as_i64())
            .unwrap_or(0);

        let Some(conn) = self.conn.clone() else {
            self.respond(request, json!({ "variables": [] }));
            return;
        };
        let Some(handle) = self.handles.get(reference).cloned() else {
            // A reference from before the last resume. Answering with an empty
            // list is right: the object it named no longer exists.
            self.respond(request, json!({ "variables": [] }));
            return;
        };

        let variables = match handle.clone() {
            Handle::FrameLocals {
                thread,
                frame_id,
                method,
                il_offset,
            } => {
                self.frame_variables(&conn, thread, frame_id, method, il_offset)
                    .await
            }
            Handle::Object { id } => self.object_variables(&conn, id).await,
            Handle::Struct { type_id, fields } => {
                self.struct_variables(&conn, type_id, &fields).await
            }
            Handle::ArraySlice {
                array,
                start,
                count,
            } => self.array_variables(&conn, array, start, count).await,
        };

        // Attach an address to expandable structs, which have no runtime object id.
        for row in &variables {
            let child = row["variablesReference"].as_i64().unwrap_or(0);
            if child > 0 {
                if let Ok(location) = self
                    .writable_location(
                        &conn,
                        reference,
                        &handle,
                        row["name"].as_str().unwrap_or(""),
                    )
                    .await
                {
                    self.write_locations.insert(child, location);
                }
            }
        }
        self.respond(request, json!({ "variables": variables }));
    }

    async fn writable_location(
        &self,
        conn: &Conn,
        reference: i64,
        handle: &Handle,
        name: &str,
    ) -> Result<WriteLocation, String> {
        match handle {
            Handle::FrameLocals {
                thread,
                frame_id,
                method,
                il_offset,
            } => {
                let locals = session::locals_info(conn, *method)
                    .await
                    .map_err(|e| e.to_string())?;
                let (slot, _) = locals
                    .iter()
                    .enumerate()
                    .find(|(_, l)| l.name == name && l.is_live_at(*il_offset))
                    .ok_or("Local is unavailable or read-only")?;
                Ok(WriteLocation::Local {
                    thread: *thread,
                    frame: *frame_id,
                    slot: slot as i32,
                })
            }
            Handle::Object { id } => {
                let type_id = objects::object_type(conn, *id)
                    .await
                    .map_err(|e| e.to_string())?;
                let fields = objects::all_instance_fields(conn, type_id)
                    .await
                    .map_err(|e| e.to_string())?;
                let matching: Vec<_> = fields
                    .iter()
                    .filter(|f| renderers::readable_field_name(f.display_name()) == name)
                    .collect();
                if matching.len() != 1 {
                    return Err("Field is unavailable or ambiguous".into());
                }
                if matching[0].attributes & 0x20 != 0 {
                    return Err("Readonly fields cannot be edited".into());
                }
                Ok(WriteLocation::Field {
                    object: *id,
                    field: matching[0].id,
                })
            }
            Handle::ArraySlice {
                array,
                start,
                count,
            } => {
                let index: u32 = name
                    .strip_prefix('[')
                    .and_then(|s| s.strip_suffix(']'))
                    .and_then(|s| s.parse().ok())
                    .ok_or("Invalid array index")?;
                if index < *start || index >= start.saturating_add(*count) {
                    return Err("Index outside this array page".into());
                }
                Ok(WriteLocation::Element {
                    array: *array,
                    index,
                })
            }
            Handle::Struct { type_id, .. } => {
                let fields = objects::type_fields(conn, *type_id)
                    .await
                    .map_err(|e| e.to_string())?;
                let (index, field) = fields
                    .iter()
                    .filter(|f| f.is_instance_field())
                    .enumerate()
                    .find(|(_, f)| renderers::readable_field_name(f.display_name()) == name)
                    .ok_or("Field is unavailable")?;
                if field.attributes & 0x20 != 0 {
                    return Err("Readonly fields cannot be edited".into());
                }
                let parent = self
                    .write_locations
                    .get(&reference)
                    .cloned()
                    .ok_or("This value is a read-only evaluation result")?;
                Ok(WriteLocation::Nested {
                    parent: Box::new(parent),
                    index,
                })
            }
        }
    }

    async fn set_variable(&mut self, request: &Json) {
        let args = &request["arguments"];
        let reference = args["variablesReference"].as_i64().unwrap_or(0);
        let name = args["name"].as_str().unwrap_or("");
        let text = args["value"].as_str().unwrap_or("");
        let (Some(conn), Some(handle)) = (self.conn.clone(), self.handles.get(reference).cloned())
        else {
            self.refuse(request, "Variable is stale; pause and expand it again");
            return;
        };
        if self.stopped_thread.is_none() {
            self.refuse(request, "Pause execution before changing a value");
            return;
        }
        let result = async {
            let location = self
                .writable_location(&conn, reference, &handle, name)
                .await?;
            let old = location.read(&conn).await?;
            let value = assignment::replacement(&old, text)?;
            location.write(&conn, value).await?;
            location.read(&conn).await
        }
        .await;
        match result {
            Ok(value) => {
                let row = self.describe(&conn, name, &value).await;
                self.respond(request, row);
            }
            Err(error) => self.refuse(request, error),
        }
    }

    async fn frame_variables(
        &mut self,
        conn: &Conn,
        thread: u32,
        frame_id: u32,
        method: u32,
        il_offset: u32,
    ) -> Vec<Json> {
        let mut out = Vec::new();

        if let Ok(this) = session::frame_this(conn, thread, frame_id).await {
            if !matches!(this, Value::Null) {
                out.push(self.describe(conn, "this", &this).await);
            }
        }

        let locals = session::locals_info(conn, method).await.unwrap_or_default();
        // A local outside its live range holds a reused slot — somebody else's
        // memory, which would look like a real value.
        let live: Vec<(usize, &session::Local)> = locals
            .iter()
            .enumerate()
            .filter(|(_, local)| local.is_live_at(il_offset))
            .collect();
        if live.is_empty() {
            return out;
        }

        let positions: Vec<i32> = live.iter().map(|(i, _)| *i as i32).collect();
        let Ok(read) = session::frame_values(conn, thread, frame_id, &positions).await else {
            return out;
        };
        for ((_, local), value) in live.iter().zip(read.iter()) {
            let name = local.name.clone();
            out.push(self.describe(conn, &name, value).await);
        }
        out
    }

    async fn object_variables(&mut self, conn: &Conn, object: u32) -> Vec<Json> {
        let Ok(type_id) = objects::object_type(conn, object).await else {
            return Vec::new();
        };
        // Inherited fields included: a MonoBehaviour's own declarations are
        // rarely the interesting half, and `m_CachedPtr` lives several levels up.
        let instance: Vec<objects::Field> = objects::all_instance_fields(conn, type_id)
            .await
            .unwrap_or_default()
            .into_iter()
            // Compiler state-machine bookkeeping is machinery, not variables.
            .filter(|f| !renderers::is_machine_noise(&f.name))
            .collect();
        if instance.is_empty() {
            return Vec::new();
        }

        let ids: Vec<u32> = instance.iter().map(|f| f.id).collect();
        let Ok(read) = objects::object_values(conn, object, &ids).await else {
            return Vec::new();
        };

        let mut out = Vec::new();
        for (field, value) in instance.iter().zip(read.iter()) {
            // A coroutine is an iterator, so stopping inside one otherwise
            // shows `<>1__state` and `<elapsed>5__2` instead of the code the
            // user wrote.
            let name = renderers::readable_field_name(field.display_name());
            out.push(self.describe(conn, &name, value).await);
        }
        out
    }

    async fn struct_variables(&mut self, conn: &Conn, type_id: u32, fields: &[Value]) -> Vec<Json> {
        let declared = objects::type_fields(conn, type_id)
            .await
            .unwrap_or_default();
        let names: Vec<String> = declared
            .iter()
            .filter(|f| f.is_instance_field())
            .map(|f| renderers::readable_field_name(f.display_name()))
            .collect();

        let mut out = Vec::new();
        for (index, value) in fields.iter().enumerate() {
            let name = names
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("[{}]", index));
            out.push(self.describe(conn, &name, value).await);
        }
        out
    }

    async fn array_variables(
        &mut self,
        conn: &Conn,
        array: u32,
        start: u32,
        count: u32,
    ) -> Vec<Json> {
        let Ok(read) = objects::array_values(conn, array, start, count).await else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for (offset, value) in read.iter().enumerate() {
            let name = format!("[{}]", start as usize + offset);
            out.push(self.describe(conn, &name, value).await);
        }
        out
    }

    /// The id of a type's `m_CachedPtr` field, if it is a Unity object.
    async fn cached_ptr_field(&mut self, conn: &Conn, type_id: u32) -> Option<u32> {
        if let Some(cached) = self.unity_ptr_field.get(&type_id) {
            return *cached;
        }
        let found = objects::all_instance_fields(conn, type_id)
            .await
            .unwrap_or_default()
            .iter()
            .find(|f| f.name == renderers::CACHED_PTR)
            .map(|f| f.id);
        self.unity_ptr_field.insert(type_id, found);
        found
    }

    /// Render one value as a DAP variable, allocating a handle when it has
    /// children.
    async fn describe(&mut self, conn: &Conn, name: &str, value: &Value) -> Json {
        // The frontend renderer keys its Unity treatment off this: a
        // UnityEngine.Color only gets a swatch because the type says so.
        let mut type_label = values::type_label(value).map(|s| s.to_string());
        let (display, reference) = match value {
            Value::Str(id) if *id != 0 => {
                let text = objects::string_value(conn, *id).await.unwrap_or_default();
                (format!("\"{}\"", text), 0)
            }
            Value::Object { tag, id } if *id != 0 => {
                let type_id = objects::object_type(conn, *id).await.ok();
                let label = match type_id {
                    Some(type_id) => objects::type_name(conn, type_id)
                        .await
                        .unwrap_or_else(|_| String::from("object")),
                    None => String::from("object"),
                };

                // A destroyed Unity object is still a live managed reference,
                // so `!= null` is true while Unity treats it as null. Showing
                // it as an ordinary object is the most expensive lie a Unity
                // debugger can tell, so it is checked before anything else.
                if let Some(type_id) = type_id {
                    if let Some(field) = self.cached_ptr_field(conn, type_id).await {
                        let destroyed = objects::object_values(conn, *id, &[field])
                            .await
                            .ok()
                            .and_then(|v| v.into_iter().next())
                            .map(|v| renderers::is_destroyed(&v))
                            .unwrap_or(false);
                        if destroyed {
                            return json!({
                                "name": name,
                                "value": renderers::destroyed_summary(&label),
                                "type": label,
                                "variablesReference": 0,
                            });
                        }
                    }
                }

                type_label = Some(label.clone());
                // Arrays expand into elements, everything else into fields.
                if *tag == values::TYPE_SZARRAY || *tag == values::TYPE_ARRAY {
                    let length = objects::array_length(conn, *id).await.unwrap_or(0);
                    let reference = self.handles.alloc(Handle::ArraySlice {
                        array: *id,
                        start: 0,
                        count: length.min(MAX_ARRAY_PREVIEW),
                    });
                    (
                        format!("{}[{}]", renderers::short_name(&label), length),
                        reference,
                    )
                } else {
                    let reference = self.handles.alloc(Handle::Object { id: *id });
                    (
                        format!("{} {{…}}", renderers::short_name(&label)),
                        reference,
                    )
                }
            }
            Value::Struct {
                type_id, fields, ..
            } => {
                let label = objects::type_name(conn, *type_id)
                    .await
                    .unwrap_or_else(|_| String::from("struct"));
                type_label = Some(label.clone());
                // A Vector3 is three numbers, not a tree to expand three times.
                match renderers::struct_summary(&label, fields) {
                    Some(inline) => {
                        let reference = self.handles.alloc(Handle::Struct {
                            type_id: *type_id,
                            fields: fields.clone(),
                        });
                        (inline, reference)
                    }
                    None => {
                        let reference = self.handles.alloc(Handle::Struct {
                            type_id: *type_id,
                            fields: fields.clone(),
                        });
                        (
                            format!("{} {{…}}", renderers::short_name(&label)),
                            reference,
                        )
                    }
                }
            }
            other => (values::summarize(other), 0),
        };

        let mut variable = json!({
            "name": name,
            "value": display,
            "variablesReference": reference,
        });
        if let Some(label) = type_label {
            variable["type"] = json!(label);
        }
        variable
    }
    /// Evaluate an expression against the selected frame.
    ///
    /// Used for watches, hover data tips and the console. Method calls are
    /// refused by `eval.rs` rather than attempted: invoking managed code
    /// resumes the target thread, and doing that from a hover can hang Unity's
    /// main thread.
    async fn evaluate(&mut self, request: &Json) {
        let args = request.get("arguments").cloned().unwrap_or(json!({}));
        let source = args
            .get("expression")
            .and_then(|e| e.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        let frame_id = args.get("frameId").and_then(|f| f.as_i64()).unwrap_or(0);

        let Some(conn) = self.conn.clone() else {
            self.refuse(request, "not attached");
            return;
        };
        let Some(Handle::FrameLocals {
            thread,
            frame_id: frame,
            method,
            il_offset,
        }) = self.handles.get(frame_id).cloned()
        else {
            self.refuse(request, "no frame selected");
            return;
        };

        let parsed = match expr::parse(&source) {
            Ok(parsed) => parsed,
            Err(e) => {
                self.refuse(request, e.to_string());
                return;
            }
        };

        let context = eval::Frame {
            thread,
            frame,
            method,
            il_offset,
        };
        match eval::evaluate(&conn, context, &parsed).await {
            Ok(eval::Val::Runtime(value)) => {
                // A runtime value gets the full treatment — Unity renderers,
                // an expandable handle — so a watch behaves like a variable.
                let rendered = self.describe(&conn, &source, &value).await;
                self.respond(
                    request,
                    json!({
                        "result": rendered["value"],
                        "type": rendered.get("type").cloned().unwrap_or(json!(null)),
                        "variablesReference": rendered["variablesReference"],
                    }),
                );
            }
            Ok(literal) => {
                let text = eval::display(&conn, &literal).await;
                self.respond(request, json!({ "result": text, "variablesReference": 0 }));
            }
            Err(e) => self.refuse(request, e.to_string()),
        }
    }

    async fn resume_with(&mut self, request: &Json, step: Option<StepDepth>) {
        let Some(conn) = self.conn.clone() else {
            self.refuse(request, "not attached");
            return;
        };
        let thread = request
            .get("arguments")
            .and_then(|a| a.get("threadId"))
            .and_then(|t| t.as_u64())
            .map(|t| t as u32)
            .or(self.stopped_thread)
            .unwrap_or(0);

        if let Some(depth) = step {
            // "My code only": stepping otherwise lands in static
            // constructors, [DebuggerStepThrough] accessors and Unity's own
            // engine code, all of which the user has to step back out of.
            match session::step(&conn, thread, depth, session::step_filter::MY_CODE_ONLY).await {
                Ok(id) => self.pending_step = Some(id),
                Err(e) => {
                    self.refuse(request, format!("could not step: {}", e));
                    return;
                }
            }
        }

        self.handles.invalidate();
        self.write_locations.clear();
        self.stopped_thread = None;
        let _ = session::resume(&conn).await;
        self.respond(request, json!({ "allThreadsContinued": true }));
        self.event(
            "continued",
            json!({ "threadId": thread, "allThreadsContinued": true }),
        );
    }

    /// Where execution could be moved to, for a "set next statement".
    ///
    /// The runtime can only move the pointer inside the method already
    /// executing, so a line in another method is not offered at all — better
    /// than offering it and failing when the user picks it.
    async fn goto_targets(&mut self, request: &Json) {
        let args = request.get("arguments").cloned().unwrap_or(json!({}));
        let line = args.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32;
        let path = args
            .get("source")
            .and_then(|s| s.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or_default()
            .to_string();

        let Some(conn) = self.conn.clone() else {
            self.respond(request, json!({ "targets": [] }));
            return;
        };
        let Some(thread) = self.stopped_thread else {
            self.respond(request, json!({ "targets": [] }));
            return;
        };
        let Some(frame) = session::frames(&conn, thread)
            .await
            .ok()
            .and_then(|frames| frames.first().copied())
        else {
            self.respond(request, json!({ "targets": [] }));
            return;
        };

        let Ok(Some(location)) = symbols::locate_in_method(&conn, frame.method, &path, line).await
        else {
            self.respond(request, json!({ "targets": [] }));
            return;
        };

        // The target id is the IL offset: `goto` needs nothing else, and the
        // runtime's own numbering cannot go stale between the two calls.
        self.respond(
            request,
            json!({
                "targets": [{
                    "id": location.il_offset,
                    "label": format!("line {}", location.line),
                    "line": location.line,
                }]
            }),
        );
    }

    async fn goto(&mut self, request: &Json) {
        let args = request.get("arguments").cloned().unwrap_or(json!({}));
        let target = args.get("targetId").and_then(|t| t.as_u64()).unwrap_or(0) as u32;
        let thread = args
            .get("threadId")
            .and_then(|t| t.as_u64())
            .map(|t| t as u32)
            .or(self.stopped_thread);

        let (Some(conn), Some(thread)) = (self.conn.clone(), thread) else {
            self.refuse(request, "not stopped");
            return;
        };
        let Some(frame) = session::frames(&conn, thread)
            .await
            .ok()
            .and_then(|frames| frames.first().copied())
        else {
            self.refuse(request, "no frame to move");
            return;
        };

        match session::set_instruction_pointer(&conn, thread, frame.method, target).await {
            Ok(()) => {
                self.respond(request, json!({}));
                // The stack did not change, but where it is pointing did, so
                // the UI has to re-read it.
                self.handles.invalidate();
                self.write_locations.clear();
                self.announce_stop(thread, "goto").await;
            }
            Err(e) => self.refuse(request, format!("could not move execution: {}", e)),
        }
    }

    /// Run until a chosen line, without leaving a breakpoint behind.
    ///
    /// Implemented as a one-shot breakpoint the router clears on its first hit.
    /// The runtime has no "run to here", and a breakpoint the user then has to
    /// remove is not the same feature.
    async fn run_to_cursor(&mut self, request: &Json) {
        let args = request.get("arguments").cloned().unwrap_or(json!({}));
        let line = args.get("line").and_then(|l| l.as_u64()).unwrap_or(0) as u32;
        let path = args
            .get("source")
            .and_then(|s| s.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or_default()
            .to_string();

        let Some(conn) = self.conn.clone() else {
            self.refuse(request, "not attached");
            return;
        };

        // Reuse whatever is already known about this file's types; a run-to-
        // cursor is an interactive action and must not wait on the slow scan.
        let types: Vec<u32> = self.known_types.clone();
        let Ok(Some(location)) = symbols::locate_in_types(&conn, &types, &path, line).await else {
            self.refuse(request, "that line has no code the runtime knows about yet");
            return;
        };

        match symbols::arm_breakpoint(&conn, location).await {
            Ok(id) => {
                self.one_shot = Some(id);
                self.respond(request, json!({}));
                self.resume_quietly().await;
                self.event(
                    "continued",
                    json!({ "threadId": self.stopped_thread.unwrap_or(0), "allThreadsContinued": true }),
                );
            }
            Err(e) => self.refuse(request, format!("could not run to that line: {}", e)),
        }
    }

    async fn pause(&mut self, request: &Json) {
        let Some(conn) = self.conn.clone() else {
            self.refuse(request, "not attached");
            return;
        };
        match session::suspend(&conn).await {
            Ok(()) => {
                self.respond(request, json!({}));
                let thread = session::all_threads(&conn)
                    .await
                    .ok()
                    .and_then(|t| t.first().copied())
                    .unwrap_or(0);
                self.announce_stop(thread, "pause").await;
            }
            Err(e) => self.refuse(request, format!("could not pause: {}", e)),
        }
    }

    async fn disconnect(&mut self, request: &Json) {
        if let Some(conn) = self.conn.take() {
            // Resume first: leaving the runtime suspended after a detach freezes
            // the editor with no debugger left to release it.
            let _ = session::resume(&conn).await;
            conn.dispose().await;
        }
        self.stopped_thread = None;
        self.handles.invalidate();
        self.write_locations.clear();
        self.bound.clear();
        self.watch_request = None;
        self.respond(request, json!({}));
        self.event("terminated", json!({}));
    }

    /// Detach cleanly when the session ends without an explicit `disconnect` —
    /// a closed window, a stopped session.
    ///
    /// The resume matters as much as the dispose: abandoning a suspended
    /// runtime leaves the editor frozen with no debugger left to release it.
    pub async fn shutdown(&mut self) {
        if let Some(conn) = self.conn.take() {
            let _ = session::resume(&conn).await;
            conn.dispose().await;
        }
    }

    // -- runtime events ----------------------------------------------------

    async fn on_sdb(&mut self, composite: Composite) {
        for event in composite.events {
            match event.kind {
                protocol::EVENT_BREAKPOINT => {
                    self.on_breakpoint_hit(event.thread, event.request_id).await;
                }
                protocol::EVENT_STEP => {
                    // A step request is one-shot from the user's point of view;
                    // leaving it registered makes the runtime keep stepping.
                    if let (Some(id), Some(conn)) = (self.pending_step.take(), self.conn.clone()) {
                        let _ = symbols::clear_event_request(&conn, protocol::EVENT_STEP, id).await;
                    }
                    self.announce_stop(event.thread, "step").await;
                }
                protocol::EVENT_TYPE_LOAD => {
                    if let Some(type_id) = event.subject {
                        self.remember_type(type_id);
                        // A type arriving after a domain reload re-binds the
                        // breakpoints that used to live in it.
                        self.bind_against(&[type_id], None).await;
                    }
                }
                protocol::EVENT_EXCEPTION => {
                    self.announce_stop(event.thread, "exception").await;
                }
                protocol::EVENT_VM_DEATH => {
                    self.event("terminated", json!({}));
                }
                protocol::EVENT_THREAD_START => {
                    self.event(
                        "thread",
                        json!({ "reason": "started", "threadId": event.thread }),
                    );
                }
                protocol::EVENT_THREAD_DEATH => {
                    self.event(
                        "thread",
                        json!({ "reason": "exited", "threadId": event.thread }),
                    );
                }
                _ => {}
            }
        }
    }

    /// Decide whether a breakpoint stop should reach the user.
    ///
    /// The runtime cannot evaluate an expression, so a conditional breakpoint
    /// always suspends and is resumed here when the condition is false. Same
    /// for hit counts and logpoints. That costs a round trip per hit — a
    /// conditional breakpoint in `Update()` suspends sixty times a second — but
    /// it is the only way to give conditions and hit counts the same meaning.
    async fn on_breakpoint_hit(&mut self, thread: u32, request_id: u32) {
        // Run-to-cursor: reaching it is the whole point, and it must not
        // survive to stop again on the next pass through the same line.
        if self.one_shot == Some(request_id) {
            self.one_shot = None;
            if let Some(conn) = self.conn.clone() {
                let _ = symbols::clear_event_request(&conn, protocol::EVENT_BREAKPOINT, request_id)
                    .await;
            }
            self.announce_stop(thread, "step").await;
            return;
        }

        let Some(key) = self.by_request.get(&request_id).cloned() else {
            // A stop we did not arm — a stale request from before a reload.
            self.announce_stop(thread, "breakpoint").await;
            return;
        };

        let Some(wanted) = self
            .wanted
            .get_mut(&key.0)
            .and_then(|list| list.iter_mut().find(|w| w.line == key.1))
        else {
            self.announce_stop(thread, "breakpoint").await;
            return;
        };

        wanted.hits = wanted.hits.saturating_add(1);
        let hits = wanted.hits;
        let condition = wanted.condition.clone();
        let hit_condition = wanted.hit_condition.clone();
        let log_message = wanted.log_message.clone();

        // Hit count first: it is cheap, and a hit that the count filters out
        // should not pay for evaluating a condition.
        if let Some(text) = hit_condition {
            match breakpoints::parse_hit_condition(&text) {
                Some(policy) if !policy.allows(hits) => {
                    self.resume_quietly().await;
                    return;
                }
                None => {
                    // Unparseable: stop rather than silently never stopping.
                    self.output(&format!(
                        "Breakpoint hit condition '{}' is not understood; stopping anyway.\n",
                        text
                    ));
                }
                _ => {}
            }
        }

        if let Some(source) = condition {
            match self.condition_holds(thread, &source).await {
                Ok(true) => {}
                Ok(false) => {
                    self.resume_quietly().await;
                    return;
                }
                Err(message) => {
                    // A condition that cannot be evaluated stops, and says why.
                    // Silently never stopping is the worse failure: the user
                    // waits at a breakpoint that will never fire.
                    self.output(&format!(
                        "Breakpoint condition '{}' could not be evaluated: {}\n",
                        source, message
                    ));
                }
            }
        }

        // A logpoint prints and keeps going; it is a print statement you did
        // not have to recompile for.
        if let Some(message) = log_message {
            let rendered = self.render_log_message(thread, &message).await;
            self.output(&format!("{}\n", rendered));
            self.resume_quietly().await;
            return;
        }

        self.announce_stop(thread, "breakpoint").await;
    }

    /// Remember a type from a watched source file.
    ///
    /// Bounded: a long session with many recompiles would otherwise accumulate
    /// a type id per reload forever, and the oldest are the ones a domain
    /// reload has already invalidated.
    fn remember_type(&mut self, type_id: u32) {
        const MAX_REMEMBERED: usize = 512;
        if self.known_types.contains(&type_id) {
            return;
        }
        if self.known_types.len() >= MAX_REMEMBERED {
            self.known_types.remove(0);
        }
        self.known_types.push(type_id);
    }

    /// Resume without telling the UI anything happened.
    async fn resume_quietly(&mut self) {
        if let Some(conn) = self.conn.clone() {
            self.handles.invalidate();
            self.write_locations.clear();
            let _ = session::resume(&conn).await;
        }
    }

    /// The innermost frame of a stopped thread, as an evaluation context.
    async fn eval_frame(&self, conn: &Conn, thread: u32) -> Option<eval::Frame> {
        let frames = session::frames(conn, thread).await.ok()?;
        let frame = frames.first()?;
        Some(eval::Frame {
            thread,
            frame: frame.id,
            method: frame.method,
            il_offset: frame.il_offset,
        })
    }

    async fn condition_holds(&mut self, thread: u32, source: &str) -> Result<bool, String> {
        let conn = self.conn.clone().ok_or("not attached")?;
        let parsed = expr::parse(source).map_err(|e| e.to_string())?;
        let frame = self
            .eval_frame(&conn, thread)
            .await
            .ok_or("no frame to evaluate in")?;
        let value = eval::evaluate(&conn, frame, &parsed)
            .await
            .map_err(|e| e.to_string())?;
        eval::truthy(&conn, &value).await.map_err(|e| e.to_string())
    }

    /// Substitute `{expression}` holes in a logpoint message.
    async fn render_log_message(&mut self, thread: u32, message: &str) -> String {
        let Some(conn) = self.conn.clone() else {
            return message.to_string();
        };
        let frame = self.eval_frame(&conn, thread).await;

        let mut out = String::new();
        for part in breakpoints::parse_log_message(message) {
            match part {
                breakpoints::LogPart::Literal(text) => out.push_str(&text),
                breakpoints::LogPart::Expr(source) => {
                    // A hole that cannot be evaluated shows its reason inline
                    // rather than dropping out of the message, so a logpoint
                    // never silently prints less than it says.
                    let rendered = match (expr::parse(&source), frame) {
                        (Ok(parsed), Some(frame)) => {
                            match eval::evaluate(&conn, frame, &parsed).await {
                                Ok(value) => eval::display(&conn, &value).await,
                                Err(e) => format!("<{}>", e),
                            }
                        }
                        (Err(e), _) => format!("<{}>", e),
                        (_, None) => "<no frame>".to_string(),
                    };
                    out.push_str(&rendered);
                }
            }
        }
        out
    }

    /// Send a line to the debug console.
    fn output(&mut self, text: &str) {
        self.event("output", json!({ "category": "console", "output": text }));
    }

    async fn announce_stop(&mut self, thread: u32, reason: &str) {
        // Every object id handed out before this moment named memory from the
        // previous stop.
        self.handles.invalidate();
        self.write_locations.clear();
        self.stopped_thread = Some(thread);
        self.event(
            "stopped",
            json!({
                "reason": reason,
                "threadId": thread,
                "allThreadsStopped": true,
            }),
        );
    }
}

/// How many array elements to show before the user has to ask for more.
const MAX_ARRAY_PREVIEW: u32 = 100;
