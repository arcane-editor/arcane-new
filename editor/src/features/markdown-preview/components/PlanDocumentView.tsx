import { useMemo } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { Check, Circle, CircleDot, Play, Square } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useUiStore, type MarkdownViewMode } from '../../../stores/ui';
import { useThemeStore } from '../../../stores/theme';
import { useWorkspaceStore } from '../../../stores/workspace';
import { ensureMonacoTheme } from '../../theme';
import { fileUri } from '../../lsp';
import MarkdownPreview from './MarkdownPreview';
import { planStepsOf, type PlanNote } from '../services/note-anchor';
import { replaceBlock, toggleTaskAt } from '../services/block-edit';

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
 * A plan file rendered as a working document rather than a preview.
 *
 * Three things it is not: a read-only render, a place the user has to leave to
 * act, and a separate progress view. Steps carry their own state as execution
 * proceeds, so the plan IS the progress bar.
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
  const viewMode = useUiStore((s) => s.markdownViewMode[path] ?? 'preview');
  const setViewMode = useUiStore((s) => s.setMarkdownViewMode);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  const planPhase = useAiStore((s) => s.planPhase);
  const arcanePlan = useAiStore((s) => s.arcanePlan);
  const effort = useAiStore((s) => s.effort);
  const setEffort = useAiStore((s) => s.setEffort);

  const executing = planPhase === 'executing';
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const monacoThemeId = `app-theme-${activeThemeId}`;

  // Step state comes from the file — plan-execution.ts edits `- [ ]` to `- [x]`
  // as it completes each one — while the *running* step comes from the live
  // todo list. Neither alone is enough: the file knows what finished, the todo
  // list knows what is happening right now.
  const steps = useMemo(() => planStepsOf(content), [content]);
  const runningTitle = useMemo(
    () => arcanePlan?.find((e) => e.status === 'in_progress')?.text ?? null,
    [arcanePlan],
  );

  const doneCount = steps.filter((s) => s.done).length;
  const runningIndex = runningTitle
    ? steps.findIndex((s) => !s.done && looselyMatches(s.title, runningTitle))
    : -1;

  const pct = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0;

  // Block edits commit straight to disk as one atomic update-then-save, so the
  // tab never LINGERS dirty — which keeps both the Execute dirty-guard and the
  // fs-watcher's live tick-off refresh (skipIfDirty) working.
  function commitBlockEdit(start: number, end: number, newText: string): void {
    const next = replaceBlock(content, start, end, newText);
    if (next === content) return;
    const ws = useWorkspaceStore.getState();
    ws.updateFileContent(path, next);
    void ws.saveFile(path);
  }

  function toggleTask(offset: number): void {
    const next = toggleTaskAt(content, offset);
    if (next == null) return;
    const ws = useWorkspaceStore.getState();
    ws.updateFileContent(path, next);
    void ws.saveFile(path);
  }

  return (
    <div className="plan-doc">
      <div className="plan-doc-header">
        <div className="plan-doc-title">{path.split('/').pop()}</div>
        {executing && <span className="plan-doc-pill">read-only while executing</span>}
        <div className="plan-doc-modes" role="group" aria-label="View mode">
          {(['preview', 'source'] as MarkdownViewMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`plan-doc-mode${viewMode === m ? ' is-active' : ''}`}
              aria-pressed={viewMode === m}
              onClick={() => setViewMode(path, m)}
            >
              {m === 'preview' ? 'Preview' : 'Source'}
            </button>
          ))}
        </div>
      </div>

      {steps.length > 0 && (
        <div className="plan-doc-progress">
          <span className="plan-doc-progress-label">
            {executing ? 'Executing…' : 'Plan'} · step {Math.min(doneCount + 1, steps.length)} of{' '}
            {steps.length}
          </span>
          <div className="plan-doc-progress-track">
            <div className="plan-doc-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="plan-doc-progress-pct">{pct}%</span>
        </div>
      )}

      {steps.length > 0 && (
        <ol className="plan-doc-steps">
          {steps.map((s, i) => {
            const state = s.done ? 'done' : i === runningIndex ? 'running' : 'pending';
            return (
              <li key={i} className={`plan-doc-step plan-doc-step--${state}`}>
                <span className="plan-doc-step-icon">
                  {state === 'done' ? (
                    <Check size={13} />
                  ) : state === 'running' ? (
                    <CircleDot size={13} />
                  ) : (
                    <Circle size={13} />
                  )}
                </span>
                <span className="plan-doc-step-text">{stripMarkdown(s.title)}</span>
              </li>
            );
          })}
        </ol>
      )}

      <div className="plan-doc-body">
        {viewMode === 'preview' ? (
          <MarkdownPreview
            content={content}
            notes={notes}
            onNotesChange={onNotesChange}
            editable={!executing}
            onCommitBlockEdit={commitBlockEdit}
            onToggleTask={toggleTask}
          />
        ) : (
          // Source mode embeds Monaco inside the plan chrome (header, progress,
          // footer stay). It edits the SAME workspace tab buffer the plain
          // Monaco fallback would — updateFileContent marks the tab dirty and
          // the normal Cmd+S/save flow applies, so there is exactly one source
          // of truth for unsaved state. Read-only while the agent executes.
          <MonacoEditor
            path={fileUri(path)}
            height="100%"
            language="markdown"
            theme={monacoThemeId}
            value={content}
            onChange={(value) => {
              if (value !== undefined) {
                useWorkspaceStore.getState().updateFileContent(path, value);
              }
            }}
            beforeMount={() => ensureMonacoTheme(useThemeStore.getState().getActiveTheme())}
            onMount={() => ensureMonacoTheme(useThemeStore.getState().getActiveTheme())}
            options={{
              readOnly: executing,
              minimap: { enabled: false },
              wordWrap: 'on',
              automaticLayout: true,
              scrollBeyondLastLine: false,
              overviewRulerLanes: 0,
              overviewRulerBorder: false,
            }}
          />
        )}
      </div>

      <div className="plan-doc-footer">
        <span className="plan-doc-footer-count">
          {notes.length > 0
            ? `${notes.length} suggestion${notes.length === 1 ? '' : 's'}`
            : ''}
        </span>

        <button
          type="button"
          className="plan-doc-btn"
          onClick={onRevise}
          disabled={notes.length === 0 || isAgentRunning}
          title={
            notes.length === 0
              ? 'Select text in the plan to suggest a change first'
              : 'Send your suggestions and rewrite the plan'
          }
        >
          Revise plan
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
    </div>
  );
}

/** Strip the bold/emphasis markers so a step reads as a sentence. */
function stripMarkdown(s: string): string {
  return s.replace(/\*\*/g, '').replace(/`/g, '');
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
