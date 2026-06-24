import { useState, useRef, useEffect, useCallback, useDeferredValue } from 'react';
import { Search, Trash2, ArrowDown, ArrowUpRight, Sparkles } from 'lucide-react';
import { useUnityStore } from '../../../stores/unity';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUiStore } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import { classifyFile, FilePriority } from '../../csharp';
import { useSceneUsageStore } from '../../unity-context';
import { BridgeInstallBanner } from '../../unity-bridge';
import { fixConsoleError } from '../../ai-panel';
import type { UnityLogEntry, UnityLogType } from '../../../types/unity';

const ERROR_TYPES: UnityLogType[] = ['Error', 'Exception', 'Assert'];

const LOG_TYPE_COLORS: Record<UnityLogType, string> = {
  Log: 'var(--text-primary)',
  Warning: 'var(--warning)',
  Error: 'var(--error-text)',
  Assert: 'var(--error-text)',
  Exception: 'var(--error-text)',
};

const LOG_TYPE_LABELS: Record<UnityLogType, string> = {
  Log: 'LOG',
  Warning: 'WRN',
  Error: 'ERR',
  Assert: 'AST',
  Exception: 'EXC',
};

interface CollapsedEntry {
  entry: UnityLogEntry;
  count: number;
}

function collapseEntries(logs: UnityLogEntry[]): CollapsedEntry[] {
  const collapsed: CollapsedEntry[] = [];
  for (const entry of logs) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.entry.message === entry.message && last.entry.logType === entry.logType) {
      last.count++;
    } else {
      collapsed.push({ entry, count: 1 });
    }
  }
  return collapsed;
}

function isMonoBehaviourFrame(filePath: string, workspacePath: string | null): boolean {
  if (!workspacePath) return false;
  const prefix = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/';
  if (!filePath.startsWith(prefix)) return false;
  if (!filePath.toLowerCase().endsWith('.cs')) return false;
  return classifyFile(filePath.slice(prefix.length)) === FilePriority.MonoBehaviour;
}

