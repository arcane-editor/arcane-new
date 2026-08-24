import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, MessageSquarePlus, Play, Square, X } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import MarkdownPreview from './MarkdownPreview';
import { reanchorNotes, type PlanNote } from '../services/note-anchor';
import { replaceBlock, toggleTaskAt } from '../services/block-edit';
import { parsePlanDocument, type PlanStepBlock } from '../services/plan-document';

interface PlanDocumentViewProps {
  path: string;
  content: string;
  notes: PlanNote[];
  onNotesChange: (notes: PlanNote[]) => void;
  onRevise: () => void;
  onExecute: () => void;
  onStop: () => void;
}

/**
 * An `.aplan` file rendered as a working document.
 *
 * The shape of this view comes from one observation about plan files: every
 * todo already has a matching Guide entry, and rendering the file as prose put
 * them in two different places — a checklist near the top, its detail hundreds
 * of lines below, joined only by a `T3` the reader had to track by eye. So a
 * step and its guide are ONE thing here, threaded on a spine that fills as
 * execution proceeds. The plan is the progress bar; there is no second one.
 *
 * Three things it is deliberately not:
 *
 * - **Not a source editor.** There is no Preview/Source toggle and no Monaco.
 *   Every part of the document is edited where it is rendered, Notion-style:
 *   click a step title, a paragraph, a bullet, and you are editing the
 *   markdown that produced it. `parsePlanDocument` hands back offsets rather
 *   than copies precisely so that this can write back to the real file.
 * - **Not a place to see bookkeeping.** The `T<n>` ids and `[easy]`/`[hard]`
 *   tags stay in the file — the executor routes models on them — and never
 *   reach the screen. Step numbers come from position instead, so they stay
 *   right when the user deletes a step.
 * - **Not read-only while it works.** Steps tick themselves off as execution
 *   proceeds, and the running step is the one that is open.
 */
