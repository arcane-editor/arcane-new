import { useEffect } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useDebugStore } from '../../../stores/debug';
import { DebugToolbar } from './DebugToolbar';
import { CallStackPanel } from './CallStackPanel';
import { VariablesPanel } from './VariablesPanel';
import { WatchPanel } from './WatchPanel';

/** Sidebar container composing the debug toolbar + call stack / variables / watch. */
export function DebugPanel() {
  const monoAvailable = useDebugStore((s) => s.monoAvailable);
  const unavailableReason = useDebugStore((s) => s.unavailableReason);
  const checkMono = useDebugStore((s) => s.checkMono);

  useEffect(() => {
    void checkMono();
  }, [checkMono]);

  return (
    <div className="dbg-panel">
      <DebugToolbar />
      {monoAvailable === false && (
        <div className="dbg-mono-warn">
          {unavailableReason ?? 'Unity debugging needs the Mono runtime + debug adapter.'}
          <button onClick={() => void openUrl('https://www.mono-project.com/download/stable/')}>Install Mono</button>
        </div>
      )}
      <div className="dbg-scroll">
        <div className="dbg-section-title">Call Stack</div>
        <CallStackPanel />
        <div className="dbg-section-title">Variables</div>
        <VariablesPanel />
        <div className="dbg-section-title">Watch</div>
        <WatchPanel />
      </div>
    </div>
  );
}
