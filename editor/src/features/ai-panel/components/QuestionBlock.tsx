/**
 * QuestionBlock — inline UI for a pending `ask_user` question, rendered in
 * the message list. Visual/structural sibling of `PermissionRequestBlock`
 * (icon header + body + action row, same CSS discipline), but shaped for
 * free-form/multi-select answers instead of fixed permission options:
 *
 *  - No `options`: the question is answered by typing into the card's own
 *    answer row (below), or into ChatInput's answer mode.
 *  - `options`, single-select: clicking a chip resolves immediately.
 *  - `options` carrying descriptions or previews (external agents' structured
 *    questions): the same options rendered as stacked cards instead, since the
 *    explanation is the point of asking.
 *  - `options`, `allowMultiple`: chips toggle a local selected-set; an
 *    "Answer" button (disabled while nothing is selected) submits the
 *    comma-joined labels.
 *
 * THE ANSWER ROW IS PART OF THE CARD, not just the composer. Every question
 * takes free text — the agents' own schemas carry an "Other" slot for it
 * (`acp-elicitation.ts`'s `encodeAnswer`) — and this used to be reachable only
 * through the composer at the bottom of the panel, advertised by a one-line
 * hint. That indirection failed outright whenever the composer's answer mode
 * did not arm (see `pending-question.ts`), leaving a question that invited a
 * typed answer and accepted none. The row here resolves through the same store
 * action the chips do, reading the card's own message, so it cannot be
 * defeated by anything happening in the composer. Composer answer mode stays
 * as the second path for someone already typing down there.
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
import { ArrowUp, CheckSquare, MessageCircleQuestion, Square } from 'lucide-react';
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
  // Hooks called unconditionally, ahead of the `!req` early return below, so
  // these never become conditional hook calls across renders.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState('');

  if (!req) return null;

  const resolved = req.resolvedAnswer !== undefined;
  const cancelled = !!req.cancelled;
  const locked = resolved || cancelled;
  const chosenLabels = resolved ? splitAnswerLabels(req.resolvedAnswer!) : selected;

  // Layout follows the content. Bare labels stay a row of chips — compact, and
  // what the UnityIDE agent's questions look like. Options that carry an
  // explanation or a preview get a stacked card each, because a choice whose
  // reasoning is hidden in a tooltip is a choice made blind.
  const detailed = !!req.options?.some((o) => o.description || o.preview);
  const hasOptions = !!req.options && req.options.length > 0;

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

  function submitDraft() {
    const answer = draft.trim();
    if (!answer) return;
    setDraft('');
    resolveWith(answer);
  }

  return (
    <div className={`ai-question-block ${cancelled ? 'is-cancelled' : ''}`}>
      <div className="ai-question-block-header">
        <MessageCircleQuestion size={12} strokeWidth={2} />
        <span className="ai-question-block-text">{req.question}</span>
      </div>

      {hasOptions && (
        <div className={detailed ? 'ai-question-block-cards' : 'ai-question-block-options'}>
          {req.options!.map((opt) => {
            const isChosen = chosenLabels.has(opt.label);
            const className = `${detailed ? 'ai-question-block-card' : 'ai-question-block-chip'} ${
              isChosen ? 'is-selected' : ''
            } ${locked ? 'is-locked' : ''}`;
            return (
              <button
                key={opt.label}
                type="button"
                className={className}
                // A card shows its description, so a tooltip would only repeat it.
                title={detailed ? undefined : opt.description}
                disabled={locked}
                onClick={() => pick(opt.label)}
              >
                {detailed ? (
                  <>
                    <span className="ai-question-block-card-label">
                      {req.allowMultiple && (
                        <span className="ai-question-block-card-mark" aria-hidden>
                          {isChosen ? <CheckSquare size={12} /> : <Square size={12} />}
                        </span>
                      )}
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span className="ai-question-block-card-desc">{opt.description}</span>
                    )}
                    {opt.preview && (
                      <pre className="ai-question-block-card-preview">{opt.preview}</pre>
                    )}
                  </>
                ) : (
                  opt.label
                )}
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

      {!locked && (
        <div className="ai-question-block-answer">
          <input
            type="text"
            className="ai-question-block-answer-input"
            // With options above, this is the escape hatch from them; without
            // any, it is the whole question. The placeholder says which.
            placeholder={hasOptions ? 'Or type your own answer…' : 'Type your answer…'}
            aria-label="Type your answer"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // preventDefault only, deliberately no stopPropagation: React
              // listens on #root, BELOW the document listener the app's
              // hotkeys use, so stopping propagation here would swallow every
              // app chord for as long as this input holds focus (see the
              // editor's CLAUDE.md). Nothing binds a bare Enter globally.
              e.preventDefault();
              submitDraft();
            }}
          />
          <button
            type="button"
            className="ai-question-block-answer-send"
            disabled={draft.trim().length === 0}
            onClick={submitDraft}
            title="Send answer"
            aria-label="Send answer"
          >
            <ArrowUp size={13} strokeWidth={2.5} />
          </button>
        </div>
      )}

      {resolved && <div className="ai-question-block-footer">Answered: {req.resolvedAnswer}</div>}
      {cancelled && <div className="ai-question-block-footer">Cancelled</div>}
    </div>
  );
}

export default QuestionBlock;
