/**
 * PasteTextPlugin — a large text paste becomes a context chip, not composer text.
 *
 * Pasting a stack trace or a file into the composer buries the sentence you
 * were writing and leaves you scrolling a text box to find it again. Above a
 * threshold (`data/paste-chip.ts`) the paste is staged as an attachment
 * instead: it sits with the rest of your context, it is removable with one
 * click, and the composer stays about your words.
 *
 * Registered at LOW priority and after `PasteImagePlugin`, so a paste carrying
 * both an image and its alt text still reaches the image handler first. Returns
 * `false` for anything under the threshold, which leaves Lexical's own paste
 * handling completely untouched — that is the common case and it must not
 * change.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_LOW, PASTE_COMMAND } from 'lexical';
import { useAiStore } from '../../../../stores/ai';
import { pasteLineCount, shouldChipPaste } from '../../data/paste-chip';

function PasteTextPlugin() {
  const [editor] = useLexicalComposerContext();
  const addAttachment = useAiStore((s) => s.addAttachment);

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent)) return false;
        const dt = event.clipboardData;
        if (!dt) return false;

        // An image paste belongs to PasteImagePlugin. Bail rather than race it.
        if (dt.files.length > 0) return false;

        const text = dt.getData('text/plain');
        if (!shouldChipPaste(text)) return false;

        event.preventDefault();
        addAttachment({
          kind: 'pasted-text',
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          text,
          lineCount: pasteLineCount(text),
        });
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, addAttachment]);

  return null;
}

export default PasteTextPlugin;
