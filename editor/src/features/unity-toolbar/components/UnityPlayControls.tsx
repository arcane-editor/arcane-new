import { Play, Pause, RefreshCw, Loader2 } from 'lucide-react';
import { useUnityStore } from '../../../stores/unity';

function UnityPlayControls() {
  const connected = useUnityStore((s) => s.connected);
  const playState = useUnityStore((s) => s.playState);
  const isCompiling = useUnityStore((s) => s.isCompiling);
  const sendPlay = useUnityStore((s) => s.sendPlay);
  const sendPause = useUnityStore((s) => s.sendPause);
  const sendStop = useUnityStore((s) => s.sendStop);

  const disabled = !connected || isCompiling;

  const btnStyle = (active?: boolean): React.CSSProperties => ({
    background: active ? 'var(--hover)' : 'transparent',
    border: 'none',
    color: disabled ? 'var(--text-secondary)' : 'var(--text-primary)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    padding: '4px 8px',
    borderRadius: 3,
    display: 'flex',
    alignItems: 'center',
    opacity: disabled ? 0.5 : 1,
    transition: 'opacity 150ms ease, background 150ms ease',
  });

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 2,
    }}>
      {isCompiling && (
        <span style={{ color: 'var(--warning)', display: 'flex', alignItems: 'center', padding: '0 4px' }}>
          <Loader2 size={12} className="animate-spin" />
        </span>
      )}

      <button
        title={playState === 'Playing' ? 'Stop (Ctrl+Shift+F10)' : 'Play (Ctrl+Shift+F5)'}
        onClick={playState === 'Playing' ? sendStop : sendPlay}
        disabled={disabled}
        style={btnStyle(playState === 'Playing')}
      >
        <Play size={14} />
      </button>

      <button
        title="Pause (Ctrl+Shift+F6)"
        onClick={sendPause}
        disabled={disabled || playState === 'Stopped'}
        style={btnStyle(playState === 'Paused')}
      >
        <Pause size={14} />
      </button>

      <button
        title="Restart"
        onClick={() => { sendStop(); setTimeout(sendPlay, 100); }}
        disabled={disabled}
        style={btnStyle()}
      >
        <RefreshCw size={14} />
      </button>
    </div>
  );
}

export default UnityPlayControls;
