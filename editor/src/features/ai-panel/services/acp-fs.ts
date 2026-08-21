/**
 * `fs/read_text_file` and `fs/write_text_file` on behalf of an external agent.
 *
 * Arcane advertises the ACP filesystem capabilities deliberately. An agent that
 * is NOT given them does its own file I/O behind our back — which works, but
 * means its edits arrive in the workspace with no checkpoint to undo them, no
 * entry in the Accept/Reject review queue, and no sandbox. Routing every write
 * through here is what makes Claude's edits feel native: the same per-turn
 * restore, the same ReviewBar, the same confinement to the project.
 *
 * What this file must NOT do is prompt. The agent has already asked the user
 * for permission through `session/request_permission` before calling us; a
 * second Arcane-side approval on the same edit is a double prompt, and users
 * read the second one as a bug. Post-hoc review is the safety net here, exactly
 * as it is for the Arcane agent in its default `auto` apply mode.
 */

import { invoke } from '@tauri-apps/api/core';
import type { FsReadParams, FsWriteParams } from '../../acp';
import { useAiStore } from '../../../stores/ai';
import { useCheckpointsStore } from '../../../stores/checkpoints';
import { useEditReviewStore } from '../../../stores/edit-review';
import { useProjectContextStore } from '../../../stores/project-context';
import { useWorkspaceStore } from '../../../stores/workspace';
import { computeAllowedRoots } from './sandbox-roots';
import {
  PathOutsideRootError,
  pathOutsideRootMessage,
  resolveWithinRoot,
} from './vendor/tools/path-utils';

/** Matches `read`'s cap, so an agent cannot pull a 50 MB asset into its context. */
const MAX_READ_BYTES = 256 * 1024;

function workspacePath(): string {
  return useWorkspaceStore.getState().workspacePath ?? '/';
}

/**
 * The same roots the Arcane agent's own tools are confined to.
 *
 * Recomputed per call rather than captured at session start: the user can open
 * a different project, or Unity detection can complete, while an agent session
 * is alive.
 */
function allowedRoots(): readonly string[] {
  const isUnity = useProjectContextStore.getState().isUnityProject;
  return computeAllowedRoots(
    workspacePath(),
    isUnity,
    isUnity ? (useWorkspaceStore.getState().assetsRootPath ?? null) : null,
  );
}

/**
 * Resolve an agent-supplied path inside the sandbox, or throw a message written
 * for the agent to act on.
 *
 * The agent sees this text as a tool error and can retry with a legal path, so
 * it explains where it may write rather than just refusing.
 */
function resolveSafe(path: string): string {
  try {
    return resolveWithinRoot(path, workspacePath(), allowedRoots());
  } catch (e) {
    if (e instanceof PathOutsideRootError) throw new Error(pathOutsideRootMessage(e));
    throw e;
  }
}

export async function handleFsRead(params: FsReadParams): Promise<{ content: string }> {
  const path = resolveSafe(params.path);
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
 *   3. write;
 *   4. register for review, so the edit joins the Accept/Reject queue.
 *
 * Step 4 comes last because registering an edit that failed to write would put
 * a phantom row in the ReviewBar.
 */
export async function handleFsWrite(params: FsWriteParams): Promise<null> {
  const path = resolveSafe(params.path);

  // `null` distinguishes "file did not exist" from "file was empty" — the
  // checkpoint restore needs that difference to know whether to delete the file
  // or write empty content back.
  const before = await invoke<string>('read_file', { path }).catch(() => null);

  useCheckpointsStore.getState().recordPreWrite(path, before);
  await invoke('write_file', { path, contents: params.content });
  useEditReviewStore.getState().register(path, `acp:${useAiStore.getState().acpSessionId ?? 'session'}`);

  return null;
}
