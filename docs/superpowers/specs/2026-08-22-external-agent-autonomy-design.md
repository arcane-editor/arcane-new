# External agent autonomy — let Claude Code run as its own harness

**Date:** 2026-08-22
**Status:** approved, implementing

## Problem

Claude Code is an agent harness in its own right: it has its own tools, its own
permission modes, its own context budget and its own idea of how to explore a
codebase. Arcane currently wraps all of that in a second harness built for the
*Arcane* agent, and the two do not agree.

Three concrete bindings, in descending order of harm:

1. **The filesystem sandbox cages exploration and protects nothing.**
   `acp-fs.ts` resolves every `fs/read_text_file` and `fs/write_text_file`
   through `computeAllowedRoots()`, which on a Unity project returns
   `[Assets/, .arcane/, Packages/]`. Claude therefore cannot read
   `ProjectSettings/`, the repo root, `*.csproj`, or `.git` through its Read
   tool.

   The sandbox does not contain it, though: `acp-terminals.ts` applies **no
   confinement at all**, so Claude's Bash tool can `cat` any file on the
   machine. The cage stops the legible path and leaves the illegible one open —
   the worst of both.

2. **Every write is force-enrolled in Arcane's Accept/Reject queue.**
   `handleFsWrite` calls `useEditReviewStore.register()` on each write, so
   Claude's edits inherit a review workflow designed around the Arcane agent's
   `auto` apply mode. Claude already decides when to ask.

3. **Arcane-only chrome renders under a Claude session.**
   `MessageList` shows `PlanActions` (the Execute / Regenerate / Open card for
   `.arcane/plans/*.md`) whenever `planPhase === 'awaiting-execute'`, with no
   agent gate. Switch agents mid-thread and Arcane's plan card sits under a
   "Claude Code" header offering to execute a plan Claude never wrote.

Separately, and cosmetically: `.ai-message-content pre` is `overflow-x: auto`
with no wrapping. In a ~400px side panel a fenced block scrolls sideways and
clips mid-word, which is how a long plan renders as an unreadable slab.

## Non-goals

- **Claude's own permission card stays.** `session/request_permission` is
  *Claude* asking, governed by its own `mode` config option (already a pill in
  the composer). Surfacing that is not an Arcane imposition — suppressing it
  would be. Only the review queue layered *on top* is removed.
- **Per-message agent attribution.** Proposed, then cut as YAGNI. The
  served-model label is already conditioned on `message.servedModel`, which the
  Claude backend never sets; the plan card only needs the *active* agent. A
  field on every message buys nothing the session-level check does not.
- **No change to the Arcane agent's own sandbox.** `computeAllowedRoots` keeps
  its current behaviour for Arcane's tools.

## Design

### 1. Split the sandbox by operation, for external agents only

Reads and writes stop sharing a root set.

- **Reads: unconfined.** Resolve a relative path against the workspace, then
  read. No root check. This matches the access Claude already has through Bash,
  so it removes an inconsistency rather than granting new reach.
- **Writes: workspace root.** A single root — the open folder — rather than
  `[Assets/, .arcane/, Packages/]`. This is the one confinement that does real
  work (a bad tool call cannot reach `~/.ssh/config`) and costs nothing for
  normal project work.

New pure function in `sandbox-roots.ts`:

```ts
export function computeExternalAgentWriteRoots(workspacePath: string): readonly string[]
```

Returns `[]` for the no-workspace placeholder (`''` or `'/'`) — deny-all, matching
`computeAllowedRoots`'s existing treatment — and `[workspacePath]` otherwise.

### 2. Raise the read cap

`MAX_READ_BYTES` goes from 256 KB to 2 MB. Claude manages its own context
window and will window a large file itself; a 256 KB truncation mostly means it
re-reads in pieces. The cap is kept rather than removed so a single call cannot
push an unbounded string across the Tauri IPC boundary.

### 3. Drop the review queue, keep the undo

`handleFsWrite` keeps `useCheckpointsStore.recordPreWrite()` and stops calling
`useEditReviewStore.register()`.

Checkpoints are what "restore this turn" is built on, and are agent-agnostic —
they record bytes, not workflow. The review queue is a workflow. Order in
`handleFsWrite` is otherwise unchanged and still load-bearing: resolve, read
prior content, write.

`ReviewBar` needs no change; it hides itself when nothing is pending.

### 4. Gate the plan card on the active agent

`MessageList`'s `showPlanActions` gains `&& selectedAgent === 'arcane'`.

### 5. Wrap code blocks instead of scrolling them

`.ai-message-content pre` becomes `white-space: pre-wrap` with
`overflow-wrap: anywhere`, keeping `overflow-x: auto` for content that still
cannot fit (wide tables). In a narrow panel a wrapped line is readable and a
clipped one is not; horizontal scrolling inside a vertically-scrolling
transcript is also a poor interaction on a trackpad.

## Testing

Pure functions carry the load, matching the codebase's existing discipline
(`sandbox-roots.ts`, `empty-state.ts`, `claude-connect.ts` are all tested this
way; the project has no component-test infrastructure).

- `computeExternalAgentWriteRoots` — workspace root returned; `''` and `'/'`
  deny-all; Unity project is **not** narrowed to `Assets/`.
- Regression: `computeAllowedRoots` still returns the Unity triple, so the
  Arcane agent's sandbox is untouched.
- `handleFsWrite` no longer registers for review — asserted against the module
  source, the way `AssistantMessage.test.ts` asserts render conditions.

Full `bun run verify`, including `verify:acp` against the real adapter.

## Risks

- **Unconfined reads are a real widening**, even though Bash already offered the
  same reach. A prompt-injected Claude could read `~/.aws/credentials` via its
  Read tool without a terminal call. Accepted deliberately: the alternative
  cages the honest path while leaving the dishonest one open, and the user chose
  "free to explore".
- **Losing the review row changes recovery ergonomics.** Undo moves from
  per-edit (Reject a row) to per-turn (restore the turn). That is the trade the
  "keep undo, drop the cage" decision makes explicit.
- **Wrapping code blocks hurts genuinely wide code** (long minified lines, wide
  tables). Mitigated by keeping `overflow-x: auto` as the fallback.
