/**
 * EffortSelector — four ascending bars (Low / Mid / High / Extra High) rendered
 * like an EQ / signal-strength indicator. Active level lights up that bar plus
 * all preceding bars. Each bar is independently clickable.
 *
 * Why bars rather than a segmented control?  The user wanted a "graph-style"
 * effort indicator that visually conveys the increasing intensity of the
 * steps. Bars with increasing heights match that intent and compress nicely
 * into the toolbar. The level is sent to the server as `reasoningLevel`; the
 * backend maps it to a concrete model.
 */

import { useAiStore } from '../../../stores/ai';
import type { Effort } from '../services/types';

const LEVELS: { value: Effort; label: string; title: string; bars: number }[] = [
  { value: 'low', label: 'Low', title: 'Fast, cheap. Best for simple Q&A or quick edits.', bars: 1 },
  { value: 'mid', label: 'Mid', title: 'Balanced. Good default for most tasks.', bars: 2 },
  { value: 'high', label: 'High', title: 'Slower, deeper reasoning. Best for plans and complex changes.', bars: 3 },
  { value: 'super', label: 'Extra High', title: 'Maximum reasoning depth. Best for the hardest changes.', bars: 4 },
];

function EffortSelector() {
  const effort = useAiStore((s) => s.effort);
  const setEffort = useAiStore((s) => s.setEffort);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);

  const activeLevel = LEVELS.find((l) => l.value === effort) ?? LEVELS[1];
  const activeBars = activeLevel.bars;

  return (
    <div
      className="ai-panel-effort"
      role="radiogroup"
      aria-label="Reasoning effort"
      title={`${activeLevel.label} reasoning — ${activeLevel.title}`}
    >
      <div className="ai-panel-effort-bars">
        {[1, 2, 3, 4].map((idx) => {
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
              title={`${lvl.label} — ${lvl.title}`}
            />
          );
        })}
      </div>
      <span className="ai-panel-effort-label">{activeLevel.label}</span>
    </div>
  );
}

export default EffortSelector;
