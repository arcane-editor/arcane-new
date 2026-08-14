/**
 * ClearOnSendPlugin — the imperative bridge to the Lexical editor instance.
 *
 * Exposes `clear()`, so handleSend in the composer can wipe the editor after
 * dispatching, and `setText()`, so something outside the composer entirely
 * (the empty state's starter prompts) can put a request in the box for the
 * user to edit before sending. Both need the editor instance, which only
 * exists inside the LexicalComposer context — hence one plugin rather than
 * two.
 */

import { forwardRef, useImperativeHandle } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';

export interface ClearOnSendHandle {
  clear: () => void;
  /** Replace the editor's contents with `text` and put the caret at its end. */
  setText: (text: string) => void;
}

const ClearOnSendPlugin = forwardRef<ClearOnSendHandle, {}>((_props, ref) => {
  const [editor] = useLexicalComposerContext();

  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        editor.update(() => {
          $getRoot().clear();
        });
      },
      setText: (text: string) => {
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          const paragraph = $createParagraphNode();
          paragraph.append($createTextNode(text));
          root.append(paragraph);
          // Caret at the end, so the box is immediately typable — a starter is
          // a first draft to extend, not a finished message.
          paragraph.selectEnd();
        });
      },
    }),
    [editor],
  );

  return null;
});

ClearOnSendPlugin.displayName = 'ClearOnSendPlugin';

export default ClearOnSendPlugin;
