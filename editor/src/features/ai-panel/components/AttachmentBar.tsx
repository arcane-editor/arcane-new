/**
 * AttachmentBar — horizontal row of staged attachment chips above the input.
 * Hidden when no attachments are staged.
 */

import { useAiStore } from '../../../stores/ai';
import AttachmentChip from './AttachmentChip';

function AttachmentBar() {
  const attachments = useAiStore((s) => s.attachments);
  if (attachments.length === 0) return null;

  return (
    <div className="ai-panel-attachments">
      {attachments.map((a) => (
        <AttachmentChip key={a.id} attachment={a} />
      ))}
    </div>
  );
}

export default AttachmentBar;
