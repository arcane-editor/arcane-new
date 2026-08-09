# Unity Bridge: Append-Only Journal Transport

**Date:** 2026-08-09
**Status:** Approved, pending implementation
**Scope:** `arcane-extension/Editor/` (C#), `editor/src-tauri/src/unity_ipc.rs` (Rust)

## Problem

The Unity bridge transport is a Unix domain socket (`AddressFamily.Unix` +
`UnixDomainSocketEndPoint`) on macOS/Linux and a named pipe on Windows. On any
Unity project whose **API Compatibility Level is `.NET Framework`**, the bridge
is dead on arrival:

```
[ArcaneBridge] Unix domain sockets are unavailable in this project's scripting
runtime. The Arcane IDE bridge requires API Compatibility Level = .NET Standard
2.1 … The bridge is disabled until that is set.
```

`UnixDomainSocketEndPoint` shipped in .NET Core 2.1 / .NET Standard 2.1 and was
never backported to .NET Framework 4.x, which is what Unity's `.NET Framework`
profile targets. There is no shim, `#if`, or reflection workaround — the type
does not exist. `BridgeClient.UnixSocketsSupported()` is already the best
possible handling *within* a UDS design.

This is not an edge case. Projects pulling in a DLL built against .NET
Framework, or using `System.Data` / `System.ServiceModel`, or upgraded from
older Unity, sit on that profile — and some **cannot** switch without breaking
their own dependencies. Requiring a Player Setting change is incompatible with
the product goal: *import the `.tgz`, open the project in Arcane, and it works.*

A second latent bug is fixed as a side effect. `Discovery.cs` computes a
fallback socket path as `sha1(projectRoot)`, and its own comment
(`Discovery.cs:115-120`) documents the hazard: Rust's `std::fs::canonicalize`
resolves symlinks, .NET's `Path.GetFullPath` does not. Any project under a
symlinked path (`/tmp` → `/private/tmp` on macOS, symlinked home directories)
makes the two sides compute different paths.

## Goals

1. Bridge connects with **zero project configuration**, at any API
   Compatibility Level, on Unity 2021.3+, on macOS / Windows / Linux.
2. **One** transport, not one per platform — delete the `#[cfg(unix)]` /
   `#[cfg(windows)]` split in `unity_ipc.rs`.
3. Survive Unity domain reloads without a visible disconnect.
4. No new package dependencies on either side.
5. When it *does* fail, fail legibly — the user is told what to do.

## Non-goals

- Remote / cross-machine bridging. Same-machine only, permanently.
- Backward compatibility with the v1 (socket) package. Hard switch, no
  negotiation — see [Rollout](#rollout).
- Durability. The journal is a transport, not a log. Data loss on crash is fine.

## Decision

Replace both transports with a pair of **append-only, newline-delimited JSON
journal files** in `<projectRoot>/Library/ArcaneIDE/`, polled by size.

### Why not loopback TCP

TCP on `127.0.0.1` also solves the compat-level problem (`TcpListener` is
.NET Standard 2.0) and was the initial recommendation. Rejected in favour of
files at the product owner's direction: no port, no token, no firewall surface,
and the transport state is inspectable on disk during support.

### Why not one file per message

The literal "file drop" design breaks under this bridge's traffic profile.
`ConsoleHook` streams every `Debug.Log`; a play-mode session that logs even
moderately produces hundreds of messages/second. One file per message means
create → write → rename → poll-detect → read → delete, per message, which:

- **Trips Windows Defender.** Real-time protection scans every file create.
  Thousands of small creates per minute in `Library/` is a measurable stall,
  and `Library/` is not reliably excluded on user machines.
- **Reintroduces Windows file locking** — the classic flaky-file-IPC failure.
  Reader opens a file the writer or an AV scanner still holds → sporadic
  `IOException`, needing retry loops.
- **Costs a directory scan per poll.** 25 ms polling from both sides means 40
  `Directory.GetFiles()` calls/second, forever.

The journal has none of these: **two file handles for the entire session**,
polled with `fstat` (microseconds), no creates after startup, no renames, and
append order *is* message order so there is no readdir-sort problem.

### Why newline-delimited, not `Framing.cs`

`Framing.cs`'s 4-byte length prefix is retired. If a writer dies mid-record —
which happens routinely here, since domain reload tears down threads — a
length-prefixed stream is unrecoverable: the reader gets a garbage length and
cannot resync. A newline-delimited stream degrades to "the last line has no
`\n` yet", which the reader simply doesn't consume.

**Verified precondition:** `Json.cs:152` `Serialize()` emits compact JSON with
no whitespace, and `WriteString` escapes `\n`, `\r`, and every control character
below `0x20`. A Unity stack trace cannot inject a raw newline. One message is
always exactly one line. On the Rust side `serde_json::to_string` (not
`to_string_pretty`) has the same property.

## File layout

Every file has exactly **one writer**. This is the property the design rests
on: no cross-process locking anywhere, no interleaving, no retry loops.

| File | Writer | Reader | Purpose |
|---|---|---|---|
| `bridge.json` | IDE | Unity | IDE session identity + protocol version |
| `to-ide.jsonl` | Unity | IDE | Unity → IDE messages |
| `to-ide.epoch` | Unity | IDE | truncation counter for `to-ide.jsonl` |
| `to-ide.ack` | IDE | Unity | IDE's consumed byte offset |
| `to-unity.jsonl` | IDE | Unity | IDE → Unity messages |
| `to-unity.epoch` | IDE | Unity | truncation counter for `to-unity.jsonl` |
| `to-unity.ack` | Unity | IDE | Unity's consumed byte offset |

All under `<projectRoot>/Library/ArcaneIDE/`. `Library/` is VCS-ignored and
per-machine, which is exactly right for transport state.

**Each side creates the file it writes.** A reader that hits `ENOENT` waits and
retries — it never creates the peer's file. The directory is created by whoever
arrives first (`create_dir_all` / `Directory.CreateDirectory`, both idempotent).
The IDE keeps its existing guard: no files are written unless
`<projectRoot>/ProjectSettings/` exists, so non-Unity workspaces are untouched.

### `bridge.json`

Written by the IDE via write-to-`.tmp` + `rename` (atomic on the same
filesystem) so Unity can never read a half-written file. `std::fs::write` alone
is **not** atomic and must not be used here.

```json
{
  "transport": "journal",
  "protocolVersion": 2,
  "ideSessionId": "0b7c…",
  "ideVersion": "0.3.0",
  "idePid": 12345,
  "minPackageVersion": "0.1.0",
  "_note": "Arcane IDE bridge. If Unity is not connecting, update the com.arcane.editor package."
}
```

Deleted by the IDE when the workspace closes — its absence means "no IDE".

## Wire format

One JSON object per line, `\n`-terminated, UTF-8, no BOM. The message envelope
(`type`, `id`, `payload`, `timestamp`) and every existing `MsgType` are
unchanged; only the framing around them changes.

`connection_init` gains three fields:

```json
{"type":"connection_init","payload":{
  "unitySessionId":"…","ideSessionId":"…","packageVersion":"0.1.0", …existing UnityProjectInfo… }}
```

`ideSessionId` is echoed back from `bridge.json`. It is the handshake — see
[Session protocol](#session-protocol).

## Read/write mechanics

**Writing.** Hold one append handle open for the session. Append complete lines,
then `Flush()` — which makes bytes visible to other processes. Never
`Flush(true)`, which fsyncs and is pointlessly slow for a transport.

**Reading.** Hold one read handle open for the session. Each poll, check
`stream.Length` (a live `fstat`, not a cached `FileInfo`). If `len > offset`:
read `[offset, len)`, split on `\n`, dispatch complete lines, and advance
`offset` past the **last newline only**. A partial trailing line stays buffered
and unconsumed until its `\n` arrives.

**Universal reset rule.** A reader **cannot** detect truncation from length
alone. If the writer truncates and then rewrites to the same-or-greater length
before the reader's next poll, `len < offset` is false and the reader silently
skips the new content — which is precisely what a session reset does (truncate,
then immediately append a fat `connection_init`). This was caught by
`DetectsTruncationEvenWhenRewrittenToTheSameLength`.

So each journal carries an **epoch sidecar** — `to-ide.jsonl` → `to-ide.epoch` —
holding a counter its writer bumps on every truncation. Reset detection is:

1. **Authoritative:** the epoch changed → `offset = 0`, discard the buffer.
2. **Safety net:** `len < offset` → same reset. This covers the window between
   the writer's `SetLength(0)` and its epoch publish, where the file is merely
   short.

The epoch is written by the journal's single writer, so the one-writer-per-file
invariant is preserved. Cost is one small cached read per poll.

**Readers must disable `FileStream` buffering** (`bufferSize: 1` in C#). With
buffering on, seeking back to 0 after a truncation is served from the cached
*old* bytes and replays stale content. The reader does its own buffering and
reads in large chunks, so the FileStream buffer bought nothing and cost
correctness.

**Windows sharing flags — mandatory.** C# must set these explicitly on both
handles; the default `FileShare.Read` on the writer makes the peer's concurrent
reads fail with sharing violations on Windows:

```csharp
// writer
new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)
// reader
new FileStream(path, FileMode.Open,   FileAccess.Read,  FileShare.ReadWrite)
```

Rust's `OpenOptions` already passes `FILE_SHARE_READ|WRITE|DELETE`, so only the
C# side needs care.

**Adaptive polling.**

| Constant | Value | Note |
|---|---|---|
| `POLL_ACTIVE_MS` | 25 | while bytes are flowing |
| `POLL_IDLE_MS` | 250 | after `IDLE_AFTER_MS` with no non-heartbeat traffic |
| `IDLE_AFTER_MS` | 3000 | |
| `HEARTBEAT_MS` | 2000 | heartbeat frames do **not** reset the idle backoff |
| `PEER_DEAD_MS` | 8000 | 4 missed heartbeats |
| `ROTATE_THRESHOLD` | 4 MiB | |
| `MAX_LINE_BYTES` | 16 MiB | unchanged from `MAX_FRAME_SIZE` |
| `DISCOVERY_POLL_MS` | 1000 | Unity polling for `bridge.json` |

Excluding heartbeats from the backoff reset is what keeps idle CPU at zero;
otherwise the 2 s heartbeat would snap polling back to 25 ms forever. RPC
round-trips land near 50 ms, comfortably inside `DEFAULT_RPC_TIMEOUT_MS`
(10 s).

## Truncation protocol

The journal must not grow unboundedly across a long session. Rotation is
race-free by construction: **only a writer truncates its own file, and only
after the reader has confirmed it consumed every byte.**

1. The reader publishes its consumed offset to `<name>.ack` — a bare decimal
   integer — but **only while the journal it reads exceeds `ROTATE_THRESHOLD`**,
   and at most every 500 ms. Below the threshold no `.ack` write ever happens,
   so the overwhelming majority of sessions do zero ack I/O.
2. The writer, on the same single thread that appends, checks after each drain:
   if `size > ROTATE_THRESHOLD && ack == size`, call `SetLength(0)`.
3. The reader hits the universal reset rule and restarts at 0.

Why there is no lossy window: the writer truncates only when `ack == size`,
which means the reader has consumed *and dispatched* everything — so nothing is
in flight. If the writer appended after the reader's ack, then `size > ack` and
no truncation occurs.

The writer skips truncation this round — never truncates — when the ack file is
**missing** (the normal state below threshold), **unparseable**, or **stale**
(`ack > size`, seen briefly just after a rotation). The failure mode is always
delayed rotation, never data loss, so the ack file needs no atomic-write dance.

The ack offset must reflect **dispatched** bytes, never merely read bytes; a
buffered partial line is not included.

## Session protocol

There is no socket, so "connected" must be defined explicitly.

- **IDE session id** — fresh UUID each time the IDE opens this workspace.
- **Unity session id** — fresh UUID each time Unity *cold-starts* the bridge.
  Survives domain reloads via `SessionState`.

**Invariant that closes the startup race:** the IDE writes nothing to
`to-unity.jsonl` until it has read a `connection_init` whose `ideSessionId`
matches its own current one. A `connection_init` echoing a stale `ideSessionId`
is discarded.

That invariant is also what makes truncation safe to do twice. The IDE truncates
`to-unity.jsonl` both on its own startup (Sequence A) and again when it observes
a new `unitySessionId` (Sequence B); because it has written nothing since the
handshake gate, the second truncation can never discard a live message. The same
holds for Unity and `to-ide.jsonl`, whose only pre-handshake content is the
`connection_init` it is about to rewrite.

### Sequence A — IDE starts, Unity already running

1. IDE mints `ideSessionId=B`, truncates `to-unity.jsonl`, sets its read offset
   on `to-ide.jsonl` to the current length (skipping stale messages), writes
   `bridge.json`.
2. Unity's discovery poll sees `B ≠ stored`, truncates `to-ide.jsonl`, and
   appends `connection_init{unitySessionId, ideSessionId: B}`.
3. IDE reads it, matches `B`, marks connected, emits `connection-changed`, and
   is now free to write.

### Sequence B — Unity cold-starts, IDE already running

1. Unity mints `unitySessionId=Y`, reads `bridge.json`, truncates
   `to-ide.jsonl`, sets its read offset on `to-unity.jsonl` to current length,
   appends `connection_init{Y, B}`.
2. IDE sees a new `unitySessionId`, truncates `to-unity.jsonl` **before**
   writing anything else. Unity detects the epoch bump and resets to 0.

### Sequence C — domain reload (the common case)

1. `beforeAssemblyReload` → flush outbox, close handles, persist
   `unitySessionId`, `ideSessionId`, and both offsets into `SessionState`.
2. New AppDomain → `[InitializeOnLoad]` → restores them. `bridge.json` still
   says `B`, so **no reset**: reopen handles, resume reading at the stored
   offset, resume appending.

No `connection_init`, no reconnect, **no disconnect flicker in the IDE**. This
is strictly better than the socket transport, which drops and re-establishes
the connection on every script recompile.

### Liveness

The journal is the heartbeat. Each side appends a `heartbeat` every
`HEARTBEAT_MS`; if the peer's journal has not grown in `PEER_DEAD_MS`, the peer
is dead. Unity additionally treats a missing `bridge.json` as "IDE closed", and
both sides may use the peer's pid as a fast-path liveness check.

On `EditorApplication.quitting`, Unity appends a `disconnect` message and
flushes, so the IDE sees a clean close rather than an 8 s timeout.

### Stale-package detection

Unity writes `Library/EditorInstance.json` (containing `process_id`) whenever
the editor has the project open. If the IDE sees a live `EditorInstance.json`
but no `to-ide.jsonl` appears within 15 s, the `com.arcane.editor` package is
missing or pre-v2 — surface an actionable *"Install / update the Arcane Unity
package"* prompt rather than an indefinite "waiting for Unity". This is the
only compensation for the hard protocol switch and directly serves the
import-and-it-works goal.

## Limits and error handling

| Condition | Behaviour |
|---|---|
| Outbound message > `MAX_LINE_BYTES` | Refuse, warn once, drop (existing `Send()` behaviour) |
| Reader buffers > `MAX_LINE_BYTES` with no `\n` | Discard buffer, log, seek to EOF — bounds memory on a corrupt journal |
| Unparseable line | Log at debug, skip the line, continue — a single bad line never kills the session |
| `bridge.json` missing / malformed | Unity waits, polling at `DISCOVERY_POLL_MS` |
| Journal file missing | Reader waits; only the writer creates it |
| `Library/` not writable | Warn once with the path; bridge stays idle |
| `protocolVersion` > known | Warn "update Arcane IDE", stay idle |

Neither side may throw out of `InitializeOnLoad`, the `EditorApplication.update`
pump, or a tokio task — existing rule, unchanged.

## Code changes

### C# — `arcane-extension/Editor/`

| File | Change |
|---|---|
| `Journal.cs` | **New.** `JournalWriter` (append, flush, ack-gated truncate) and `JournalReader` (offset, size poll, line split, `MAX_LINE_BYTES` guard). Pure `System.IO`; no Unity API, so it is unit-testable. |
| `Discovery.cs` | **Rewrite.** Drop `Sha1Hex`, `Canonicalize`, and the `System.Security.Cryptography` import. Parse the new `bridge.json`. ~147 → ~80 lines. |
| `BridgeClient.cs` | **Rewrite transport.** Delete `UnixSocketsSupported`, `WarnUnsupportedOnce`, `TryCreateSocket`, `ConnectBlocking`, and the `sock.Receive` loop. Keep the worker thread, `_outbox`, writer loop, heartbeat, `HandleInbound`, and backoff. |
| `Framing.cs` (+`.meta`) | **Delete.** `MAX_LINE_BYTES` moves to `Journal.cs`. |
| `BridgeBootstrap.cs` | Persist session ids + read offsets in `SessionState` across domain reloads. |
| `Protocol.cs` | `ProtocolVersion` → 2; `connection_init` gains `unitySessionId`, `ideSessionId`, `packageVersion`. |

`System.IO.File`/`FileStream` are .NET Standard 2.0, so **every one of these
compiles at both API Compatibility Levels** — which is the entire point.

### Rust — `editor/src-tauri/src/`

| Item | Change |
|---|---|
| `unity_journal.rs` | **New.** Journal reader/writer tasks mirroring the C# semantics. |
| `compute_pipe_path` (both cfgs), `hash_workspace`, `cleanup_stale_socket` | **Delete.** |
| `encode_frame`, `decode_frame` | **Delete** — replaced by line splitting. |
| Both `#[cfg]` accept loops in `unity_ipc_start` | **Delete**, replaced by one journal session task. |
| `write_bridge_discovery` | Rewrite for the new shape; switch to atomic tmp+rename. |
| `handle_client` | Becomes `run_journal_session`. |
| `UnityIpcState`, per-window registry, `pending` RPC map, `route_message`, timeouts | **Unchanged.** |
| `pipe_path_is_deterministic` test | Delete. |

The `sha1` crate dependency **stays** — `graphify.rs:13` still uses it.

## Testing

**Rust unit tests** (pure filesystem against a tempdir — no Unity needed):
round-trip, partial-line buffering across polls, truncation reset via
truncation reset via both the epoch and the `len < offset` safety net,
same-length truncation detection, epoch survival across a writer reopen,
ack gating below/above threshold, stale-ack skip,
`MAX_LINE_BYTES` guard, malformed-line skip.

**C# unit tests.** The package has no test infrastructure today. Add
`Tests/Editor/` with its own asmdef referencing `com.unity.test-framework`
(the `ARCANE_HAS_TEST_FRAMEWORK` versionDefine already exists in
`Arcane.Editor.asmdef`), covering `Journal.cs` and `Discovery.cs` parsing. Add
`Tests` to `DENY_NAMES` in `editor/scripts/sync-unity-bridge.mjs` so it never
ships in the `.tgz`.

**Cross-language contract tests.** Golden `.jsonl` fixtures in
`editor/src-tauri/fixtures/unity-journal/`, parsed by both sides' tests, so the
format cannot drift between languages.

**Manual acceptance — the test that actually matters.** A real Unity project
with **API Compatibility Level = `.NET Framework`**: import the `.tgz`, open in
Arcane, confirm connection, console streaming, an RPC round-trip, play-mode
enter/exit, and — critically — that a script recompile causes **no** disconnect.
Repeat on Windows.

## Rollout

Hard switch, no negotiation (`protocolVersion` 1 → 2). Package version is
`0.0.1` with no meaningful install base.

A pre-v2 package reading the new `bridge.json` finds no `socketPath`, falls
back to its computed SHA1 socket path, finds nothing listening, and retries on
backoff — noisy but harmless. The stale-package detection above converts that
silent failure into an actionable prompt.

`arcane-extension/package.json` `version` → `0.1.0`.

## Risks

1. **`SessionState` capacity.** Only session ids and two integers are stored;
   well within limits. If `SessionState` were ever lost mid-session, the
   fallback is a cold start — a reconnect, not corruption.
2. **Filesystem without atomic rename.** A network-mounted or exotic
   `Library/` could break the `bridge.json` write. Unity itself already
   requires a sane local `Library/`, so this is out of scope.
3. **Disconnect detection is 8 s, not instant.** Accepted; a socket close is
   immediate, a dead journal is not. Mitigated by the explicit `disconnect`
   message on clean quit.
4. **Idle disk wake-ups.** 250 ms `fstat` polling on an idle bridge is
   negligible CPU but does touch the filesystem cache on battery. Accepted.
