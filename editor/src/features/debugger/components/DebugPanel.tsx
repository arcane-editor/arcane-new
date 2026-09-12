import { useEffect, useState } from 'react';
import { attachUnityEvidence } from '../../ai-panel';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useDebugStore } from '../../../stores/debug';
import { DebugToolbar } from './DebugToolbar';
import { CallStackPanel } from './CallStackPanel';
import { VariablesPanel } from './VariablesPanel';
import { WatchPanel } from './WatchPanel';
import { BreakpointsPanel } from './BreakpointsPanel';

/** Sidebar container composing the debug toolbar + call stack / variables / watch. */
export function DebugPanel() {
  const [manualHost, setManualHost] = useState('127.0.0.1');
  const [manualPort, setManualPort] = useState('');
  const [manualError, setManualError] = useState('');
  const threads = useDebugStore(s => s.threads);
  const currentThread = useDebugStore(s => s.currentThreadId);
  const stopReason = useDebugStore(s => s.stopReason);
  const filters = useDebugStore(s => s.exceptionFilters);
  const offered = useDebugStore(s => s.capabilities.exceptionBreakpointFilters);
  const targets = useDebugStore((s) => s.targets);
  const status = useDebugStore((s) => s.status);
  const unavailableReason = useDebugStore((s) => s.unavailableReason);
  const loadTargets = useDebugStore((s) => s.loadTargets);
  const scanTargets = useDebugStore((s) => s.scanTargets);
  const scanning = useDebugStore((s) => s.scanning);
  const selectedTargetId = useDebugStore((s) => s.selectedTargetId);
  const selectTarget = useDebugStore((s) => s.selectTarget);

  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  return (
    <div className="dbg-panel">
      <DebugToolbar />
      {/*
        There is nothing to install: the debugger is built in. The only reason
        it can be unavailable is that Unity is not running, so the message says
        that rather than pointing at a download.
      */}
      {(status === 'inactive' || status === 'terminated') && (
        <div className="dbg-targets">
          <label>
            Attach to
            <select
              value={selectedTargetId ?? targets[0]?.id ?? ''}
              onChange={(e) => selectTarget(e.target.value || null)}
              disabled={targets.length === 0}
            >
              {targets.length === 0 ? (
                <option value="">nothing found</option>
              ) : (
                targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))
              )}
            </select>
          </label>
          <div className="dbg-watch-add">
            <input aria-label="Player host" value={manualHost} onChange={e => setManualHost(e.target.value)} />
            <input aria-label="Player debugger port" placeholder="Debugger port" value={manualPort} onChange={e => setManualPort(e.target.value)} />
            <button onClick={() => {
              const port = Number(manualPort); const host = manualHost.trim();
              if (!host || /[\s/]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) { setManualError('Enter a host and debugger port from 1 to 65535.'); return; }
              const id = `manual:${host}:${port}`;
              useDebugStore.setState(s => ({ targets: [...s.targets.filter(t => t.id !== id), { id, kind: 'unityPlayer', label: `${host}:${port}`, host, port }], selectedTargetId: id }));
              setManualError('');
            }}>Add player</button>
          </div>
          {manualError && <p role="alert">{manualError}</p>}
          {/* Players and Android devices need a network listen and an adb call,
              so the slow scan is on demand rather than on every refresh. */}
          <button onClick={() => void scanTargets()} disabled={scanning}>
            {scanning ? 'Scanning…' : 'Find players'}
          </button>
        </div>
      )}
      {status === 'inactive' && targets.length === 0 && unavailableReason && (
        <div className="dbg-mono-warn">{unavailableReason}</div>
      )}
      {status === 'paused' && <div className="dbg-targets">
        <p>{stopReason}</p>
        <label>Thread <select value={currentThread ?? ''} onChange={e => void useDebugStore.getState().selectThread(Number(e.target.value))}>{threads.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <button onClick={() => {
          const s = useDebugStore.getState();
          void attachUnityEvidence({ source: 'debugger', label: 'Unity debugger stop', capturedAt: new Date().toISOString(), workspacePath: useWorkspaceStore.getState().workspacePath, data: { reason: s.stopReason, thread: s.threads.find(t => t.id === s.currentThreadId), frames: s.frames, selectedFrame: s.currentFrameId, variables: s.scopes.map(scope => ({ name: scope.name, values: s.variables.get(scope.variablesReference) })), watches: [...s.watchResults] } });
        }}>Explain this stop</button>
      </div>}
      {offered && <div className="dbg-targets">{offered.map(filter => <label key={filter.filter}><input type="checkbox" checked={filters.includes(filter.filter)} onChange={e => void useDebugStore.getState().setExceptionFilters(e.target.checked ? [...filters, filter.filter] : filters.filter(f => f !== filter.filter))} />{filter.label}</label>)}</div>}
      <div className="dbg-scroll">
        <div className="dbg-section-title">Call Stack</div>
        <CallStackPanel />
        <div className="dbg-section-title">Variables</div>
        <VariablesPanel />
        <div className="dbg-section-title">Watch</div>
        <WatchPanel />
        <div className="dbg-section-title">Breakpoints</div>
        <BreakpointsPanel />
      </div>
    </div>
  );
}
