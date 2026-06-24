/**
 * DropImagePlugin — when the user drops one or more image files onto the
 * editor, encode each as a data URL and stage as an image attachment.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_LOW, DROP_COMMAND } from 'lexical';
import { useAiStore } from '../../../../stores/ai';
import { encodeImageFromBlob } from '../../services/attachments';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function DropImagePlugin() {
  const [editor] = useLexicalComposerContext();
  const addAttachment = useAiStore((s) => s.addAttachment);
  const setError = useAiStore((s) => s.setError);

  useEffect(() => {
    return editor.registerCommand(
      DROP_COMMAND,
      (event) => {
        if (!(event instanceof DragEvent)) return false;
        const dt = event.dataTransfer;
        if (!dt || dt.files.length === 0) return false;

        const imageFiles: File[] = [];
        for (let i = 0; i < dt.files.length; i++) {
          const f = dt.files[i];
          if (f.type.startsWith('image/')) imageFiles.push(f);
        }
        if (imageFiles.length === 0) return false;

        event.preventDefault();

        for (const f of imageFiles) {
          if (f.size > MAX_IMAGE_BYTES) {
            setError(`Image \`${f.name}\` exceeds 4MB and was skipped.`);
            continue;
          }
          encodeImageFromBlob(f)
            .then(({ dataUrl, mimeType }) => {
              addAttachment({
                kind: 'image',
                id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                dataUrl,
                mimeType,
                sourceLabel: f.name,
              });
            })
            .catch((err) => {
              setError(`Failed to read dropped image: ${String(err)}`);
            });
        }

        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, addAttachment, setError]);

  return null;
}

export default DropImagePlugin;
