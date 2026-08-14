/**
 * LexicalChatInput — pure editable surface. Owns the Lexical editor, mention
 * trigger, paste/drop handlers. Exposes `submit()`, `clear()`, and `focus()`
 * imperatively so the parent composer can place the send button outside this
 * component (in the toolbar, alongside the mode pill / effort bars / etc.).
 *
 * Keyboard:
 *   - Enter (no Shift): submit
 *   - Shift+Enter: newline
 *   - @: opens mention popover (handled by MentionTriggerPlugin)
 */

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { $getRoot, type EditorState } from 'lexical';
import EnterToSendPlugin from './lexical/EnterToSendPlugin';
import ClearOnSendPlugin, {
  type ClearOnSendHandle,
} from './lexical/ClearOnSendPlugin';
import MentionTriggerPlugin from './lexical/MentionTriggerPlugin';
import { MentionNode } from './lexical/MentionNode';
import PasteImagePlugin from './lexical/PasteImagePlugin';
import DropImagePlugin from './lexical/DropImagePlugin';

export interface LexicalChatInputHandle {
  submit: () => void;
  clear: () => void;
  focus: () => void;
  /** Replace the contents — used by the empty state's starter prompts. */
  setText: (text: string) => void;
}

interface Props {
  placeholder: string;
  /** True when there's no workspace open — disables the entire surface. */
  disabled: boolean;
  /** Called whenever the editor's text content changes. */
  onTextChange: (hasText: boolean) => void;
  /** Called when the user submits (Enter or external trigger). */
  onSubmit: (text: string) => void;
}

const LexicalChatInput = forwardRef<LexicalChatInputHandle, Props>(
  function LexicalChatInput({ placeholder, disabled, onTextChange, onSubmit }, ref) {
    const [hasText, setHasText] = useState(false);
    const textRef = useRef('');
    const clearRef = useRef<ClearOnSendHandle | null>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const handleChange = useCallback(
      (editorState: EditorState) => {
        editorState.read(() => {
          const text = $getRoot().getTextContent();
          textRef.current = text;
          const next = text.trim().length > 0;
          setHasText(next);
          onTextChange(next);
        });
      },
      [onTextChange],
    );

    const submit = useCallback(() => {
      const text = textRef.current.trim();
      if (!text) return;
      onSubmit(text);
      clearRef.current?.clear();
      textRef.current = '';
      setHasText(false);
      onTextChange(false);
    }, [onSubmit, onTextChange]);

    useImperativeHandle(
      ref,
      () => ({
        submit,
        clear: () => clearRef.current?.clear(),
        focus: () => {
          // ContentEditable focus
          contentRef.current?.focus();
        },
        setText: (text: string) => {
          clearRef.current?.setText(text);
          // `onTextChange` fires from the OnChangePlugin as a result of the
          // update above, so Send enables itself — nothing to notify here.
          contentRef.current?.focus();
        },
      }),
      [submit],
    );

    const initialConfig = {
      namespace: 'ai-chat-input',
      onError: (error: Error) => {
        console.error('Lexical error:', error);
      },
      nodes: [MentionNode],
      editable: !disabled,
      theme: {
        paragraph: 'lexical-paragraph',
      },
    };

    return (
      <div className="lexical-chat-input">
        <LexicalComposer initialConfig={initialConfig}>
          <PlainTextPlugin
            contentEditable={
              <ContentEditable
                className="lexical-chat-input-content"
                aria-placeholder={placeholder}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                data-gramm={false}
                data-gramm_editor={false}
                data-enable-grammarly={false}
                placeholder={
                  <div className="lexical-chat-input-placeholder">{placeholder}</div>
                }
                ref={contentRef}
              />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <OnChangePlugin onChange={handleChange} />
          <EnterToSendPlugin onSend={submit} enabled={!disabled && hasText} />
          <ClearOnSendPlugin ref={clearRef} />
          <MentionTriggerPlugin />
          <PasteImagePlugin />
          <DropImagePlugin />
        </LexicalComposer>
      </div>
    );
  },
);

export default LexicalChatInput;
