/**
 * ImageAttachButton — opens a native file picker filtered to images and stages
 * whatever comes back as chat context.
 *
 * The reading, capping and encoding live in `services/image-attach.ts`, shared
 * with the design dock's own attach button and its paste and drop paths: a
 * picker, a paste and an OS drop all have to produce a byte-identical
 * attachment.
 *
 * Sits in the composer toolbar on the right, next to the send button.
 */

import { ImagePlus } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { pickImages } from '../services/image-attach';

function ImageAttachButton() {
  const addAttachment = useAiStore((s) => s.addAttachment);
  const setError = useAiStore((s) => s.setError);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  async function handleClick() {
    const { attachments, errors } = await pickImages();
    for (const attachment of attachments) addAttachment(attachment);
    if (errors.length > 0) setError(errors.join(' • '));
  }

  return (
    <button
      type="button"
      className="ai-panel-icon-btn"
      onClick={handleClick}
      disabled={isAgentRunning}
      title="Attach image"
      aria-label="Attach image"
    >
      <ImagePlus size={15} strokeWidth={1.75} />
    </button>
  );
}

export default ImageAttachButton;
