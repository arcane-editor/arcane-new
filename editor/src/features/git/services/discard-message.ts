import { ask } from '@tauri-apps/plugin-dialog';

export interface DiscardScope {
  scope: 'all' | 'file';
  /** Present for `scope: 'file'`. */
  fileName?: string;
  /** Tracked files that will be reverted to HEAD. */
  tracked: number;
  /** Untracked files that will be deleted from disk. */
  untracked: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The text of the discard confirmation.
 *
 * Split out from the prompt so the wording is testable — the counts and the
 * untracked warning are the entire reason this dialog exists, and getting them
 * wrong is the same as not having it.
 *
 * Tracked and untracked are described separately and in different terms
 * because their consequences differ enormously: a reverted tracked file is
 * recoverable from the object store, while an untracked file is in no commit
 * and no stash and is simply gone.
 */
export function buildDiscardMessage(input: DiscardScope): string {
  const { scope, fileName, tracked, untracked } = input;
  const lines: string[] = [];

  if (scope === 'file' && fileName) {
    lines.push(
      untracked > 0
        ? `${fileName} is a new file.`
        : `${fileName} will be reverted to its last committed state.`,
    );
  } else {
    if (tracked > 0) {
      lines.push(`${plural(tracked, 'tracked file', 'tracked files')} will be reverted to HEAD.`);
    }
    if (tracked === 0 && untracked === 0) {
      lines.push('This will discard all working-tree changes.');
    }
  }

  if (untracked > 0) {
    lines.push(
      `${plural(untracked, 'new file', 'new files')} will be permanently deleted. ` +
        'New files are not in any commit or stash and cannot be recovered.',
    );
  }

  lines.push('This cannot be undone.');
  return lines.join('\n\n');
}

/**
 * Prompt before discarding. Returns true when the discard should proceed.
 *
 * VS Code, which this panel otherwise mirrors, gates the same action behind an
 * explicit irreversibility modal. Uses the native `ask` dialog for consistency
 * with `confirmCloseDirty` and `useCloseGuard` — and because an OS-modal
 * dialog cannot be missed the way an in-page one can.
 */
export async function confirmDiscard(input: DiscardScope): Promise<boolean> {
  return ask(buildDiscardMessage(input), {
    title: input.scope === 'all' ? 'Discard All Changes' : 'Discard Changes',
    kind: 'warning',
    okLabel: 'Discard',
    cancelLabel: 'Cancel',
  });
}
