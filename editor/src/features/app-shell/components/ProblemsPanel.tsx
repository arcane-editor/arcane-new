import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  File,
  CircleX,
  TriangleAlert,
  Info,
  Lightbulb,
  Copy,
  Check,
  X,
  MessageSquarePlus,
} from 'lucide-react';
import { useUiStore, getFlatAllDiagnostics } from '../../../stores/ui';
import { useWorkspaceStore } from '../../../stores/workspace';
import { recordJumpOrigin } from '../../../utils/jump-history';
import { attachErrorReport, copyErrorReport } from '../../ai-panel';
import type { DiagnosticItem } from '../../../types';

type Severity = DiagnosticItem['severity'];

const ALL_SEVERITIES: Severity[] = ['error', 'warning', 'info', 'hint'];

function SeverityIcon({ severity }: { severity: Severity }) {
  switch (severity) {
    case 'error':
      return <CircleX size={14} style={{ color: 'var(--error-text)' }} />;
    case 'warning':
      return <TriangleAlert size={14} style={{ color: 'var(--warning)' }} />;
    case 'info':
      return <Info size={14} style={{ color: 'var(--info)' }} />;
    case 'hint':
      return <Lightbulb size={14} style={{ color: 'var(--text-secondary)' }} />;
  }
}

/** Identifies which control last reported a copy result, so only it shows the tick. */
type CopyFlash = { key: string; ok: boolean } | null;

function CopyGlyph({ flash }: { flash: CopyFlash }) {
  if (!flash) return <Copy size={12} />;
  return flash.ok ? (
    <Check size={12} style={{ color: 'var(--success)' }} />
  ) : (
    <X size={12} style={{ color: 'var(--error-text)' }} />
  );
}

/**
 * Copy + Ask AI, shared by the row, the file header and the toolbar.
 *
 * Module scope, not nested in `ProblemsPanel`: a component declared inside a
 * render is a NEW type on every render, so React unmounts and remounts it —
 * which would drop focus, and `:focus-within` is what keeps these buttons
 * reachable from the keyboard at all.
 */
function RowActions({
  className,
  flash,
  copyTitle,
  askTitle,
  onCopy,
  onAsk,
}: {
  className: string;
  flash: CopyFlash;
  copyTitle: string;
  askTitle: string;
  onCopy: () => void;
  onAsk: () => void;
}) {
  return (
    <div className={className}>
      <button
        type="button"
        className="problems-item-action"
        title={flash && !flash.ok ? "Couldn't copy — clipboard unavailable" : copyTitle}
        onClick={(e) => {
          e.stopPropagation();
          onCopy();
        }}
      >
        <CopyGlyph flash={flash} />
      </button>
      <button
        type="button"
        className="problems-item-action"
        title={askTitle}
        onClick={(e) => {
          e.stopPropagation();
          onAsk();
        }}
      >
        <MessageSquarePlus size={12} />
      </button>
    </div>
  );
}

