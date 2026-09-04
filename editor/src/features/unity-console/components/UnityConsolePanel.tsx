import { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue } from 'react';
import { Search, Trash2, ArrowDown, ArrowUpRight, Sparkles, ChevronDown } from 'lucide-react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useUnityStore } from '../../../stores/unity';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUiStore } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import { classifyFile, FilePriority } from '../../csharp';
import { useSceneUsageStore } from '../../unity-context';
import { BridgeInstallBanner } from '../../unity-bridge';
import { fixConsoleError } from '../../ai-panel';
import { describeClearOutcome } from '../services/clear-outcome';
import type { UnityLogEntry, UnityLogType } from '../../../types/unity';

const ERROR_TYPES: UnityLogType[] = ['Error', 'Exception', 'Assert'];

const LOG_TYPE_COLORS: Record<UnityLogType, string> = {
  Log: 'var(--text-primary)',
  Warning: 'var(--warning)',
  Error: 'var(--error-text)',
  Assert: 'var(--error-text)',
  Exception: 'var(--error-text)',
  CompileError: 'var(--error-text)',
  CompileWarning: 'var(--warning)',
};

const LOG_TYPE_LABELS: Record<UnityLogType, string> = {
  Log: 'LOG',
  Warning: 'WRN',
  Error: 'ERR',
  Assert: 'AST',
  Exception: 'EXC',
  CompileError: 'CER',
  CompileWarning: 'CWR',
};

interface CollapsedEntry {
  entry: UnityLogEntry;
  count: number;
}

