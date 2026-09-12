//! Native Mono Soft Debugger client.
//!
//! Replaces the `vscode-mono-debug` sidecar that `dap.rs` used to launch. That
//! adapter needed a system Mono runtime and a binary this app never vendored,
//! so in a shipped build the debugger could not start at all.
//!
//! Unity's editor and players host Mono's *soft debugger agent*, which listens
//! on a TCP port and speaks a binary request/reply protocol. Talking to it
//! directly needs nothing installed: no adapter, no .NET, no Mono.
//!
//! Layering, innermost first:
//!
//! | Module     | Owns |
//! |------------|------|
//! | `wire`     | packet framing and the primitive encoders/decoders |
//! | `protocol` | command numbers, event shapes, line tables |
//! | `paths`    | reconciling the three spellings of one source path |
//! | `conn`     | the socket: handshake, correlation, disconnect discipline |
//! | `discovery`| finding a Unity editor or player to attach to |
//! | `symbols`  | `file:line` to method + IL offset, and arming breakpoints |
//! | `values`   | decoding the runtime's tagged values |
//! | `session`  | threads, frames, locals, stepping |
//! | `objects`  | fields, string contents, array elements |
//! | `handles`  | the DAP variablesReference table |
//! | `renderers`| Unity-aware value formatting |
//! | `router`   | DAP requests in, DAP events out |
//! | `host`     | Tauri commands and per-window sessions |
//! | `trace`    | the wire log |

pub mod android;
pub mod assignment;
pub mod breakpoints;
pub mod conn;
pub mod eval;
pub mod expr;
pub mod handles;
pub mod host;
pub mod discovery;
pub mod objects;
pub mod paths;
pub mod players;
pub mod protocol;
pub mod renderers;
pub mod router;
pub mod session;
pub mod symbols;
pub mod trace;
pub mod values;
pub mod wire;

#[cfg(test)]
pub mod e2e;

#[cfg(test)]
pub mod fake_agent;
