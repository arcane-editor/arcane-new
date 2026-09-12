import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, MessageSquarePlus, Play, Plus, RotateCw, Square, Trash2, X } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import PlanRegionEditor, { type CaretTarget, type RegionFocuser } from './PlanRegionEditor';
import SuggestPopover from './SuggestPopover';
import { createNote, reanchorNotes, type PlanNote } from '../services/note-anchor';
import { toggleTaskAt } from '../services/block-edit';
import { insertTodoAfter, removeTodoAt, moveTodo } from '../services/todo-edit';
import { parsePlanDocument, type PlanStepBlock } from '../services/plan-document';
import { planRegions, regionsInOrder, type PlanRegion } from '../services/region-model';
import { splitRegionText } from '../services/region-markdown';
import { spliceRegion } from '../services/region-write';
import { createSaveScheduler } from '../services/save-scheduler';
import type { NavIntent } from '../services/region-nav';

/**
 * How long typing has to pause before the plan hits the disk.
 *
 * Editing in place means a change per keystroke, where the old click-to-edit
 * boxes produced one per blur. Every write is a `write_file` IPC round trip
 * plus a git status refresh (`workspace.ts`'s `saveFile`), so they are
 * debounced — and flushed the moment anything needs the file on disk to be
 * current (blur, Execute, unmount).
 */
const SAVE_IDLE_MS = 400;

/**
 * What every region editor needs and none of them differ on. Passed as one
 * object so a step card's props change only when the document's STRUCTURE
 * does — not on every keystroke somewhere else in the plan.
 */
