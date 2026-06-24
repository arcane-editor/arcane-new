/**
 * PasteImagePlugin — when the user pastes one or more images (e.g. a
 * screenshot from clipboard), encode each as a data URL and stage as an
 * image attachment. Any text content in the paste is left to the default
 * Lexical paste handler.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_LOW, PASTE_COMMAND } from 'lexical';
import { useAiStore } from '../../../../stores/ai';
import { encodeImageFromBlob } from '../../services/attachments';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB cap per image

function PasteImagePlugin() {
  const [editor] = useLexicalComposerContext();
  const addAttachment = useAiStore((s) => s.addAttachment);
  const setError = useAiStore((s) => s.setError);

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent)) return false;
        const items = event.clipboardData?.items;
        if (!items || items.length === 0) return false;

        const imageFiles: File[] = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const f = item.getAsFile();
            if (f) imageFiles.push(f);
          }
        }
        if (imageFiles.length === 0) return false;

        // Consume the paste — don't let Lexical insert anything else for it.
        event.preventDefault();

        for (const f of imageFiles) {
          if (f.size > MAX_IMAGE_BYTES) {
            setError(`Image \`${f.name || 'pasted'}\` exceeds 4MB and was skipped.`);
            continue;
          }
          encodeImageFromBlob(f)
            .then(({ dataUrl, mimeType }) => {
              addAttachment({
                kind: 'image',
                id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                dataUrl,
                mimeType,
                sourceLabel: f.name || 'pasted image',
              });
            })
            .catch((err) => {
              setError(`Failed to read pasted image: ${String(err)}`);
            });
        }

        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, addAttachment, setError]);

  return null;
}

export default PasteImagePlugin;
