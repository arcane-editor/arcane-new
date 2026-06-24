import { Bug, Play, Pause, StepForward, ArrowDownToLine, ArrowUpFromLine, Square } from 'lucide-react';
import { useDebugStore } from '../../../stores/debug';

/** Attach / run-control toolbar. Buttons enable based on session status. */
export function DebugToolbar() {
  const status = useDebugStore((s) => s.status);
  const store = useDebugStore.getState;
  const active = status === 'running' || status === 'paused' || status === 'attaching';
  const paused = status === 'paused';

  return (
    <div className="dbg-toolbar">
      {!active ? (
        <>
          <button className="dbg-btn" title="Attach to Unity" onClick={() => void store().attach(false)}>
            <Bug size={14} /> Attach
          </button>
          <button className="dbg-btn" title="Attach and Play" onClick={() => void store().attach(true)}>
            <Play size={14} /> Attach + Play
          </button>
        </>
      ) : (
        <>
          <button className="dbg-btn" title="Continue" disabled={!paused} onClick={() => void store().resume()}>
            <Play size={14} />
          </button>
          <button className="dbg-btn" title="Pause" disabled={paused} onClick={() => void store().pause()}>
            <Pause size={14} />
          </button>
          <button className="dbg-btn" title="Step Over" disabled={!paused} onClick={() => void store().stepOver()}>
            <StepForward size={14} />
          </button>
          <button className="dbg-btn" title="Step In" disabled={!paused} onClick={() => void store().stepIn()}>
            <ArrowDownToLine size={14} />
          </button>
          <button className="dbg-btn" title="Step Out" disabled={!paused} onClick={() => void store().stepOut()}>
            <ArrowUpFromLine size={14} />
          </button>
          <button className="dbg-btn dbg-btn--stop" title="Stop" onClick={() => void store().stop()}>
            <Square size={14} />
          </button>
        </>
      )}
      <span className="dbg-status">{status}</span>
    </div>
  );
}