function PlanDocumentView({
  path,
  content,
  notes,
  onNotesChange,
  onRevise,
  onExecute,
  onStop,
}: PlanDocumentViewProps) {
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  const planPhase = useAiStore((s) => s.planPhase);
  const arcanePlan = useAiStore((s) => s.arcanePlan);
  const effort = useAiStore((s) => s.effort);
  const setEffort = useAiStore((s) => s.setEffort);

  const executing = planPhase === 'executing';
  const editable = !executing;

  const doc = useMemo(() => parsePlanDocument(content), [content]);

  // Step state comes from the FILE — plan-execution.ts rewrites `- [ ]` to
  // `- [x]` as it finishes each one — while the RUNNING step comes from the
  // live todo list. Neither alone is enough: the file knows what finished, the
  // todo list knows what is happening right now.
  const runningTitle = useMemo(
    () => arcanePlan?.find((e) => e.status === 'in_progress')?.text ?? null,
    [arcanePlan],
  );
  const runningIndex = runningTitle
    ? doc.steps.findIndex((s) => !s.done && looselyMatches(s.title, runningTitle))
    : -1;

  const doneCount = doc.steps.filter((s) => s.done).length;
  const total = doc.steps.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  // Only the parent sees every slice, so re-anchoring notes is its job here
  // (MarkdownPreview skips it in slice mode — see its `slice` prop).
  useEffect(() => {
    const next = reanchorNotes(notes, content);
    const changed = next.some(
      (n, i) => n.anchored !== notes[i]?.anchored || n.headingPath !== notes[i]?.headingPath,
    );
    if (changed) onNotesChange(next);
    // Keyed on `content` alone: re-running on `notes` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // Block edits commit straight to disk as one atomic update-then-save, so the
  // tab never LINGERS dirty — which keeps both the Execute dirty-guard and the
  // fs-watcher's live tick-off refresh (skipIfDirty) working.
  const write = useCallback(
    (next: string) => {
      if (next === content) return;
      const ws = useWorkspaceStore.getState();
      ws.updateFileContent(path, next);
      void ws.saveFile(path);
    },
    [content, path],
  );

  // Identity matters here: these are memo keys inside every nested preview, and
  // a plan renders one preview per step. Re-creating them each render would
  // re-parse the whole document every time a todo ticks over during execution.
  const commitBlockEdit = useCallback(
    (start: number, end: number, newText: string) => write(replaceBlock(content, start, end, newText)),
    [content, write],
  );

  const toggleTask = useCallback(
    (offset: number) => {
      const next = toggleTaskAt(content, offset);
      if (next != null) write(next);
    },
    [content, write],
  );

  const sliceProps = (start: number, end: number) => ({
    content: content.slice(start, end),
    slice: { base: start, document: content },
    notes,
    onNotesChange,
    editable,
    onCommitBlockEdit: commitBlockEdit,
    onToggleTask: toggleTask,
  });

  return (
    <div className="plan-doc">
      <header className="plan-doc-bar">
        <span className={`plan-doc-status${executing ? ' is-running' : ''}`}>
          <span className="plan-doc-status-dot" aria-hidden="true" />
          {executing ? 'Executing' : 'Plan'}
        </span>
        {total > 0 && (
          <span className="plan-doc-count">
            {doneCount} of {total}
          </span>
        )}

        <div className="plan-doc-actions">
          {/* The count lives on the button it gates rather than beside it: the
              suggestions panel further down already labels the list, and two
              counts for one number is one too many. */}
          <button
            type="button"
            className="plan-doc-btn"
            onClick={onRevise}
            disabled={notes.length === 0 || isAgentRunning}
            title={
              notes.length === 0
                ? 'Select text anywhere in the plan to suggest a change first'
                : `Send ${notes.length} suggestion${notes.length === 1 ? '' : 's'} and rewrite the plan`
            }
          >
            Revise
            {notes.length > 0 && <span className="plan-doc-btn-count">{notes.length}</span>}
          </button>
          {executing ? (
            <button type="button" className="plan-doc-btn plan-doc-btn--stop" onClick={onStop}>
              <Square size={11} />
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="plan-doc-btn plan-doc-btn--primary"
              onClick={onExecute}
              disabled={isAgentRunning}
            >
              <Play size={11} />
              Execute
            </button>
          )}
          {/* Effort is adjustable mid-plan; the model tier follows it. There is
              no Pause: agent-loop.ts only checks an abort signal at its loop
              boundaries and has no suspension point, so a Pause button would be
              a relabelled Stop. */}
          <select
            className="plan-doc-effort"
            aria-label="Reasoning effort"
            value={effort}
            onChange={(e) => setEffort(e.target.value as typeof effort)}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        {/* The bar's own bottom edge is the progress rule — a plan that shows
            its steps ticking off does not also need a bar to say so. */}
        <div className="plan-doc-rule" style={{ transform: `scaleX(${pct / 100})` }} />
      </header>

      <div className="plan-doc-scroll">
        <div className="plan-doc-page">
          {doc.blocks.map((block, i) =>
            block.kind === 'markdown' ? (
              <MarkdownPreview key={`md-${block.range.start}-${i}`} {...sliceProps(block.range.start, block.range.end)} />
            ) : (
              <ol className="plan-spine" key={`steps-${i}`}>
                {block.steps.map((step) => (
                  <PlanStepCard
                    key={step.ordinal}
                    step={step}
                    state={step.done ? 'done' : step.ordinal - 1 === runningIndex ? 'running' : 'pending'}
                    executing={executing}
                    document={content}
                    onToggle={() => toggleTask(step.checkboxOffset)}
                    onRename={(text) =>
                      commitBlockEdit(step.titleRange.start, step.titleRange.end, text)
                    }
                    guideProps={step.guide ? sliceProps(step.guide.start, step.guide.end) : null}
                  />
                ))}
              </ol>
            ),
          )}

          {notes.length > 0 ? (
            <div className="md-notes">
              <div className="md-notes-title">
                {notes.length} suggestion{notes.length === 1 ? '' : 's'}
              </div>
              {notes.map((n) => (
                <div key={n.id} className={`md-note${n.anchored ? '' : ' md-note--orphan'}`}>
                  <div className="md-note-head">
                    <span className="md-note-heading">{n.headingPath || 'Document'}</span>
                    {!n.anchored && (
                      <span
                        className="md-note-orphan-tag"
                        title="The text this was pinned to is no longer in the plan. Your note is kept."
                      >
                        text changed
                      </span>
                    )}
                    <button
                      type="button"
                      className="md-note-remove"
                      aria-label="Remove suggestion"
                      onClick={() => onNotesChange(notes.filter((x) => x.id !== n.id))}
                    >
                      <X size={11} />
                    </button>
                  </div>
                  <div className="md-note-quote">“{truncate(n.quotedText, 90)}”</div>
                  <div className="md-note-body">{n.body}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="plan-doc-hint">
              <MessageSquarePlus size={12} />
              {editable
                ? 'Click anything to edit it. Select text to suggest a change instead.'
                : 'Running — the plan is read-only until it finishes.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type StepState = 'done' | 'running' | 'pending';

interface PlanStepCardProps {
  step: PlanStepBlock;
  state: StepState;
  executing: boolean;
  document: string;
  onToggle: () => void;
  onRename: (text: string) => void;
  guideProps: React.ComponentProps<typeof MarkdownPreview> | null;
}

/**
 * One step: its marker on the spine, its title, and its guide.
 *
 * Open by default while the plan is being reviewed — that is when it is a
 * document to read — and only the running step while it executes, when what
 * matters is what is happening now.
 */
function PlanStepCard({
  step,
  state,
  executing,
  document: doc,
  onToggle,
  onRename,
  guideProps,
}: PlanStepCardProps) {
  const [override, setOverride] = useState<boolean | null>(null);
  /** Holds the title text as it was when editing began — see commitRename. */
  const [renaming, setRenaming] = useState<{ original: string } | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const open = override ?? (executing ? state === 'running' : true);
  const raw = doc.slice(step.titleRange.start, step.titleRange.end);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    if (executing) setRenaming(null);
  }, [executing]);

  function beginRename(e: React.MouseEvent) {
    if (executing) return;
    // A real selection means the user is suggesting, not editing.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    e.stopPropagation();
    setDraft(raw);
    setRenaming({ original: raw });
  }

  function commitRename() {
    if (!renaming) return;
    const { original } = renaming;
    setRenaming(null);
    // Stale guard: the agent rewrote the plan while this title was open for
    // editing. Compare against the text captured at edit-START — comparing two
    // values both derived from the current render would always agree, and the
    // edit would splice into a document that had moved on.
    if (doc.slice(step.titleRange.start, step.titleRange.end) !== original) return;
    const next = draft.trim();
    if (!next || next === original) return;
    onRename(next);
  }

  return (
    <li className={`plan-step plan-step--${state}`}>
      <div className="plan-step-rail">
        <button
          type="button"
          className="plan-step-marker"
          onClick={onToggle}
          disabled={executing}
          aria-pressed={step.done}
          aria-label={step.done ? `Mark step ${step.ordinal} not done` : `Mark step ${step.ordinal} done`}
          title={executing ? 'Locked while the plan runs' : step.done ? 'Mark not done' : 'Mark done'}
        >
          {state === 'done' ? (
            <Check size={12} strokeWidth={3} />
          ) : state === 'running' ? (
            <span className="plan-step-pulse" />
          ) : (
            <span className="plan-step-ord">{step.ordinal}</span>
          )}
        </button>
      </div>

      <div className="plan-step-main">
        <div className="plan-step-head">
          {renaming ? (
            <textarea
              ref={inputRef}
              className="plan-step-title-input"
              value={draft}
              rows={Math.max(1, draft.split('\n').length)}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === 'Escape') {
                  setRenaming(null);
                }
              }}
              aria-label="Edit step title"
            />
          ) : (
            <h3
              className={`plan-step-title${executing ? '' : ' is-editable'}`}
              onClick={beginRename}
            >
              {inlineCode(step.title)}
            </h3>
          )}

          {guideProps && (
            <button
              type="button"
              className="plan-step-disclose"
              onClick={() => setOverride(!open)}
              aria-expanded={open}
              aria-label={open ? 'Hide details' : 'Show details'}
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          )}
        </div>

        {guideProps && open && (
          <div className="plan-step-guide">
            <MarkdownPreview {...guideProps} />
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Render backtick spans in a step title as code, leaving the rest as text.
 *
 * Titles are the most-read text in this view and they are full of identifiers
 * — `GET /b2b/domain/:domainName`, `MonoBehaviour`. Stripping the backticks
 * (what the old flat render did) made those read as prose; running the title
 * through a full markdown renderer would drag block semantics into a heading.
 */
function inlineCode(title: string): React.ReactNode {
  const parts = title.split('`');
  if (parts.length < 3) return title.replace(/\*\*/g, '');
  return parts.map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part.replace(/\*\*/g, '')}</span>,
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Match a plan step against a live todo entry.
 *
 * The model writes the todo text itself and rarely reproduces the step line
 * verbatim, so this compares the leading words rather than requiring equality.
 */
function looselyMatches(stepTitle: string, todoText: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const a = norm(stepTitle);
  const b = norm(todoText);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const head = b.split(' ').slice(0, 4).join(' ');
  return head.length > 0 && a.includes(head);
}

export default PlanDocumentView;
