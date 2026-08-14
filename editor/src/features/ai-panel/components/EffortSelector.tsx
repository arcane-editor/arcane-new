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
import { useCommandsStore } from '../../../stores/commands';
import { isMac } from '../../../utils/platform';
import { effortChordLabel } from '../data/effort-chord';
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
          return (
            <button
              key={idx}
              type="button"
              role="radio"
              aria-checked={effort === lvl.value}
              className={`ai-panel-effort-bar ai-panel-effort-bar--${idx} ${
                isActive ? 'is-active' : ''
              }`}
              onClick={() => setEffort(lvl.value)}
              disabled={isAgentRunning}
              // No `title`: these bars carried a native tooltip each, plus one
              // on the group, and hovering the toolbar flashed them constantly.
              // `aria-label` keeps the bars named for screen readers — with the
              // tooltip gone it is their only accessible name, since the button
              // itself has no text.
              aria-label={`${lvl.label} reasoning`}
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