interface RegionWiring {
  regions: readonly PlanRegion[];
  editable: boolean;
  onChange: (regionId: string, body: string) => void;
  onNavIntent: (regionId: string, intent: NavIntent) => void;
  onBlur: () => void;
  registerFocuser: (regionId: string, focus: RegionFocuser | null) => void;
}

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
 * - **Not a source editor.** There is no Preview/Source toggle and no Monaco,
 *   and no box opens when you click. Every part of the document is editable
 *   where it is rendered (`PlanRegionEditor`): the caret lands where you
 *   clicked, the text keeps its formatting while you type, and markdown
 *   shortcuts apply as you write them. What reaches the file is markdown —
 *   `parsePlanDocument` hands back offsets rather than copies precisely so
 *   each region can be spliced back into the real file.
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
  const hostedPlan = useAiStore((s) => s.hostedPlan);
  const effort = useAiStore((s) => s.effort);
  const setEffort = useAiStore((s) => s.setEffort);

  const executing = planPhase === 'executing';
  const editable = !executing;
  // An interrupted run (capped/aborted/errored — Task 5/6) still shows this
  // toolbar's primary button (`executing` is false), but it must read as
  // "pick back up", not "start over" — mirrors PlanActions.tsx's `interrupted`
  // branch, the message-list card for the same phase.
  const interrupted = planPhase === 'interrupted';
  // Same for a run that finished every step: the toolbar must not read
  // "Execute" for work it just watched complete. Mirrors PlanActions.tsx's
  // `completed` branch — the two are the same card in two places.
  const completed = planPhase === 'completed';

  const doc = useMemo(() => parsePlanDocument(content), [content]);
  /** The selection host for suggestions — every region editor sits inside it. */
  const pageRef = useRef<HTMLDivElement>(null);

  // Step state comes from the FILE — plan-execution.ts rewrites `- [ ]` to
  // `- [x]` as it finishes each one — while the RUNNING step comes from the
  // live todo list. Neither alone is enough: the file knows what finished, the
  // todo list knows what is happening right now.
  const runningTitle = useMemo(
    () => hostedPlan?.find((e) => e.status === 'in_progress')?.text ?? null,
    [hostedPlan],
  );
  const runningIndex = runningTitle
    ? doc.steps.findIndex((s) => !s.done && looselyMatches(s.title, runningTitle))
    : -1;

  const doneCount = doc.steps.filter((s) => s.done).length;
  const total = doc.steps.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  // Debounced, and skipped entirely when there is nothing pinned: this scans
  // the whole document once per note (`note-anchor.ts`'s heading walk), which
  // was affordable when an edit was one blur and is not when it is one
  // keystroke. Notes only need to be right once the typing stops.
  useEffect(() => {
    if (notes.length === 0) return;
    const timer = setTimeout(() => {
      const next = reanchorNotes(notes, content);
      const changed = next.some(
        (n, i) => n.anchored !== notes[i]?.anchored || n.headingPath !== notes[i]?.headingPath,
      );
      if (changed) onNotesChange(next);
    }, 300);
    return () => clearTimeout(timer);
    // Keyed on `content` alone: re-running on `notes` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // The store update is immediate — it is what re-renders the document — but
  // the DISK write is debounced (see SAVE_IDLE_MS). The tab is therefore dirty
  // between keystrokes, which is exactly the window `reloadFileFromDisk`'s
  // `skipIfDirty` exists to protect, and `flush()` closes it wherever the file
  // itself has to be current: Execute's dirty guard (`plan-run.ts`), a region
  // losing focus, and unmount.
  const saver = useMemo(
    () =>
      createSaveScheduler({
        save: () => useWorkspaceStore.getState().saveFile(path),
        delayMs: SAVE_IDLE_MS,
      }),
    [path],
  );

  useEffect(() => () => void saver.flush(), [saver]);

  /** The freshest text of this file, straight from the store. */
  const currentContent = useCallback(
    () => useWorkspaceStore.getState().openFiles.find((f) => f.path === path)?.content ?? '',
    [path],
  );

  const write = useCallback(
    (next: string) => {
      if (next === currentContent()) return;
      useWorkspaceStore.getState().updateFileContent(path, next);
      saver.schedule();
    },
    [currentContent, path, saver],
  );

  const toggleTask = useCallback(
    (offset: number) => {
      const next = toggleTaskAt(currentContent(), offset);
      if (next != null) write(next);
    },
    [currentContent, write],
  );

  // A note pinned from a step's own Comment button, anchored on the step title.
  // The selection popover still exists for finer targeting, but requiring a
  // text selection to say anything meant there was no way at all to comment on
  // a step AS a step — which is the level most feedback is actually about.
  const addStepNote = useCallback(
    (title: string, body: string) => {
      onNotesChange([...notes, createNote(content, title, body)]);
    },
    [content, notes, onNotesChange],
  );

  // ---- editable regions ---------------------------------------------------
  // Every span of this document that is TEXT rather than chrome, and the text
  // inside each one. Regions carry offsets; the editors are handed only their
  // own slice, so a keystroke in one guide leaves every other editor's props
  // untouched and `PlanRegionEditor`'s memo bails on them.
  const regions = useMemo(() => planRegions(doc), [doc]);

  const regionText = useMemo(() => {
    const texts = new Map<string, string>();
    for (const r of regions) {
      texts.set(r.id, splitRegionText(content.slice(r.range.start, r.range.end)).body);
    }
    return texts;
  }, [regions, content]);

  /**
   * The same regions, but with an identity that survives typing.
   *
   * `regions` is rebuilt from a fresh parse on every keystroke, so handing it
   * to the editors directly would give every one of them new props for a
   * change in a different region — exactly the whole-document re-render this
   * work exists to stop. Boundary hand-off only cares about which regions
   * exist and in what order, so this re-identifies only when THAT changes.
   */
  const regionShape = regions.map((r) => `${r.id}:${r.kind}`).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const navRegions = useMemo(() => regions, [regionShape]);

  /** A step with neither a title nor guide text — what Backspace may delete. */
  const emptySteps = useMemo(() => {
    const empty = new Set<number>();
    doc.steps.forEach((_step, i) => {
      const title = (regionText.get(`step-${i}-title`) ?? '').trim();
      const guide = (regionText.get(`step-${i}-guide`) ?? '').trim();
      if (!title && !guide) empty.add(i);
    });
    return empty;
  }, [doc.steps, regionText]);

  /**
   * Splice an edited region back into the file (`region-write.ts`).
   *
   * Against the FRESHEST content rather than this render's, because a fast
   * typist outruns React: two keystrokes in one frame would otherwise both
   * splice into the same stale string and the first would be lost.
   */
  const handleRegionChange = useCallback(
    (regionId: string, body: string) => {
      const next = spliceRegion(currentContent(), regionId, body);
      if (next !== null) write(next);
    },
    [currentContent, write],
  );

  // Focus hand-off. A region that has not mounted yet — the title of a step
  // created half a keystroke ago — is remembered and focused by the effect
  // below once it registers, so promoting a step lands the caret in it.
  const focusers = useRef(new Map<string, RegionFocuser>());
  const pendingFocus = useRef<{ id: string; caret: CaretTarget } | null>(null);

  const registerFocuser = useCallback((id: string, focus: RegionFocuser | null) => {
    if (focus) focusers.current.set(id, focus);
    else focusers.current.delete(id);
  }, []);

  const focusRegion = useCallback((id: string, caret: CaretTarget) => {
    const focus = focusers.current.get(id);
    if (focus) focus(caret);
    else pendingFocus.current = { id, caret };
  }, []);

  useEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    const focus = focusers.current.get(want.id);
    if (!focus) return;
    pendingFocus.current = null;
    focus(want.caret);
  });

  /** What a keystroke at a region's edge asked for (`region-nav.ts`). */
  const handleNavIntent = useCallback(
    (regionId: string, intent: NavIntent) => {
      if (intent.kind === 'focus') {
        focusRegion(intent.regionId, intent.caret);
        return;
      }
      if (intent.kind === 'promote-step') {
        write(insertTodoAfter(currentContent(), intent.afterStepIndex, ''));
        // The new step's title is a placeholder, so select it: the next
        // character typed replaces it instead of appending to it.
        focusRegion(`step-${intent.afterStepIndex + 1}-title`, 'all');
        return;
      }
      if (intent.kind === 'remove-step') {
        const { previous } = regionsInOrder(navRegions, regionId);
        write(removeTodoAt(currentContent(), intent.stepIndex));
        if (previous) focusRegion(previous.id, 'end');
      }
    },
    [currentContent, focusRegion, navRegions, write],
  );

  /** Leaving a region is the cheap moment to get the file onto disk. */
  const handleRegionBlur = useCallback(() => void saver.flush(), [saver]);

  /** Everything a region editor needs that is the same for all of them. */
  const regionWiring = useMemo(
    () => ({
      regions: navRegions,
      editable,
      onChange: handleRegionChange,
      onNavIntent: handleNavIntent,
      onBlur: handleRegionBlur,
      registerFocuser,
    }),
    [navRegions, editable, handleRegionChange, handleNavIntent, handleRegionBlur, registerFocuser],
  );

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
            // Both of these hand the file to the agent, which reads it from
            // DISK — Revise through `readPlan`, Execute through
            // `runPlanExecution` (which also refuses to start while the tab is
            // dirty). Debounced keystrokes have to be on disk first.
            onClick={() => void saver.flush().then(onRevise)}
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
              className={`plan-doc-btn${completed ? '' : ' plan-doc-btn--primary'}`}
              onClick={() => void saver.flush().then(onExecute)}
              disabled={isAgentRunning}
              title={
                interrupted
                  ? 'Resume the plan from where it stopped'
                  : completed
                    ? 'Run this plan again from the top'
                    : undefined
              }
            >
              {completed ? <RotateCw size={11} /> : <Play size={11} />}
              {interrupted ? 'Resume' : completed ? 'Run again' : 'Execute'}
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
        <div className="plan-doc-page" ref={pageRef}>
          {doc.blocks.map((block, i) =>
            block.kind === 'markdown' ? (
              <ProseRegion
                key={`md-${block.range.start}-${i}`}
                regions={regions}
                regionText={regionText}
                range={block.range}
                wiring={regionWiring}
              />
            ) : (
              <ol className="plan-spine" key={`steps-${i}`}>
                {block.steps.map((step, si) => (
                  <PlanStepCard
                    key={step.ordinal}
                    step={step}
                    state={step.done ? 'done' : step.ordinal - 1 === runningIndex ? 'running' : 'pending'}
                    executing={executing}
                    onToggle={() => toggleTask(step.checkboxOffset)}
                    onComment={(body) => addStepNote(step.title, body)}
                    onInsertAfter={() => write(insertTodoAfter(content, si, 'New step'))}
                    onRemove={() => write(removeTodoAt(content, si))}
                    onMove={(delta) => write(moveTodo(content, si, si + delta))}
                    canMoveUp={si > 0}
                    canMoveDown={si < block.steps.length - 1}
                    titleText={regionText.get(`step-${si}-title`) ?? ''}
                    guideText={step.guide ? (regionText.get(`step-${si}-guide`) ?? '') : null}
                    stepIndex={si}
                    stepIsEmpty={emptySteps.has(si)}
                    wiring={regionWiring}
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

          {/* Selecting text inside any region still pins a suggestion — one
              listener on the page covers every editor on it. */}
          <SuggestPopover
            containerRef={pageRef}
            anchorDoc={content}
            notes={notes}
            onNotesChange={onNotesChange}
            enabled={editable}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * A markdown block between the steps — the lead paragraph, `## Risks`, the
 * tail. Looked up by offset rather than passed an index so it stays correct
 * when a step above it is added or deleted.
 */
function ProseRegion({
  regions,
  regionText,
  range,
  wiring,
}: {
  regions: readonly PlanRegion[];
  regionText: Map<string, string>;
  range: { start: number; end: number };
  wiring: RegionWiring;
}) {
  const region = regions.find((r) => r.kind === 'prose' && r.range.start === range.start);
  if (!region) return null;
  return (
    <PlanRegionEditor
      regionId={region.id}
      kind="prose"
      text={regionText.get(region.id) ?? ''}
      stepIsEmpty={false}
      ariaLabel="Plan text"
      {...wiring}
    />
  );
}

type StepState = 'done' | 'running' | 'pending';

interface PlanStepCardProps {
  step: PlanStepBlock;
  state: StepState;
  executing: boolean;
  onToggle: () => void;
  /** Pin a suggestion to this step without having to select its text first. */
  onComment: (body: string) => void;
  onInsertAfter: () => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** This step's own text — never the whole document (see the memo below). */
  titleText: string;
  /** Null when the plan has no guide entry for this step. */
  guideText: string | null;
  stepIndex: number;
  stepIsEmpty: boolean;
  wiring: RegionWiring;
}

/**
 * One step: its marker on the spine, its title, and its guide.
 *
 * Open by default while the plan is being reviewed — that is when it is a
 * document to read — and only the running step while it executes, when what
 * matters is what is happening now.
 */
const PlanStepCard = memo(function PlanStepCard({
  step,
  state,
  executing,
  onToggle,
  onComment,
  onInsertAfter,
  onRemove,
  onMove,
  canMoveUp,
  canMoveDown,
  titleText,
  guideText,
  stepIndex,
  stepIsEmpty,
  wiring,
}: PlanStepCardProps) {
  const [override, setOverride] = useState<boolean | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  const open = override ?? (executing ? state === 'running' : true);
  const hasGuide = guideText !== null;

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
          {/* The title IS the editor — one line of plain text, so `- ` or `# `
              typed here stays literal instead of turning the title into a
              list. Markdown formatting belongs in the guide below it. */}
          <h3 className="plan-step-title">
            <PlanRegionEditor
              regionId={`step-${stepIndex}-title`}
              kind="title"
              text={titleText}
              stepIsEmpty={stepIsEmpty}
              placeholder="Untitled step"
              ariaLabel={`Step ${step.ordinal} title`}
              {...wiring}
            />
          </h3>

          {/* Editing a plan means changing what the steps ARE, not only what
              they say — adding one, dropping one, doing that first. Those had
              no affordance at all, so the only way to ask for them was to
              select some text and describe the change in prose. The row is
              hidden until the step is hovered or focused (see App.css) so a
              plan being read stays a document. */}
          {!executing && (
            <div className="plan-step-actions">
              <button
                type="button"
                className="plan-step-action"
                onClick={() => setComment(comment === null ? '' : null)}
                aria-label={`Comment on step ${step.ordinal}`}
                title="Comment on this step"
              >
                <MessageSquarePlus size={12} />
              </button>
              <button
                type="button"
                className="plan-step-action"
                onClick={() => onMove(-1)}
                disabled={!canMoveUp}
                aria-label={`Move step ${step.ordinal} up`}
                title="Move up"
              >
                <ArrowUp size={12} />
              </button>
              <button
                type="button"
                className="plan-step-action"
                onClick={() => onMove(1)}
                disabled={!canMoveDown}
                aria-label={`Move step ${step.ordinal} down`}
                title="Move down"
              >
                <ArrowDown size={12} />
              </button>
              <button
                type="button"
                className="plan-step-action"
                onClick={onInsertAfter}
                aria-label={`Add a step after step ${step.ordinal}`}
                title="Add a step below"
              >
                <Plus size={12} />
              </button>
              <button
                type="button"
                className="plan-step-action plan-step-action--danger"
                onClick={onRemove}
                aria-label={`Delete step ${step.ordinal}`}
                title="Delete this step"
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}

          {hasGuide && (
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

        {comment !== null && (
          <div className="plan-step-comment">
            <textarea
              ref={commentRef}
              className="plan-step-comment-input"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={`What should change about "${step.title}"?`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (comment.trim()) onComment(comment.trim());
                  setComment(null);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setComment(null);
                }
              }}
              autoFocus
              aria-label={`Comment on step ${step.ordinal}`}
            />
            <div className="plan-step-comment-actions">
              <span className="plan-step-comment-hint">⌘⏎ to add</span>
              <button type="button" className="md-suggest-btn" onClick={() => setComment(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="md-suggest-btn md-suggest-btn--primary"
                disabled={!comment.trim()}
                onClick={() => {
                  onComment(comment.trim());
                  setComment(null);
                }}
              >
                Add
              </button>
            </div>
          </div>
        )}

        {hasGuide && open && (
          <div className="plan-step-guide">
            <PlanRegionEditor
              regionId={`step-${stepIndex}-guide`}
              kind="guide"
              text={guideText ?? ''}
              stepIsEmpty={stepIsEmpty}
              placeholder="Notes for this step…"
              ariaLabel={`Step ${step.ordinal} details`}
              {...wiring}
            />
          </div>
        )}
      </div>
    </li>
  );
});

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