function ProblemsPanel() {
  const diagnostics = useUiStore((s) => s.diagnostics);
  const allDiagnostics = useMemo(() => getFlatAllDiagnostics(diagnostics), [diagnostics]);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // Which severities are currently visible (all on by default)
  const [activeSeverities, setActiveSeverities] = useState<Set<Severity>>(
    new Set(ALL_SEVERITIES),
  );
  const [copyFlash, setCopyFlash] = useState<CopyFlash>(null);

  function toggleSeverity(severity: Severity) {
    setActiveSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(severity)) {
        next.delete(severity);
      } else {
        next.add(severity);
      }
      return next;
    });
  }
  const filtered = useMemo(
    () => allDiagnostics.filter((d) => activeSeverities.has(d.severity)),
    [allDiagnostics, activeSeverities],
  );

  // Group by file
  const byFile = new Map<string, DiagnosticItem[]>();
  for (const item of filtered) {
    const group = byFile.get(item.file) ?? [];
    group.push(item);
    byFile.set(item.file, group);
  }

  // Count per severity for the filter bar badges
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const d of allDiagnostics) {
    counts[d.severity]++;
  }

  async function handleItemClick(item: DiagnosticItem) {
    const fileName = item.file.split('/').pop() || '';
    // Record where we are BEFORE opening: this path awaits `openFile` and only
    // then dispatches, so by the time the event fires the origin is gone.
    recordJumpOrigin();
    await useWorkspaceStore.getState().openFile(item.file, fileName);
    window.dispatchEvent(
      new CustomEvent('navigate-to-line', {
        detail: { line: item.line, column: item.col },
      }),
    );
  }

  /**
   * Report the outcome on the button. `navigator.clipboard` rejects for reasons
   * a user can actually hit — an unfocused window, a denied permission — and a
   * silent failure looks exactly like a success until they paste.
   */
  const runCopy = useCallback(async (key: string, items: DiagnosticItem[]) => {
    const ok = await copyErrorReport({ source: 'problems', items, workspacePath });
    setCopyFlash({ key, ok });
    setTimeout(() => setCopyFlash(null), ok ? 1200 : 2000);
  }, [workspacePath]);

  const runAsk = useCallback(
    (items: DiagnosticItem[]) => {
      void attachErrorReport({ source: 'problems', items, workspacePath });
    },
    [workspacePath],
  );

  // Palette commands act on what the panel is showing, which is state only the
  // panel owns — hence the event hop (same shape as `ai.newChat`).
  useEffect(() => {
    const onCopyAll = () => void runCopy('all', filtered);
    const onAskAi = () => runAsk(filtered);
    window.addEventListener('problems-copy-all', onCopyAll);
    window.addEventListener('problems-ask-ai', onAskAi);
    return () => {
      window.removeEventListener('problems-copy-all', onCopyAll);
      window.removeEventListener('problems-ask-ai', onAskAi);
    };
  }, [filtered, runCopy, runAsk]);

  const flashFor = (key: string): CopyFlash => (copyFlash?.key === key ? copyFlash : null);

  const severityLabels: Record<Severity, string> = {
    error: 'Errors',
    warning: 'Warnings',
    info: 'Info',
    hint: 'Hints',
  };

  return (
    <div className="problems-panel">
      {/* Filter bar */}
      <div className="problems-filter-bar">
        {ALL_SEVERITIES.map((sev) => (
          <button
            key={sev}
            className={`problems-filter-btn${activeSeverities.has(sev) ? ' active' : ''}`}
            onClick={() => toggleSeverity(sev)}
            title={`Toggle ${severityLabels[sev]}`}
          >
            <SeverityIcon severity={sev} />
            <span className="problems-filter-label">{severityLabels[sev]}</span>
            {counts[sev] > 0 && (
              <span className="problems-filter-count">{counts[sev]}</span>
            )}
          </button>
        ))}

        {/* The severity chips to the left ARE the selector for these two, so
            they act on what is on screen rather than on everything. */}
        <span className="problems-bar-spacer" />
        <div className="problems-bar-actions">
          <button
            type="button"
            className="problems-bar-action"
            disabled={filtered.length === 0}
            title={
              copyFlash?.key === 'all' && !copyFlash.ok
                ? "Couldn't copy — clipboard unavailable"
                : `Copy the ${filtered.length} problems currently shown`
            }
            onClick={() => void runCopy('all', filtered)}
          >
            <CopyGlyph flash={flashFor('all')} />
            <span>Copy ({filtered.length})</span>
          </button>
          <button
            type="button"
            className="problems-bar-action"
            disabled={filtered.length === 0}
            title={`Add the ${filtered.length} problems currently shown to the AI chat as context`}
            onClick={() => runAsk(filtered)}
          >
            <MessageSquarePlus size={12} />
            <span>Ask AI ({filtered.length})</span>
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="problems-list">
        {filtered.length === 0 ? (
          <div className="problems-empty">No problems detected.</div>
        ) : (
          Array.from(byFile.entries()).map(([filePath, items]) => {
            const fileName = filePath.split('/').pop() || filePath;
            const relPath = workspacePath
              ? filePath.replace(workspacePath + '/', '')
              : filePath;

            return (
              <div key={filePath} className="problems-file-group">
                <div className="problems-file-header" title={filePath}>
                  <File size={14} className="problems-file-icon" />
                  <span className="problems-file-name">{fileName}</span>
                  <span className="problems-file-path">{relPath !== fileName ? relPath : ''}</span>
                  <span className="problems-file-count">{items.length}</span>
                  <RowActions
                    className="problems-file-actions"
                    flash={flashFor(`file:${filePath}`)}
                    copyTitle={`Copy this file's ${items.length} problems`}
                    askTitle={`Add this file's ${items.length} problems to the AI chat as context`}
                    onCopy={() => void runCopy(`file:${filePath}`, items)}
                    onAsk={() => runAsk(items)}
                  />
                </div>
                <div className="problems-item-list">
                  {items.map((item, idx) => {
                    const rowKey = `${item.file}:${item.line}:${item.col}:${item.code ?? ''}`;
                    return (
                    // A div, not a button: the row carries its own action
                    // buttons and buttons cannot nest.
                    <div
                      key={idx}
                      className="problems-item"
                      role="button"
                      tabIndex={0}
                      onClick={() => handleItemClick(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          void handleItemClick(item);
                        }
                      }}
                      title={item.message}
                    >
                      <span className="problems-item-icon">
                        <SeverityIcon severity={item.severity} />
                      </span>
                      <span className="problems-item-message">{item.message}</span>
                      {/* The code, when there is one, says more than the
                          source does: `UNT0002` is searchable and is what a
                          suppression comment names, while "lsp" only says
                          which process it came through. */}
                      {item.code ? (
                        <span
                          className={`problems-item-source${
                            /^(UNT|UNITY)\d{4}$/.test(item.code) ? ' problems-source-badge' : ''
                          }`}
                          title={
                            item.code.startsWith('UNT')
                              ? 'Unity analyzer (Roslyn)'
                              : item.code.startsWith('UNITY')
                                ? 'Unity analyzer (editor)'
                                : undefined
                          }
                        >
                          {item.code}
                        </span>
                      ) : (
                        item.source && (
                          <span className={`problems-item-source${item.source !== 'lsp' ? ' problems-source-badge' : ''}`}>
                            {item.source}
                          </span>
                        )
                      )}
                      <span className="problems-item-location">
                        Ln {item.line}, Col {item.col}
                      </span>
                      <RowActions
                        className="problems-item-actions"
                        flash={flashFor(rowKey)}
                        copyTitle="Copy this problem"
                        askTitle="Add this problem to the AI chat as context"
                        onCopy={() => void runCopy(rowKey, [item])}
                        onAsk={() => runAsk([item])}
                      />
                    </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default ProblemsPanel;