function collapseEntries(logs: UnityLogEntry[]): CollapsedEntry[] {
  const collapsed: CollapsedEntry[] = [];
  for (const entry of logs) {
    const last = collapsed[collapsed.length - 1];
    // `historical` is part of the identity too: a backfilled entry and a
    // live-streamed one with the same message must never merge into one row —
    // that would silently drop the boundary the "Earlier" divider depends on.
    if (
      last &&
      last.entry.message === entry.message &&
      last.entry.logType === entry.logType &&
      !last.entry.historical === !entry.historical
    ) {
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
  const bridgeProtocol = useUnityStore((s) => s.bridgeProtocol);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  const [filter, setFilter] = useState('');
  const [showLog, setShowLog] = useState(true);
  const [showWarning, setShowWarning] = useState(true);
  const [showError, setShowError] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // Play/edit mode filter. `UnityLogEntry.mode` has always carried this; the
  // panel just never used it. Chasing a runtime bug means ignoring the
  // hundreds of import and compile messages Unity logs in edit mode.
  const [modeFilter, setModeFilter] = useState<'all' | 'PlayMode' | 'EditMode'>('all');
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  // What the last "Clear here and in Unity" actually managed. `null` on
  // success — the emptied panel is the confirmation; a sentence otherwise,
  // because the local ring empties either way and a silent failure reads as
  // though both consoles were cleared.
  const [clearNotice, setClearNotice] = useState<string | null>(null);
  const clearMenuRef = useRef<HTMLDivElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  // The auto-scroll effect runs before `virtualizer`/`collapsed` are in scope
  // (hook order), so it reads them through refs kept in sync below.
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const collapsedCountRef = useRef(0);

  // Auto-scroll to bottom. Setting scrollTop = scrollHeight is not enough once
  // rows are windowed: the rows near the end may not be mounted yet, so the
  // measured height is short and the view lands above the newest line.
  useEffect(() => {
    if (!autoScroll) return;
    if (collapsedCountRef.current === 0) return;
    virtualizerRef.current?.scrollToIndex(collapsedCountRef.current - 1, { align: 'end' });
  }, [logs.length, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 30;
    setAutoScroll(isAtBottom);
  }, []);

  // Protocol 4+ can also clear Unity's own console — below that, Clear stays
  // the single "clear here" button it always was (`clearConsole` is not an
  // RPC the bridge understands yet).
  const canClearUnity = (bridgeProtocol ?? 0) >= 4;

  useEffect(() => {
    if (!clearMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (!clearMenuRef.current?.contains(e.target as Node)) setClearMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setClearMenuOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [clearMenuOpen]);

  // Filter logs — defer the text filter so rapid typing doesn't block reconciliation
  const deferredFilter = useDeferredValue(filter);
  const needle = deferredFilter.toLowerCase();

  // Memoized because the store caps `logs` at 10,000 and Unity delivers a
  // batch every 100ms during play mode. Unmemoized this ran FIVE full passes
  // over all 10,000 rows — one filter, one collapse, three counts — on every
  // render, i.e. fifty thousand operations ten times a second, on the main
  // thread, which is what froze the window under ordinary logging.
  const collapsed = useMemo(() => {
    const filteredLogs = logs.filter((entry) => {
      if (!showLog && entry.logType === 'Log') return false;
      if (!showWarning && (entry.logType === 'Warning' || entry.logType === 'CompileWarning')) return false;
      if (
        !showError &&
        (entry.logType === 'Error' ||
          entry.logType === 'Assert' ||
          entry.logType === 'Exception' ||
          entry.logType === 'CompileError')
      )
        return false;
      // `mode: 'Unknown'` (a getConsoleSnapshot/logEntries row — LogEntries
      // does not record play/edit mode) is shown under EITHER filter, not
      // hidden by one and not asserted into the other.
      if (modeFilter !== 'all' && entry.mode !== 'Unknown' && entry.mode !== modeFilter) return false;
      if (needle && !entry.message.toLowerCase().includes(needle)) return false;
      return true;
    });
    return collapseEntries(filteredLogs);
  }, [logs, showLog, showWarning, showError, needle, modeFilter]);

  // Historical entries (`backfillConsoleHistory`) are always prepended as a
  // leading run, so "how many at the front are historical" is enough to know
  // where to render the "Earlier — from Unity's console" divider.
  const historicalCount = useMemo(() => {
    let n = 0;
    while (n < collapsed.length && collapsed[n]!.entry.historical) n++;
    return n;
  }, [collapsed]);
  const hasDivider = historicalCount > 0;
  // The divider is a real virtualized row (index 0) so scroll offsets/heights
  // stay correct; every other row shifts down by one when it is present.
  const rowOffset = hasDivider ? 1 : 0;
  const virtualCount = collapsed.length + rowOffset;

  // Virtualized: Unity emits thousands of lines in a play session and the
  // store caps at 10,000. Rendering every row built ~10k DOM subtrees, each
  // with its own click handler and possible stack-frame children, which is
  // what made scrolling the console stutter regardless of the filter cost.
  //
  // Dynamic measurement rather than a fixed row height: a row expands to show
  // parsed stack frames, so its height is not knowable up front.
  const virtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 20,
    overscan: 12,
  });

  virtualizerRef.current = virtualizer;
  collapsedCountRef.current = virtualCount;

  // Counts are over the unfiltered list, so they depend only on `logs` —
  // typing in the filter box must not re-count.
  const { logCount, warnCount, errCount } = useMemo(() => {
    let l = 0;
    let w = 0;
    let e = 0;
    // One pass instead of three.
    for (const entry of logs) {
      if (entry.logType === 'Log') l++;
      else if (entry.logType === 'Warning' || entry.logType === 'CompileWarning') w++;
      else if (
        entry.logType === 'Error' ||
        entry.logType === 'Assert' ||
        entry.logType === 'Exception' ||
        entry.logType === 'CompileError'
      )
        e++;
    }
    return { logCount: l, warnCount: w, errCount: e };
  }, [logs]);

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
        {canClearUnity ? (
          <div ref={clearMenuRef} style={{ position: 'relative' }}>
            <button
              title="Clear Console"
              onClick={() => setClearMenuOpen((o) => !o)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                background: 'none',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                padding: 2,
              }}
            >
              <Trash2 size={14} />
              <ChevronDown size={10} />
            </button>
            {clearMenuOpen && (
              <div
                role="menu"
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: 2,
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                  zIndex: 20,
                  minWidth: 190,
                  overflow: 'hidden',
                }}
              >
                <button
                  role="menuitem"
                  onClick={() => {
                    setClearMenuOpen(false);
                    setClearNotice(null);
                    void clearLogs();
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-primary)',
                    fontSize: 12,
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  Clear here
                </button>
                <button
                  role="menuitem"
                  onClick={() => {
                    setClearMenuOpen(false);
                    setClearNotice(null);
                    void clearLogs({ unity: true }).then((outcome) => {
                      setClearNotice(describeClearOutcome(outcome));
                    });
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-primary)',
                    fontSize: 12,
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  Clear here and in Unity
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            title="Clear Console"
            onClick={() => {
              setClearNotice(null);
              void clearLogs();
            }}
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 2 }}
          >
            <Trash2 size={14} />
          </button>
        )}

        <div style={{ position: 'relative', flex: 1, maxWidth: 200 }}>
          <Search size={12} style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter..."
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
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

        {/* Play/edit mode. A three-state cycle rather than two toggles: the
            useful states are "everything", "only this play session" and "only
            edit-time", and two independent toggles allow a fourth state that
            shows nothing at all. */}
        <button
          title="Filter by play mode"
          onClick={() =>
            setModeFilter((m) => (m === 'all' ? 'PlayMode' : m === 'PlayMode' ? 'EditMode' : 'all'))
          }
          style={{
            background: modeFilter === 'all' ? 'transparent' : 'var(--hover)',
            border: '1px solid var(--border)',
            borderRadius: 3,
            color: 'var(--text-secondary)',
            fontSize: 11,
            padding: '2px 6px',
            cursor: 'pointer',
          }}
        >
          {modeFilter === 'all' ? 'All modes' : modeFilter === 'PlayMode' ? 'Play only' : 'Edit only'}
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

      {/* Why Unity's console survived a "Clear here and in Unity". Sits under
          the toolbar rather than in a toast: the state it describes is about
          this panel, and it stays until the next clear. */}
      {clearNotice && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '4px 8px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-input)',
            color: 'var(--warning)',
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          <span>{clearNotice}</span>
          <button
            title="Dismiss"
            onClick={() => setClearNotice(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              padding: 0,
              fontSize: 11,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: 12 }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          if (hasDivider && virtualRow.index === 0) {
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div
                  style={{
                    padding: '4px 8px',
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    color: 'var(--text-secondary)',
                    background: 'var(--bg-input)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  Earlier — from Unity's console
                </div>
              </div>
            );
          }
          const idx = virtualRow.index - rowOffset;
          const item = collapsed[idx];
          if (!item) return null;
          return (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
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
          );
        })}
        </div>

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
