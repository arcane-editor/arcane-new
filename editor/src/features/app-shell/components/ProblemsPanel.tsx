import { useState, useMemo } from 'react';
import { File, CircleX, TriangleAlert, Info, Lightbulb } from 'lucide-react';
import { useUiStore, getFlatAllDiagnostics } from '../../../stores/ui';
import { useWorkspaceStore } from '../../../stores/workspace';
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

function ProblemsPanel() {
  const diagnostics = useUiStore((s) => s.diagnostics);
  const allDiagnostics = useMemo(() => getFlatAllDiagnostics(diagnostics), [diagnostics]);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // Which severities are currently visible (all on by default)
  const [activeSeverities, setActiveSeverities] = useState<Set<Severity>>(
    new Set(ALL_SEVERITIES),
  );

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
  const filtered = allDiagnostics.filter((d) => activeSeverities.has(d.severity));

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
    await useWorkspaceStore.getState().openFile(item.file, fileName);
    window.dispatchEvent(
      new CustomEvent('navigate-to-line', {
        detail: { line: item.line, column: item.col },
      }),
    );
  }

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
                </div>
                <div className="problems-item-list">
                  {items.map((item, idx) => (
                    <button
                      key={idx}
                      className="problems-item"
                      onClick={() => handleItemClick(item)}
                      title={item.message}
                    >
                      <span className="problems-item-icon">
                        <SeverityIcon severity={item.severity} />
                      </span>
                      <span className="problems-item-message">{item.message}</span>
                      {item.source && (
                        <span className={`problems-item-source${item.source !== 'lsp' ? ' problems-source-badge' : ''}`}>
                          {item.source}
                        </span>
                      )}
                      <span className="problems-item-location">
                        Ln {item.line}, Col {item.col}
                      </span>
                    </button>
                  ))}
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
