/**
 * The three chat modes, as data.
 *
 * Lifted out of `ModeSelector` so the composer pill and the empty state
 * describe a mode with the same words. They are the same claim about what
 * pressing Enter will do, and two copies would drift — the whole reason mode
 * identity got attention in the first place was people sending an edit request
 * believing they were in Ask.
 */

import { Infinity as InfinityIcon, ListChecks, MessageSquare } from 'lucide-react';
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
