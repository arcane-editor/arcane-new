/**
 * AttachmentChip — pill displaying an attachment. Click opens the resource;
 * the × removes it from staging.
 */

import { FileText, BookOpen, Image as ImageIcon, Boxes, Box, X } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useAiStore } from '../../../stores/ai';
import type { Attachment } from '../services/types';

interface Props {
  attachment: Attachment;
  /** When false, the remove button is hidden (e.g. inside a sent message). */
  removable?: boolean;
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
  let title: string;

  switch (a.kind) {
    case 'file':
      icon = <FileText size={12} />;
      label = a.relPath.split('/').pop() ?? a.relPath;
      title = a.relPath;
      break;
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
    case 'unity-asset':
      icon = <Box size={12} />;
      label = a.relPath.split('/').pop() ?? a.relPath;
      title = a.relPath;
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
