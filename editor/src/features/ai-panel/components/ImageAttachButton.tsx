/**
 * ImageAttachButton — opens a native file picker filtered to images, reads
 * the selected file as bytes via @tauri-apps/plugin-fs, encodes it as a base64
 * data URL, and stages it as an image attachment.
 *
 * Sits in the composer toolbar on the right, next to the send button.
 */

import { ImagePlus } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { useAiStore } from '../../../stores/ai';
import { encodeImageFromBlob } from '../services/attachments';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'image/png';
}

function ImageAttachButton() {
  const addAttachment = useAiStore((s) => s.addAttachment);
  const setError = useAiStore((s) => s.setError);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  async function handleClick() {
    let selected: string | string[] | null;
    try {
      selected = await openDialog({
        multiple: true,
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
          },
        ],
      });
    } catch (err) {
      setError(`Failed to open file picker: ${String(err)}`);
      return;
    }
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];

    for (const path of paths) {
      try {
        const bytes = await readFile(path);
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          const name = path.split('/').pop() ?? path;
          setError(`Image \`${name}\` exceeds 4MB and was skipped.`);
          continue;
        }
        const mimeType = mimeForPath(path);
        const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
        const { dataUrl } = await encodeImageFromBlob(blob);
        addAttachment({
          kind: 'image',
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          dataUrl,
          mimeType,
          sourceLabel: path.split('/').pop() ?? path,
        });
      } catch (err) {
        setError(`Failed to attach image: ${String(err)}`);
      }
    }
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
