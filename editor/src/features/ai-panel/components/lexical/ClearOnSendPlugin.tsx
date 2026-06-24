/**
 * ClearOnSendPlugin — exposes an imperative `clear()` to the parent via ref,
 * so handleSend in the composer can wipe the editor after dispatching.
 */

import { forwardRef, useImperativeHandle } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot } from 'lexical';

export interface ClearOnSendHandle {
  clear: () => void;
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
    }),
    [editor],
  );

  return null;
});

ClearOnSendPlugin.displayName = 'ClearOnSendPlugin';

export default ClearOnSendPlugin;
