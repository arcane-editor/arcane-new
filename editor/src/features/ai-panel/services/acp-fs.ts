/**
 * `fs/read_text_file` and `fs/write_text_file` on behalf of an external agent.
 *
 * UnityIDE advertises the ACP filesystem capabilities deliberately. An agent that
 * is NOT given them does its own file I/O behind our back, and its edits then
 * arrive with no checkpoint to undo them. Routing writes through here is what
 * keeps per-turn restore working for an agent that is otherwise autonomous.
 *
 * Reads and writes are NOT treated alike, and that asymmetry is the point:
 *
 *   - **Reads are unconfined.** The root check used to narrow a Unity project
 *     to `Assets/`, which put `ProjectSettings/`, the repo root, `*.csproj` and
 *     `.git` out of reach of the agent's Read tool. It never actually contained
 *     anything — `acp-terminals.ts` gives the same agent an unconfined shell,
 *     so every file the check refused was one `cat` away. It only made the
 *     legible path worse than the illegible one.
 *   - **Writes stay inside the open project.** This is the confinement that
 *     does real work, and it costs nothing for normal work.
 *
 * What this file must NOT do is prompt. The agent has already asked the user
 * for permission through `session/request_permission` before calling us — that
 * ask is the AGENT's, governed by its own permission mode — and a second
 * UnityIDE-side approval on the same edit is a double prompt users read as a bug.
 */

import { invoke } from '@tauri-apps/api/core';
import type { FsReadParams, FsWriteParams } from '../../acp';
import { useCheckpointsStore } from '../../../stores/checkpoints';
import { useWorkspaceStore } from '../../../stores/workspace';
import { computeExternalAgentWriteRoots } from './sandbox-roots';
import {
  PathOutsideRootError,
  pathOutsideRootMessage,
  resolveWithinRoot,
} from './vendor/tools/path-utils';

/**
 * A ceiling on one IPC payload, not a context-budget policy.
 *
 * It used to be 256 KB, mirroring the UnityIDE agent's `read` cap. An external
 * agent manages its own context window and will window a large file itself, so
 * the low cap mostly bought a re-read in pieces. The cap is kept — not removed
 * — so a single call cannot push an unbounded string across the Tauri boundary.
 */
const MAX_READ_BYTES = 2 * 1024 * 1024;

function workspacePath(): string {
  return useWorkspaceStore.getState().workspacePath ?? '/';
}

/**
 * Where an external agent may WRITE. Recomputed per call rather than captured at
 * session start: the user can open a different project while a session is alive.
 */
function writeRoots(): readonly string[] {
  return computeExternalAgentWriteRoots(workspacePath());
}

/**
 * Resolve a path for reading. No root check — see the asymmetry note at the top
 * of this file.
 *
 * A relative path is still resolved against the workspace, because that is what
 * the agent means by one: its session cwd is the workspace.
 */
function resolveForRead(path: string): string {
  return resolveWithinRoot(path, workspacePath(), null);
}

/**
 * Resolve a path for writing, or throw a message written for the agent to act
 * on. The agent sees this text as a tool error and can retry with a legal path,
 * so it explains where it may write rather than just refusing.
 */
function resolveForWrite(path: string): string {
  try {
    return resolveWithinRoot(path, workspacePath(), writeRoots());
  } catch (e) {
    if (e instanceof PathOutsideRootError) throw new Error(pathOutsideRootMessage(e));
    throw e;
  }
}

export async function handleFsRead(params: FsReadParams): Promise<{ content: string }> {
  const path = resolveForRead(params.path);
  const raw = await invoke<string>('read_file', { path });

  // `line` is 1-based in ACP; `limit` counts lines, not bytes.
  const hasWindow = params.line !== undefined || params.limit !== undefined;
  let content = raw;
  if (hasWindow) {
    const lines = raw.split('\n');
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit !== undefined ? start + params.limit : undefined;
    content = lines.slice(start, end).join('\n');
  }

  if (content.length > MAX_READ_BYTES) {
    // Truncate rather than fail: a partial read the agent can narrow is more
    // useful than an error it has to guess its way around.
    content =
      content.slice(0, MAX_READ_BYTES) +
      `\n\n[truncated at ${MAX_READ_BYTES} characters — read a line range to see more]`;
  }
  return { content };
}

/**
 * Write a file for the agent, capturing what it replaced.
 *
 * Ordering is load-bearing:
 *   1. resolve + sandbox-check, so an illegal path never reaches disk;
 *   2. read the previous content BEFORE writing — once the write lands, the
 *      only copy of the old bytes is the one we took here, and without it the
 *      turn's checkpoint cannot restore and Reject has nothing to revert to;
 *   3. write.
 *
 * There is deliberately no fourth step. Writes used to be registered with
 * `useEditReviewStore`, which put every one of the agent's edits in UnityIDE's
 * Accept/Reject queue — a workflow built around the UnityIDE agent's `auto` apply
 * mode, imposed on an agent that already decides for itself when to ask. The
 * checkpoint stays: it records bytes rather than workflow, and it is what
 * "restore this turn" is built on.
 */
export async function handleFsWrite(params: FsWriteParams): Promise<null> {
  const path = resolveForWrite(params.path);

  // `null` distinguishes "file did not exist" from "file was empty" — the
  // checkpoint restore needs that difference to know whether to delete the file
  // or write empty content back.
  const before = await invoke<string>('read_file', { path }).catch(() => null);

  useCheckpointsStore.getState().recordPreWrite(path, before);
  await invoke('write_file', { path, contents: params.content });

  return null;
}
