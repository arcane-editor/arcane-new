/**
 * EffortSelector — three ascending bars (Standard / Deep Think / Max) rendered
 * like an EQ / signal-strength indicator. Active level lights up that bar plus
 * all preceding bars. Each bar is independently clickable.
 *
 * Why bars rather than a segmented control?  The user wanted a "graph-style"
 * effort indicator that visually conveys the increasing intensity of the
 * steps. Bars with increasing heights match that intent and compress nicely
 * into the toolbar. The level is sent to the server as `reasoningLevel`; the
 * backend maps it to a concrete model.
 *
 * The bars are not the only way to set it: `ai.effortUp` / `ai.effortDown`
 * (mod+right / mod+left, App.tsx) step the same scale from the composer.
 */

import { useAiStore } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { useServerConfigStore, allowedEfforts } from '../../../stores/server-config';
import { useCommandsStore } from '../../../stores/commands';
import { isMac } from '../../../utils/platform';
import { effortChordLabel } from '../data/effort-chord';
import { effortLockMessage } from '../data/effort';
import type { Effort } from '../services/types';

// Standard is first because it is the default: the server gates `mid`/`high`
// behind paid plans, so a Free user who lands anywhere else is 403'd on their
// first message.
const LEVELS: { value: Effort; label: string; bars: number }[] = [
  { value: 'low', label: 'Standard', bars: 1 },
  { value: 'mid', label: 'Deep Think', bars: 2 },
  { value: 'high', label: 'Max', bars: 3 },
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

  const activeLevel = LEVELS.find((l) => l.value === effort) ?? LEVELS[0];
  const activeBars = activeLevel.bars;

  // Select the Map itself, never a value derived from it — a selector that
  // builds a fresh identity per call never compares equal under Zustand v5 and
  // re-renders forever (see the note on `selectCommands` in Tooltip.tsx).
  const commands = useCommandsStore((s) => s.commands);
  const chord = effortChordLabel(
    commands.get('ai.effortDown')?.keybinding,
    commands.get('ai.effortUp')?.keybinding,
    isMac(),
  );

  return (
    // `aria-keyshortcuts` is the permanent half of surfacing these chords: it
    // costs nothing visually and is always true, while the ChordHint keycap in
    // the toolbar is the transient visual half. Meta+ArrowLeft/Right is the
    // spelling ARIA expects, not the glyphs shown on screen.
    <div
      className="ai-panel-effort"
      role="radiogroup"
      aria-label="Reasoning effort"
      aria-keyshortcuts="Meta+ArrowLeft Meta+ArrowRight"
    >
      <div className="ai-panel-effort-bars">
        {[1, 2, 3].map((idx) => {
          const lvl = LEVELS.find((l) => l.bars === idx)!;
          const isActive = idx <= activeBars;
          const locked = !allowed.includes(lvl.value);
          const lockMessage = locked ? effortLockMessage(lvl.value) : null;
          return (
            <button
              key={idx}
              type="button"
              role="radio"
              aria-checked={effort === lvl.value}
              aria-disabled={locked || undefined}
              className={`ai-panel-effort-bar ai-panel-effort-bar--${idx} ${
                isActive ? 'is-active' : ''
              }`}
              // Locked bars get NO click handler at all — not just a disabled
              // attribute — so a stray click can never race a re-render that
              // briefly clears `disabled`.
              onClick={locked ? undefined : () => setEffort(lvl.value)}
              disabled={isAgentRunning || locked}
              // No `title` on an UNLOCKED bar: these carried a native tooltip
              // each, plus one on the group, and hovering the toolbar flashed
              // them constantly. A locked bar is the exception — it needs to
              // explain WHY it's locked, so it gets a `title` (TooltipHost
              // upgrades it to the styled tooltip on hover) alongside the
              // `aria-label` screen readers rely on either way, since the
              // button itself has no text.
              title={lockMessage || undefined}
              aria-label={lockMessage || `${lvl.label} reasoning`}
            />
          );
        })}
      </div>
      <span className="ai-panel-effort-label">{activeLevel.label}</span>
      {/* Permanent, so it is set as quietly as it can be and still be read.
          Absent entirely when the bindings no longer compress to one cap. */}
      {chord && <kbd className="ai-panel-effort-chord">{chord}</kbd>}
    </div>
  );
}

export default EffortSelector;
