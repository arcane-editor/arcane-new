/**
 * SlashTriggerPlugin — detects a leading `/` command in the composer and shows
 * the SlashCommandPopover with the connected external agent's advertised
 * commands. Inert for the Arcane agent, which has no slash commands. The text
 * sends as an ordinary prompt (the agent interprets it), so picking just
 * rewrites the editor to `/<name> `.
 *
 * Trigger fires only when the whole composer content is `/<word>` — i.e. a
 * command at the start of the message — to avoid false positives mid-text.
 */

import { useCallback, useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  $createTextNode,
  COMMAND_PRIORITY_LOW,
  KEY_ESCAPE_COMMAND,
} from 'lexical';
import SlashCommandPopover from '../SlashCommandPopover';
import { useAiStore } from '../../../../stores/ai';

interface TriggerState {
  query: string;
  anchorRect: DOMRect;
}

function SlashTriggerPlugin() {
  const [editor] = useLexicalComposerContext();
  const selectedAgent = useAiStore((s) => s.selectedAgent);
  const commands = useAiStore((s) => s.agentAvailableCommands);
  const [trigger, setTrigger] = useState<TriggerState | null>(null);

  const detect = useCallback(() => {
    if (selectedAgent === 'arcane' || commands.length === 0) {
      setTrigger((t) => (t ? null : t));
      return;
    }
    let res: TriggerState | null = null;
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return;
      const full = $getRoot().getTextContent();
      const m = full.match(/^\/(\w*)$/);
      if (!m) return;
      const dom = window.getSelection();
      if (!dom || dom.rangeCount === 0) return;
      const rect = dom.getRangeAt(0).cloneRange().getBoundingClientRect();
      res = { query: m[1], anchorRect: rect };
    });
    if (res) setTrigger(res);
    else setTrigger((t) => (t ? null : t));
  }, [editor, selectedAgent, commands.length]);

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      queueMicrotask(detect);
    });
  }, [editor, detect]);

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
    (name: string) => {
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();
        p.append($createTextNode(`/${name} `));
        root.append(p);
        p.selectEnd();
      });
      setTrigger(null);
    },
    [editor],
  );

  return (
    <SlashCommandPopover
      open={trigger !== null}
      query={trigger?.query ?? ''}
      anchorRect={trigger?.anchorRect ?? null}
      commands={commands}
      onPick={handlePick}
      onClose={() => setTrigger(null)}
    />
  );
}

export default SlashTriggerPlugin;
