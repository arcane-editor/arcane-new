# Unity Bridge: Reconnection, Retry, and Dev-Build Parity

**Date:** 2026-08-09
**Status:** Approved, implementing
**Scope:** `editor/src-tauri/src/unity_ipc.rs`, `arcane-extension/Editor/`,
`editor/src/stores/unity.ts`, `editor/src/features/unity-bridge/`,
`editor/package.json`, `editor/src-tauri/src/auth.rs`

Follows [the journal transport design](2026-08-09-unity-bridge-journal-transport-design.md),
which this does not change: the transport, file layout, epoch/ack protocol and
wire format all stay exactly as shipped. What changes is what happens when the
session *breaks*.

## Problem

The journal transport works, but the session layer on top of it has no recovery
path. Reported symptom: "sometimes reloading breaks the connection, and there is
no retry — not automatic, and not manual either."

Six defects, two of which strand the bridge permanently.

### F1 — The IDE can skip Unity's handshake, forever

`unity_ipc.rs` opens `to-ide.jsonl` lazily and calls `seek_to_end()` exactly
once, adopting the current epoch and moving the read head to EOF. If Unity
creates the file, truncates it (epoch 0 → 1) and appends `connection_init`
*between two IDE polls*, the IDE adopts epoch 1 with the handshake already
behind its read head. The epoch never changes again, so the reset rule never
fires.

Unity's `_handshakeSent` is now `true`, and `RunSession` only re-announces when
`bridge.json` disappears or its `ideSessionId` changes. Neither happens. The
bridge is dead until a process restarts.

The odds are not exotic. While unconnected the IDE has no traffic, so
`last_traffic` is stale and it polls at `POLL_IDLE_MS` (**250 ms**) — against a
Unity-side create-to-handshake window of roughly one editor frame.

The hazard is asymmetric, which is why it survived review. Unity's own
`SeekToEnd()` is safe *because* of the handshake gate: the IDE writes nothing
before the handshake, so there is nothing for Unity to skip. The IDE's
`seek_to_end()` runs against a file whose very first bytes may be the handshake
it is waiting for.

### F2 — Disconnect is a one-way door

`connected` is set true **only** by an inbound `connection_init`, and false by
an inbound `disconnect` or by `PEER_DEAD_MS`. After that the IDE can only wait
for Unity to volunteer a new `connection_init` — and Unity volunteers one only
on cold start, or when `bridge.json`'s `ideSessionId` changes. The IDE never
changes it after `unity_ipc_start`.

So **any** disconnect where Unity still believes its session is live is
unrecoverable. An 8 s stall in Unity's bridge worker is enough, and
`MainThreadDispatcher.EnqueueAndWait` can park that worker for 6 s on its own.

There is no retry loop, no re-announce request, and no way for the user to force
one.

### F3 — Every recompile announces a disconnect, and can leave two writers

`BridgeClient.Stop()` appends a `disconnect` on `beforeAssemblyReload`, not just
on quit — contradicting the journal design's Sequence C, which promises "no
disconnect flicker in the IDE". Every script recompile therefore clears
`unity_session_id`, drops in-flight RPCs, and drives the status indicator amber.

It also compounds F2: between that `disconnect` and the post-reload
`connection_init`, anything that stops the new handshake from being read leaves
the IDE stranded with no way back.

Worse, `Stop()` writes the `disconnect` and closes the journals **only when
`Join(1500)` succeeds**. The worker can be parked in `EnqueueAndWait` for up to
6 s, so that join times out routinely under load. The journals are then never
closed, and the old AppDomain's worker can keep appending to `to-ide.jsonl`
while the new AppDomain opens its own writer on the same file — violating
single-writer-per-file, the one invariant the entire transport rests on.

A related latent bug sits in `EnqueueAndWait` itself: on timeout it throws out
of a `using` block while the still-queued action holds the `ManualResetEventSlim`,
so the next `Pump()` calls `Set()` on a disposed object.

### F4 — Sends hang while disconnected

`run_journal_session` drains `client_rx` only under `if connected`.
`unity_ipc_send` pushes into a **bounded(64)** channel and `.await`s it.
Disconnected, the first 64 sends queue invisibly and the 65th blocks forever —
the Tauri command never returns, so the frontend's `await` never settles and its
`.catch()` never runs. On reconnect, 64 stale messages flush at once. RPCs take
the same path and then fail with a misleading "timed out" after 10 s instead of
"not connected" immediately.

### F5 — Stale-package detection is one-shot

`stale_checked` is set once and never reset, so the "package missing / outdated"
prompt can only fire in a session's first 15 s.

### F6 — No user-visible retry

`UnityBridgeStatusItem` is a non-interactive `<span>` with a tooltip.
`BridgeInstallBanner` offers an action only in the `not-installed` state. In
`disconnected` there is no control at all — the user's only recourse is to close
and reopen the project, which is what re-runs `unity_ipc_start`.

