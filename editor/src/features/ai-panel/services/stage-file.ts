/**
 * Building `file` attachments from a path.
 *
 * Shared by the @-mention picker and the drag-and-drop zone so both produce
 * identical attachments — a chip staged either way must resolve, render and
 * send the same.
 *
 * No store imports at module scope, deliberately: `stores/ai` transitively
 * reaches `stores/theme`, which touches `window.localStorage` at module-eval
 * time and crashes under `bun test`'s no-DOM environment. Same constraint the
 * sibling `attachments.ts` documents at length.
 */

import type { Attachment } from './types';

/** Workspace-relative form of an absolute path, or the path itself if outside. */
export function relPathOf(absPath: string, workspacePath: string | null): string {
  // The trailing slash matters: without it `/workspace-old` would be treated
  // as living under `/workspace`.
  if (workspacePath && absPath.startsWith(workspacePath + '/')) {
    return absPath.slice(workspacePath.length + 1);
  }
  return absPath;
}

function newAttachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Builds a `file` attachment.
 *
 * `bytes` is 0 here, matching the mention picker: the size is not known until
 * `resolveAttachments` reads the file at send time, and it is only used there
 * for truncation accounting.
 */
export function buildFileAttachment(
  absPath: string,
  workspacePath: string | null,
): Extract<Attachment, { kind: 'file' }> {
  return {
    kind: 'file',
    id: newAttachmentId(),
    path: absPath,
    relPath: relPathOf(absPath, workspacePath),
    bytes: 0,
  };
}

/** True when this exact file is already staged, so a repeat drop can no-op. */
export function isAlreadyStaged(staged: Attachment[], absPath: string): boolean {
  return staged.some((a) => a.kind === 'file' && a.path === absPath);
}
