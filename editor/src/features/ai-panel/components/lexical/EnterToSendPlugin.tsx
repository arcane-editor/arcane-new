/**
 * EnterToSendPlugin — intercepts Enter (without Shift) and triggers send.
 * Shift+Enter falls through to Lexical's default behavior (insert newline).
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND } from 'lexical';

interface Props {
  onSend: () => void;
  enabled: boolean;
}

function EnterToSendPlugin({ onSend, enabled }: Props) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!event) return false;
        if (event.shiftKey) return false; // let Lexical insert a newline
        if (!enabled) return true; // swallow when disabled (running)
        event.preventDefault();
        onSend();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSend, enabled]);

  return null;
}

export default EnterToSendPlugin;