### F7 — Local dev writes dev tokens into the production config dir

`arcane_home_dir` keys off the bundle identifier: `~/.arcane-dev` when it ends
in `.dev`, `~/.arcane` otherwise. Only `tauri.dev.conf.json` sets the `.dev`
identifier, and nothing forces a local run through it. A plain `tauri dev` gets:

| | local `tauri dev` | downloaded dev build |
|---|---|---|
| API / web URL | dev (`.env.development`) | dev |
| config dir | `~/.arcane` ❌ | `~/.arcane-dev` |
| deep-link scheme | `arcane` ❌ | `arcane-dev` |

Two independent things encode "dev-ness" — the Vite mode picks the endpoints,
the Tauri config file picks the identity — and under a plain `tauri dev` they
disagree. The result is a **dev**-API token written into the **production**
app's config dir, which the real Arcane then picks up and presents to the
production API. (Observed: `~/.arcane` fully populated, `~/.arcane-dev` empty.)

## Decision

Keep the transport untouched. Fix the session layer with one recovery
primitive — **session re-arm** — and make it reachable both automatically and
from the UI.

### Why re-arm rather than a re-announce request

Two alternatives were considered:

**A `reannounce` message from the IDE.** The IDE would write a line asking Unity
to handshake again. Rejected: it breaks the invariant that the IDE writes
*nothing* to `to-unity.jsonl` before a matching `connection_init`, which is
precisely what closes the startup race in both orderings. Carving out an
exception trades a rare bug for a subtle one.

**Resurrect on any inbound byte.** Treat traffic as liveness and flip `connected`
back to true. Rejected: `projectInfo` would be stale or missing, it does nothing
for F1 (no bytes arrive when the read head is already past the handshake), and
it papers over a genuinely dead Unity session.

Re-arm reuses the mechanism that already exists and is already the reason an IDE
restart recovers: a changed `ideSessionId` in `bridge.json`. No protocol change,
no new invariant, and — the point that decided it — the automatic retry and the
manual retry button become the *same code path*.

## Design

### Session re-arm

While `!connected`, the IDE re-arms after `REARM_GRACE_MS` and then every
`REARM_INTERVAL_MS`. One re-arm is:

1. Mint a fresh `ide_session_id`.
2. Truncate `to-unity.jsonl` (bumping its epoch).
3. Clear `unity_session_id`, drain in-flight RPCs, reset the reader to offset 0.
4. Reset `stale_checked` so package detection can fire again (fixes F5).
5. Rewrite `bridge.json` atomically with the new id.

Unity's existing 1 s discovery poll sees the changed `ideSessionId`, takes the
`freshHandshake` branch, truncates `to-ide.jsonl` and re-announces. The IDE's
epoch check turns that truncation into a reset back to 0.

A `mpsc` trigger channel lets `unity_ipc_reconnect` force one immediately,
bypassing the grace period.

Re-arm is skipped entirely for workspaces with no `ProjectSettings/` — those are
not Unity projects and never get a `bridge.json`.

**Why re-arm cannot livelock with an in-flight handshake.** Suppose the IDE
re-arms to `B2` while Unity is mid-write of `connection_init{B1}`. The IDE reads
it, sees `B1 ≠ B2`, and discards it under the existing gate. Unity's next
discovery poll (≤ 1 s) observes `B2` and handshakes again. Convergence takes
about a second, against a 10 s re-arm interval.

### Never skip an unseen handshake (F1)

Drop `seek_to_end()` from the first reader open. Start at offset 0 and, until
connected, discard every inbound message that is not a `connection_init` echoing
the current `ide_session_id`. The gate already does exactly this for
`connection_init`; it simply extends to every other type.

This is what makes the race unwinnable in either ordering: whether the handshake
lands before or after the IDE opens its reader, the IDE sees it.

Replaying a stale backlog costs nothing worth optimising — it is bounded by
`ROTATE_THRESHOLD` (4 MiB), read at `MAX_READ_PER_POLL` per poll, and discarded
without dispatch. In practice Unity truncates on fresh handshake anyway, so the
IDE reads a stale tail once and is then reset to 0.

Poll at a new `POLL_CONNECTING_MS` (100 ms) while unconnected, rather than
decaying to the 250 ms idle rate. Ten `fstat`s a second is negligible, and it
halves the worst-case handshake latency.

### Silent domain reloads (F3)

`BridgeClient.Stop()` takes a reason:

| Reason | Appends | Called from |
|---|---|---|
| `Quit` | `disconnect` | `EditorApplication.quitting` |
| `Reload` | `reloading` | `AssemblyReloadEvents.beforeAssemblyReload` |

`reloading` is a new Unity → IDE message. It is purely additive: the IDE already
ignores unknown inbound types, and so does the C# side, so no protocol version
bump is needed and the package version stays `0.1.0`.

