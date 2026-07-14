/**
 * QuestionBlock — inline UI for a pending `ask_user` question, rendered in
 * the message list. Visual/structural sibling of `PermissionRequestBlock`
 * (icon header + body + action row, same CSS discipline), but shaped for
 * free-form/multi-select answers instead of fixed permission options:
 *
 *  - No `options`: chip-less card — the question is answered only via
 *    ChatInput's answer mode (typing in the composer).
 *  - `options`, single-select: clicking a chip resolves immediately.
 *  - `options`, `allowMultiple`: chips toggle a local selected-set; an
 *    "Answer" button (disabled while nothing is selected) submits the
 *    comma-joined labels.
 *
 * Resolution ALWAYS goes through `useAiStore.getState().resolveQuestionRequest`
 * — this component never touches `question-gate.ts` directly, mirroring how
 * `PermissionRequestBlock` only ever calls `resolvePendingApproval` (never
 * reaches into `approval-gate.ts`'s internals).
 *
 * Locked states (mutually exclusive): `resolvedAnswer` set → chips locked,
 * chosen ones highlighted, footer `Answered: <resolvedAnswer>`; `cancelled`
 * → dimmed card, footer `Cancelled` (set by `question-gate.ts`'s abort path
 * or by `loadSessionIntoStore`'s restore-time sweep for a question that was
 * still pending when the app quit).
 */

import { useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { useAiStore, type AiMessage } from '../../../stores/ai';

interface Props {
  message: AiMessage;
}

/** Split a resolved comma-joined multi-select answer back into labels, for chip highlighting. */
function splitAnswerLabels(answer: string): Set<string> {
  return new Set(
    answer
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function QuestionBlock({ message }: Props) {
  const req = message.questionRequest;
  // Hook called unconditionally, ahead of the `!req` early return below, so
  // this never becomes a conditional hook call across renders.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  if (!req) return null;

  const resolved = req.resolvedAnswer !== undefined;
  const cancelled = !!req.cancelled;
  const locked = resolved || cancelled;
  const chosenLabels = resolved ? splitAnswerLabels(req.resolvedAnswer!) : selected;

  function resolveWith(answer: string) {
    if (locked) return;
    useAiStore.getState().resolveQuestionRequest(req!.toolCallId, { answer });
  }

  function toggleOption(label: string) {
    if (locked) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function submitMultiSelect() {
    if (locked || selected.size === 0) return;
    resolveWith(Array.from(selected).join(', '));
  }

  function pick(label: string) {
    if (req!.allowMultiple) toggleOption(label);
    else resolveWith(label);
  }

  return (
    <div className={`ai-question-block ${cancelled ? 'is-cancelled' : ''}`}>
      <div className="ai-question-block-header">
        <MessageCircleQuestion size={12} strokeWidth={2} />
        <span className="ai-question-block-text">{req.question}</span>
      </div>

      {req.options && req.options.length > 0 && (
        <div className="ai-question-block-options">
          {req.options.map((opt) => {
            const isChosen = chosenLabels.has(opt.label);
            return (
              <button
                key={opt.label}
                type="button"
                className={`ai-question-block-chip ${isChosen ? 'is-selected' : ''} ${
                  locked ? 'is-locked' : ''
                }`}
                title={opt.description}
                disabled={locked}
                onClick={() => pick(opt.label)}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}

      {req.allowMultiple && !locked && (
        <div className="ai-question-block-actions">
          <button
            type="button"
            className="ai-question-block-answer-btn"
            disabled={selected.size === 0}
            onClick={submitMultiSelect}
          >
            Answer
          </button>
        </div>
      )}

      {!locked && <div className="ai-question-block-hint">…or type your answer below</div>}

      {resolved && <div className="ai-question-block-footer">Answered: {req.resolvedAnswer}</div>}
      {cancelled && <div className="ai-question-block-footer">Cancelled</div>}
    </div>
  );
}

export default QuestionBlock;
