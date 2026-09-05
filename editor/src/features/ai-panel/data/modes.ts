/**
 * The chat modes, as data.
 *
 * Lifted out of `ModeSelector` so the composer pill and the empty state
 * describe a mode with the same words. They are the same claim about what
 * pressing Enter will do, and two copies would drift — the whole reason mode
 * identity got attention in the first place was people sending an edit request
 * believing they were in Ask.
 */

import { Infinity as InfinityIcon, ListChecks, MessageSquare, PenLine } from 'lucide-react';
import type { ChatMode } from '../services/types';

export interface ModeOption {
  value: ChatMode;
  label: string;
  description: string;
  Icon: typeof MessageSquare;
}

/**
 * Menu order. `ModeSelector` falls back to `MODES[1]` (agent, the default
 * mode) when the stored value matches nothing, so this order is load-bearing —
 * see `MODE_LADDER` for the empty state's ordering instead of resequencing it.
 */
export const MODES: ModeOption[] = [
  {
    value: 'ask',
    label: 'Ask',
    description: 'Read-only conversation. No file edits.',
    Icon: MessageSquare,
  },
  {
    value: 'agent',
    label: 'Agent',
    description: 'AI can edit files and run commands.',
    Icon: InfinityIcon,
  },
  {
    value: 'plan',
    label: 'Plan',
    description: 'Plan first, then execute step by step.',
    Icon: ListChecks,
  },
];

/**
 * The same three modes ordered by how much they are allowed to touch: Ask
 * reads, Plan proposes, Agent writes.
 *
 * The order is the point. Listed this way the column answers "how much rope
 * does this have?" top to bottom, which is the question behind picking a mode
 * at all — menu order (above) is arbitrary by comparison and can't carry it.
 */
export const MODE_LADDER: ModeOption[] = ['ask', 'plan', 'agent'].map(
  (value) => MODES.find((m) => m.value === value)!,
);

/**
 * Design mode, which is deliberately NOT in `MODES` and not rendered by the
 * sidebar at all.
 *
 * It is entered from the design dock on an open `.uxml` and is meaningless
 * without one, so offering it in a menu that can be opened with nothing on the
 * canvas would be offering a mode that immediately refuses to do anything.
 * It keeps a descriptor because it is a real `ChatMode` that the empty state
 * still owes starters for — see `modeOptionFor` for why the sidebar shows
 * Agent in its place instead.
 */
export const DESIGN_MODE: ModeOption = {
  value: 'design',
  label: 'Design',
  description: 'Reshaping the .uxml open on the canvas. Pick another mode to leave it.',
  Icon: PenLine,
};

/**
 * The descriptor the SIDEBAR renders for a mode.
 *
 * Design deliberately resolves to Agent here rather than to `DESIGN_MODE`: the
 * design chat is the canvas dock's, and the sidebar's mode control has no
 * business advertising a mode it cannot enter and the user did not choose
 * there. `ChatInput` keeps that honest by actually leaving design mode when you
 * send from the sidebar, so the pill is never a claim the next send disproves.
 */
export function modeOptionFor(mode: ChatMode): ModeOption {
  return MODES.find((m) => m.value === mode) ?? MODES[1];
}