On `reloading` the IDE keeps `connected` true and extends the peer-dead deadline
to `RELOAD_DEAD_MS` (90 s) until traffic resumes. A recompile therefore no
longer drops the connection or clears pending RPCs, and messages sent mid-reload
simply sit in `to-unity.jsonl` for the new AppDomain to read at its restored
offset — the journal is already a durable buffer, so this needs no extra
machinery.

Unity additionally stops re-announcing on a **warm resume**: `SendConnectionInit`
is now gated on `freshHandshake`, matching Sequence C and removing the
`EnqueueAndWait` blocking call from the hot reload path entirely.

A package that never sends `reloading` still works: the IDE times out at
`PEER_DEAD_MS` and re-arms, which recovers the session within about 15 s.

### Closing the two-writer hazard (F3)

`MainThreadDispatcher` gains a cancellation signal:

- `BeginShutdown()` sets a cancelled flag and releases every waiter, so
  `EnqueueAndWait` returns promptly instead of holding the worker for its full
  timeout. Called at the top of `BridgeBootstrap.Shutdown()`, *before*
  `_client.Stop()`, so the join can succeed.
- `Reset()` clears the flag for the next AppDomain.
- The waiter's `ManualResetEventSlim` is no longer disposed while a queued
  action can still reach it, fixing the latent `ObjectDisposedException`.

`BridgeClient` also checks `_running` before each append, so a worker that
somehow outlives its `Stop()` cannot write to a journal the next AppDomain now
owns.

### Fail fast instead of hanging (F4)

`UnityIpcInner` gains `connected: AtomicBool`, published by the session loop.

- `unity_ipc_send` and `unity_ipc_request` read it and return
  `Err("Unity is not connected")` immediately.
- The channel grows to 256 slots and uses `try_send`, so a full queue is an
  error rather than an unbounded await.
- The session loop drains `client_rx` unconditionally, discarding while
  disconnected, so nothing accumulates across a reconnect.

### Retry UX (F6)

- `unity_ipc_reconnect` — forces an immediate re-arm.
- `unity_ipc_status` — returns the current connection state, so the UI can
  resync on mount instead of depending purely on having caught every event.
- `bridgeState` gains `'connecting'`, with a matching `--connecting` dot rule in
  `App.css` (including in the `prefers-reduced-motion` block).
- `UnityBridgeStatusItem` becomes a button: clicking it while not connected
  fires a reconnect and shows "Reconnecting…".
- `BridgeInstallBanner` gains a **Retry** button in the `disconnected` state.
- `unity.reconnectBridge` joins the existing `unity.*` command-palette entries.

### Dev-build parity (F7)

Two halves, because the scripts alone only make the right thing convenient:

1. **Make it the default.** The local dev script points at
   `tauri.dev.conf.json`, so any ordinary local run gets `com.inno.editor.dev`
   → `~/.arcane-dev` and the `arcane-dev` scheme, exactly matching the
   downloaded dev build.
2. **Make drift impossible.** A startup guard compares the channel implied by
   the bundle identifier against the channel implied by the frontend's API URL.
   A mismatch is fatal at launch with a message naming both sides, rather than a
   silent write of a dev token into `~/.arcane`.

## Testing

**Rust.** Regression test for F1: a handshake written entirely between two polls
must still be dispatched. Pre-handshake filtering drops non-handshake traffic.
Re-arm mints a new id and republishes `bridge.json`. `reloading` extends the
deadline past `PEER_DEAD_MS`. Send and request fail fast while disconnected.

**C#.** `Stop(Reload)` appends `reloading`, not `disconnect`; `Stop(Quit)`
appends `disconnect`. A warm resume does not re-announce. `EnqueueAndWait`
returns promptly once `BeginShutdown()` is signalled, and no waiter touches a
disposed handle.

**Config.** The merged dev config's identifier ends in `.dev`, and
`.env.development` points at the dev endpoints — so the two halves of "dev-ness"
cannot drift apart again.

## Non-goals

- No change to the journal transport, file layout, epoch/ack protocol, or wire
  format.
- No protocol version bump. `reloading` is additive and both sides already
  ignore unknown types.
- No package version bump — stays `0.1.0` at the product owner's direction.

## Risks

1. **Re-arm churn while Unity is closed.** Two small file writes every 10 s,
   forever, on a Unity project with no editor running. Negligible, and it is
   what makes an unattended Unity launch connect without user action.
2. **Reading a stale backlog on first open.** Bounded by `ROTATE_THRESHOLD` and
   discarded without dispatch. Accepted in exchange for closing F1.
3. **`RELOAD_DEAD_MS` is 90 s.** A Unity that dies *during* a domain reload is
   reported dead after 90 s rather than 8 s. Accepted: the alternative is
   dropping the connection on every long recompile, which is the bug being
   fixed.
