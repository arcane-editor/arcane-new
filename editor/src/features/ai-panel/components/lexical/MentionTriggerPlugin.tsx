/**
 * MentionTriggerPlugin — detects an `@` trigger in the editor and pops the
 * unified Files + Unity Docs picker. On pick, replaces the `@query` text
 * with a MentionNode chip and adds the corresponding attachment to the AI
 * store.
 *
 * Detection is run on every editor update by reading the text immediately
 * before the caret — this avoids capturing keystrokes and works for paste,
 * delete, and arrow-key navigation alike.
 */

import { useCallback, useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  KEY_ESCAPE_COMMAND,
  type RangeSelection,
} from 'lexical';
import MentionPopover, { type MentionPick } from '../MentionPopover';
import { $createMentionNode } from './MentionNode';
import { useAiStore } from '../../../../stores/ai';
import type { Attachment } from '../../services/types';

interface TriggerState {
  query: string;
  /** Caret rect in viewport coords, used to anchor the popover. */
  anchorRect: DOMRect;
}

function MentionTriggerPlugin() {
  const [editor] = useLexicalComposerContext();
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const addAttachment = useAiStore((s) => s.addAttachment);

  /** Look at the text immediately before the caret. If it matches `@<word>`
   *  (with `@` not preceded by an identifier character), return the query.
   *  Returns null otherwise. */
  const detectTrigger = useCallback(() => {
    type Detected = { query: string; rect: DOMRect };
    let result: Detected | null = null;

    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;

      const anchor = selection.anchor;
      const node = anchor.getNode();
      if (!$isTextNode(node)) return;

      const text = node.getTextContent();
      const offset = anchor.offset;
      const before = text.slice(0, offset);

      // Match @ at end-of-text, or @ following a non-identifier character.
      // The match captures everything from the last `@` to the caret.
      const m =
        before.match(/(?:^|[\s.,;:!?(){}[\]"'`])(@[^\s@]*)$/) ??
        before.match(/^(@[^\s@]*)$/);
      if (!m) return;
      const captured = m[1] ?? '';
      const query = captured.slice(1); // drop the @

      const domSelection = window.getSelection();
      if (!domSelection || domSelection.rangeCount === 0) return;
      const range = domSelection.getRangeAt(0).cloneRange();
      result = { query, rect: range.getBoundingClientRect() };
    });

    const r = result as Detected | null;
    if (r) {
      setTrigger({ query: r.query, anchorRect: r.rect });
    } else if (trigger !== null) {
      setTrigger(null);
    }
  }, [editor, trigger]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      // Defer to next microtask so the DOM caret position has settled before
      // we read getBoundingClientRect.
      void editorState;
      queueMicrotask(detectTrigger);
    });
  }, [editor, detectTrigger]);

  // Esc closes the popover but doesn't blur the editor.
  useEffect(() => {
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        if (trigger) {
          setTrigger(null);
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
  }, [editor, trigger]);

  const handlePick = useCallback(
    (pick: MentionPick) => {
      // Build the attachment + insert a MentionNode in place of `@<query>`.
      const attachmentId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let attachment: Attachment;
      let label: string;
      switch (pick.kind) {
        case 'file':
          // Shape is pinned to the drop path's `buildFileAttachment` by the
          // `Attachment` union itself; the picker already knows `relPath` and
          // `bytes`, so it fills them directly rather than re-deriving.
          attachment = {
            kind: 'file',
            id: attachmentId,
            path: pick.path,
            relPath: pick.relPath,
            bytes: pick.bytes ?? 0,
          };
          label = pick.relPath.split('/').pop() ?? pick.relPath;
          break;
        case 'unity-doc':
          attachment = {
            kind: 'unity-doc',
            id: attachmentId,
            name: pick.name,
            url: pick.url,
            category: pick.category,
          };
          label = pick.name;
          break;
        case 'unity-context':
          attachment = { kind: 'unity-context', id: attachmentId, verb: pick.verb };
          label = pick.verb;
          break;
        case 'unity-object':
          attachment = {
            kind: 'unity-object',
            id: attachmentId,
            name: pick.name,
            instanceId: pick.instanceId,
          };
          label = pick.name;
          break;
        case 'unity-asset':
          attachment = {
            kind: 'unity-asset',
            id: attachmentId,
            guid: pick.guid,
            path: pick.path,
            relPath: pick.relPath,
          };
          label = pick.relPath.split('/').pop() ?? pick.relPath;
          break;
      }

      addAttachment(attachment);

      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;
        const anchor = selection.anchor;
        const node = anchor.getNode();
        if (!$isTextNode(node)) return;

        const text = node.getTextContent();
        const offset = anchor.offset;
        const atIdx = text.lastIndexOf('@', offset - 1);
        if (atIdx < 0) return;

        // Select the `@<query>` range, then replace.
        const sel = selection as RangeSelection;
        sel.anchor.set(node.getKey(), atIdx, 'text');
        sel.focus.set(node.getKey(), offset, 'text');
        sel.removeText();

        const mention = $createMentionNode({
          kind: pick.kind,
          attachmentId,
          label,
        });
        sel.insertNodes([mention]);
        sel.insertText(' ');
      });

      setTrigger(null);
    },
    [editor, addAttachment],
  );

  return (
    <MentionPopover
      open={trigger !== null}
      query={trigger?.query ?? ''}
      anchorRect={trigger?.anchorRect ?? null}
      onPick={handlePick}
      onClose={() => setTrigger(null)}
    />
  );
}

export default MentionTriggerPlugin;
