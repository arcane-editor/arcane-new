import { useEffect } from 'react';
import { useDebugStore } from '../../../stores/debug';
import { DebugToolbar } from './DebugToolbar';
import { CallStackPanel } from './CallStackPanel';
import { VariablesPanel } from './VariablesPanel';
import { WatchPanel } from './WatchPanel';
import { BreakpointsPanel } from './BreakpointsPanel';

/** Sidebar container composing the debug toolbar + call stack / variables / watch. */
export function DebugPanel() {
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
      {status === 'inactive' && (
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
