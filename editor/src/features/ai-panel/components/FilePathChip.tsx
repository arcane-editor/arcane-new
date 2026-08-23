/**
 * FilePathChip — an inline file reference in assistant prose, made openable.
 *
 * The assistant names files constantly ("the fix is in `ChatInput.tsx:189`")
 * and until now every one of those was dead text you had to re-find by hand
 * through Go-to-file. This turns them into the same affordance the composer
 * already uses for staged context: real Material icon, basename, click to open.
 *
 * Deliberately reuses `AttachmentChip`'s vocabulary rather than inventing a
 * second file affordance — a file should look like a file everywhere in this
 * panel. It is sized DOWN from that chip, though, because this one sits inside
 * a line of prose rather than in a rail of its own: same idea, quieter voice.
 *
 * Whether a token is a file at all is `data/file-ref.ts`'s decision, not this
 * component's.
 */

import { useWorkspaceStore } from '../../../stores/workspace';
import { setPendingNavigation } from '../../../utils/editor-navigation';
import { FileIcon } from '../../../utils/file-icons';
import type { FileRef } from '../data/file-ref';

interface Props {
  refr: FileRef;
  /** The original text, shown verbatim so the prose still reads as written. */
  label: string;
}

function FilePathChip({ refr, label }: Props) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  const name = refr.path.slice(refr.path.lastIndexOf('/') + 1);

  async function open() {
    // A relative reference is relative to the workspace — which is what the
    // assistant means by one, since that is the cwd it was given.
    const absolute = refr.path.startsWith('/')
      ? refr.path
      : workspacePath
        ? `${workspacePath}/${refr.path.replace(/^\.\//, '')}`
        : refr.path;

    // BEFORE openFile, never after: `EditorPanel`'s `activeFilePath`-keyed
    // effect is what consumes this, and setting it later loses the race and
    // silently drops the navigation. See `search/services/open-excerpt.ts`,
    // which documents the same trap at length.
    if (refr.line !== undefined) {
      setPendingNavigation({ line: refr.line, column: refr.column ?? 1 });
    }

    try {
      await useWorkspaceStore.getState().openFile(absolute, name);
    } catch {
      // A path the assistant invented, or one outside the workspace. Silent:
      // the chip simply does nothing, which is what a dead link should do —
      // an error banner for a mis-typed filename would be worse than the
      // plain text this replaced.
    }
  }

  return (
    <button
      type="button"
      className="ai-file-chip"
      onClick={() => void open()}
      title={refr.line !== undefined ? `${refr.path}:${refr.line}` : refr.path}
    >
      <FileIcon name={name} size={12} />
      <span className="ai-file-chip-label">{label}</span>
    </button>
  );
}

export default FilePathChip;
