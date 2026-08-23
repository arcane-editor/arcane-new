/**
 * AttachmentChip — pill displaying an attachment. Click opens the resource;
 * the × removes it from staging.
 *
 * Files carry their real Material icon and their parent directory, because a
 * basename alone is ambiguous in any project with more than one `index.ts`.
 * The directory is dimmed and truncates from the left so the deepest — and
 * most disambiguating — segment survives the truncation.
 */

import { BookOpen, ClipboardList, Image as ImageIcon, Boxes, Box, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useAiStore } from '../../../stores/ai';
import { FileIcon } from '../../../utils/file-icons';
import { pasteChipLabel } from '../data/paste-chip';
import type { Attachment } from '../services/types';

interface Props {
  attachment: Attachment;
  /** When false, the remove button is hidden (e.g. inside a sent message). */
  removable?: boolean;
}

/** Splits a workspace-relative path into its basename and parent directory. */
function splitRelPath(relPath: string): { name: string; dir: string } {
  const idx = relPath.lastIndexOf('/');
  if (idx < 0) return { name: relPath, dir: '' };
  return { name: relPath.slice(idx + 1), dir: relPath.slice(0, idx) };
}

function AttachmentChip({ attachment: a, removable = true }: Props) {
  const removeAttachment = useAiStore((s) => s.removeAttachment);
  const openFile = useWorkspaceStore((s) => s.openFile);

  function handleOpen() {
    if (a.kind === 'file' || a.kind === 'unity-asset') {
      openFile(a.path, a.relPath.split('/').pop() ?? a.relPath);
    } else if (a.kind === 'unity-doc') {
      openUrl(a.url).catch(() => {});
    }
    // Image: lightbox in Phase 8 polish; no-op for now.
  }

  function handleRemove(e: React.MouseEvent) {
    e.stopPropagation();
    removeAttachment(a.id);
  }

  let icon: React.ReactNode;
  let label: string;
  let dir = '';
  /** Leading content of a pasted slab. Truncates from the END, unlike `dir`. */
  let preview = '';
  let title: string;

  switch (a.kind) {
    case 'file': {
      const parts = splitRelPath(a.relPath);
      icon = <FileIcon name={parts.name} size={14} />;
      label = parts.name;
      dir = parts.dir;
      title = a.relPath;
      break;
    }
    case 'unity-asset': {
      const parts = splitRelPath(a.relPath);
      icon = <FileIcon name={parts.name} size={14} />;
      label = parts.name;
      dir = parts.dir;
      title = a.relPath;
      break;
    }
    case 'unity-doc':
      icon = <BookOpen size={12} />;
      label = a.name;
      title = `${a.name} — ${a.url}`;
      break;
    case 'image':
      icon = <ImageIcon size={12} />;
      label = a.sourceLabel || 'image';
      title = a.sourceLabel || 'image';
      break;
    case 'unity-context':
      icon = <Boxes size={12} />;
      label = `@${a.verb}`;
      title = `Live Unity ${a.verb} (resolved when sent)`;
      break;
    case 'unity-object':
      icon = <Box size={12} />;
      label = a.name;
      title = `Live GameObject "${a.name}" (resolved when sent)`;
      break;
    case 'pasted-text':
      icon = <ClipboardList size={12} />;
      label = pasteChipLabel(a.text);
      // The opening of the paste, so the chip is identifiable when three are
      // staged at once — "Pasted 40 lines" three times over says nothing.
      //
      // NOT in `dir`: that span is `direction: rtl` so a path truncates from
      // the left and keeps its deepest segment. Right for a path, exactly
      // backwards for a code preview, which is identified by how it STARTS.
      preview = a.text.split('\n', 1)[0].trim().slice(0, 80);
      title = a.text.slice(0, 400) + (a.text.length > 400 ? '\n…' : '');
      break;
  }

  return (
    <button
      type="button"
      className={`ai-panel-attachment-chip ai-panel-attachment-chip--${a.kind}`}
      onClick={handleOpen}
      title={title}
    >
      {a.kind === 'image' && a.dataUrl ? (
        <img src={a.dataUrl} alt={a.sourceLabel} className="ai-panel-attachment-thumb" />
      ) : (
        <span className="ai-panel-attachment-icon">{icon}</span>
      )}
      <span className="ai-panel-attachment-label">{label}</span>
      {dir && <span className="ai-panel-attachment-dir">{dir}</span>}
      {preview && <span className="ai-panel-attachment-preview">{preview}</span>}
      {removable && (
        <span
          role="button"
          aria-label="Remove attachment"
          className="ai-panel-attachment-remove"
          onClick={handleRemove}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <X size={11} />
        </span>
      )}
    </button>
  );
}

export default AttachmentChip;