function UnityConsolePanel() {
  const logs = useUnityStore((s) => s.logs);
  const clearLogs = useUnityStore((s) => s.clearLogs);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  const [filter, setFilter] = useState('');
  const [showLog, setShowLog] = useState(true);
  const [showWarning, setShowWarning] = useState(true);
  const [showError, setShowError] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
    setAutoScroll(isAtBottom);
  }, []);

  // Filter logs — defer the text filter so rapid typing doesn't block reconciliation
  const deferredFilter = useDeferredValue(filter);
  const needle = deferredFilter.toLowerCase();
  const filteredLogs = logs.filter((entry) => {
    if (!showLog && entry.logType === 'Log') return false;
    if (!showWarning && entry.logType === 'Warning') return false;
    if (!showError && (entry.logType === 'Error' || entry.logType === 'Assert' || entry.logType === 'Exception')) return false;
    if (needle && !entry.message.toLowerCase().includes(needle)) return false;
    return true;
  });

  const collapsed = collapseEntries(filteredLogs);

  // Count by type
  const logCount = logs.filter((e) => e.logType === 'Log').length;
  const warnCount = logs.filter((e) => e.logType === 'Warning').length;
  const errCount = logs.filter((e) => e.logType === 'Error' || e.logType === 'Assert' || e.logType === 'Exception').length;

  const handleFrameClick = (filePath: string) => {
    const fileName = filePath.split('/').pop() ?? filePath;
    openFile(filePath, fileName);
  };

  const handleShowScenesForFrame = (filePath: string) => {
    if (!workspacePath) return;
    useUiStore.getState().setActiveRightSidebarView('unity-inspector');
    useUiStore.getState().setRightSidebarVisible(true);
    useSceneUsageStore.getState().loadForScript(filePath, workspacePath);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <BridgeInstallBanner />
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <button
          title="Clear Console"
          onClick={clearLogs}
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 2 }}
        >
          <Trash2 size={14} />
        </button>

        <div style={{ position: 'relative', flex: 1, maxWidth: 200 }}>
          <Search size={12} style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter..."
            style={{
              width: '100%',
              padding: '3px 6px 3px 22px',
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              color: 'var(--text-primary)',
              fontSize: 12,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <button
          onClick={() => setShowLog(!showLog)}
          style={{
            background: showLog ? 'var(--hover)' : 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 3,
            color: 'var(--text-primary)',
            fontSize: 11,
            padding: '2px 6px',
            cursor: 'pointer',
          }}
        >
          Log ({logCount})
        </button>
        <button
          onClick={() => setShowWarning(!showWarning)}
          style={{
            background: showWarning ? 'var(--hover)' : 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 3,
            color: 'var(--warning)',
            fontSize: 11,
            padding: '2px 6px',
            cursor: 'pointer',
          }}
        >
          Warn ({warnCount})
        </button>
        <button
          onClick={() => setShowError(!showError)}
          style={{
            background: showError ? 'var(--hover)' : 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 3,
            color: 'var(--error-text)',
            fontSize: 11,
            padding: '2px 6px',
            cursor: 'pointer',
          }}
        >
          Error ({errCount})
        </button>

        {!autoScroll && (
          <button
            title="Scroll to Bottom"
            onClick={() => {
              setAutoScroll(true);
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
            }}
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 2 }}
          >
            <ArrowDown size={14} />
          </button>
        )}
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12 }}
      >
        {collapsed.map((item, idx) => (
          <div key={idx}>
            <div
              onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                padding: '3px 8px',
                cursor: item.entry.parsedFrames?.length ? 'pointer' : 'default',
                background: expandedIdx === idx ? 'var(--hover)' : 'transparent',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span style={{
                color: LOG_TYPE_COLORS[item.entry.logType],
                fontWeight: 600,
                fontSize: 10,
                flexShrink: 0,
                width: 28,
                textAlign: 'center',
              }}>
                {LOG_TYPE_LABELS[item.entry.logType]}
              </span>
              <span style={{
                color: LOG_TYPE_COLORS[item.entry.logType],
                flex: 1,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {item.entry.message}
              </span>
              {item.count > 1 && (
                <span style={{
                  background: 'var(--badge-bg)',
                  color: 'var(--text-secondary)',
                  borderRadius: 8,
                  padding: '0 6px',
                  fontSize: 10,
                  flexShrink: 0,
                }}>
                  {item.count}
                </span>
              )}
              {isUnityProject && ERROR_TYPES.includes(item.entry.logType) && (
                <button
                  title="Fix this error with AI"
                  onClick={(e) => {
                    e.stopPropagation();
                    void fixConsoleError(item.entry);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    flexShrink: 0,
                    background: 'none',
                    border: '1px solid var(--border)',
                    borderRadius: 3,
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: 10,
                    padding: '0 5px',
                  }}
                >
                  <Sparkles size={11} /> Fix
                </button>
              )}
            </div>

            {/* Expanded stack trace */}
            {expandedIdx === idx && item.entry.parsedFrames && item.entry.parsedFrames.length > 0 && (
              <div style={{ padding: '4px 8px 4px 42px', background: 'var(--bg-input)' }}>
                {item.entry.parsedFrames.map((frame, fi) => {
                  const showScenesPill = isUnityProject && isMonoBehaviourFrame(frame.filePath, workspacePath);
                  return (
                    <div
                      key={fi}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        color: 'var(--text-secondary)',
                        padding: '1px 0',
                        fontSize: 11,
                      }}
                    >
                      <span
                        onClick={() => handleFrameClick(frame.filePath)}
                        style={{ cursor: 'pointer', flex: 1, minWidth: 0 }}
                      >
                        <span style={{ color: 'var(--text-primary)' }}>
                          {frame.className}.{frame.methodName}
                        </span>
                        {' at '}
                        <span style={{ color: 'var(--info)', textDecoration: 'underline' }}>
                          {frame.filePath}:{frame.lineNumber}
                        </span>
                      </span>
                      {showScenesPill && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleShowScenesForFrame(frame.filePath);
                          }}
                          title="Show scenes and prefabs where this script is used"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            background: 'var(--bg-input)',
                            border: '1px solid var(--border)',
                            borderRadius: 3,
                            color: 'var(--text-secondary)',
                            cursor: 'pointer',
                            fontSize: 10,
                            padding: '1px 6px',
                            flexShrink: 0,
                          }}
                        >
                          <ArrowUpRight size={10} />
                          Scenes
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {collapsed.length === 0 && (
          <div style={{
            padding: 16,
            textAlign: 'center',
            color: 'var(--text-secondary)',
            fontSize: 12,
          }}>
            No log entries
          </div>
        )}
      </div>
    </div>
  );
}

export default UnityConsolePanel;
