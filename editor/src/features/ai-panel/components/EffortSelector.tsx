/**
 * EffortSelector — reasoning effort as a MODE, not a meter.
 *
 * One pill, coloured by level, that cycles on click: Standard (green) → Deep
 * Think (amber) → Max (rose) → Standard. `ai.effortCycle` (mod+d, App.tsx)
 * does the same thing from the keyboard.
 *
 * It used to be three ascending bars, EQ-style, with the active level lighting
 * up that bar and all before it. That framing was the bug: a 1-of-3 filled
 * meter says "you are on the weak setting", so the DEFAULT — the right choice
 * for most work — read as a deficient one. A mode has a name and an identity
 * colour; it does not have a fill level.
 *
 * No caret, because there is no menu: three values cycle faster than a popover
 * opens, and the toolbar already carries bare pills (Fast mode) alongside
 * pills that do open menus (the mode pill), so the absence of a caret is
 * itself the signal.
 *
 * Colour is never the only carrier — the label always names the level, which
 * is what a screen reader and a colour-blind user read.
 */

import { useAiStore } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { useServerConfigStore, allowedEfforts } from '../../../stores/server-config';
import Tooltip from '../../../components/Tooltip';
import { cycleEffort, effortLockMessage } from '../data/effort';
import type { Effort } from '../services/types';

// Standard is first because it is the default: the server gates `mid`/`high`
// behind paid plans, so a Free user who lands anywhere else is 403'd on their
// first message.
const LEVELS: { value: Effort; label: string; description: string }[] = [
  { value: 'low', label: 'Standard', description: 'Standard reasoning — the right choice for most work.' },
  { value: 'mid', label: 'Deep Think', description: 'Deep Think — more reasoning per turn, slower and costlier.' },
  { value: 'high', label: 'Max', description: 'Max — the most reasoning this plan allows.' },
];

function EffortSelector() {
  const effort = useAiStore((s) => s.effort);
  const setEffort = useAiStore((s) => s.setEffort);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  // Fail-closed by construction: `allowedEfforts` degrades to a plan-ceiling
  // fallback (and that ceiling defaults to 'low') the instant `plan` or
  // `config` is anything other than a currently-known paid tier — signed-out,
  // plan-unknown, and config-unknown all land there. See its STALE-CONFIG
  // GUARD doc in stores/server-config.ts.
  const config = useServerConfigStore((s) => s.config);
  const plan = useAuthStore((s) => s.plan);
  const allowed = allowedEfforts(config, plan);

  const active = LEVELS.find((l) => l.value === effort) ?? LEVELS[0];
  // Nothing to cycle TO — a Free account has one level, so the pill states the
  // level and explains the lock instead of pretending to be a control.
  const locked = allowed.length <= 1;
  const next = LEVELS.find((l) => l.value === cycleEffort(effort, allowed));

  const label = locked
    ? effortLockMessage('mid')
    : `${active.description} Click to switch to ${next?.label ?? 'the next level'}.`;

  return (
    <Tooltip label={label} commandId={locked ? undefined : 'ai.effortCycle'} side="top">
      <button
        type="button"
        className="ai-panel-effort"
        data-effort={active.value}
        onClick={locked ? undefined : () => setEffort(cycleEffort(effort, allowed))}
        disabled={isAgentRunning || locked}
        // Permanent, non-visual counterpart to the chord in the tooltip —
        // the same pairing ModeSelector uses.
        aria-keyshortcuts="Meta+D"
        aria-label={`Reasoning effort: ${active.label}${locked ? '' : '. Activate to cycle.'}`}
      >
        <span className="ai-panel-effort-dot" aria-hidden="true" />
        <span className="ai-panel-effort-label">{active.label}</span>
      </button>
    </Tooltip>
  );
}

export default EffortSelector;
