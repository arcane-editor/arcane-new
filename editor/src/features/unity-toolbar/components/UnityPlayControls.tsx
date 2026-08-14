import { Play, Pause, RotateCcw, Square } from 'lucide-react';
import Tooltip from '../../../components/Tooltip';
import { useUnityStore } from '../../../stores/unity';

/**
 * The transport. Three buttons in one recessed well in the title bar, styled
 * from `.unity-deck__*` in App.css rather than inline: these sit next to the
 * connection segment inside the same capsule, and two style sources for one
 * object is how they drifted apart in the first place.
 */
function UnityPlayControls() {
  const connected = useUnityStore((s) => s.connected);
  const playState = useUnityStore((s) => s.playState);
  const isCompiling = useUnityStore((s) => s.isCompiling);
  const sendPlay = useUnityStore((s) => s.sendPlay);
  const sendPause = useUnityStore((s) => s.sendPause);
  const sendStop = useUnityStore((s) => s.sendStop);

  const disabled = !connected || isCompiling;
  const playing = playState === 'Playing';
  const paused = playState === 'Paused';

  return (
    <div className="unity-deck__transport">
      {/* One button, two jobs — so it has to carry two glyphs. It ran Stop
          while still showing ▶, which reads as "not playing" at exactly the
          moment the game is running. */}
      <Tooltip label={playing ? 'Stop' : 'Play'} commandId={playing ? 'unity.stop' : 'unity.play'} side="bottom">
        <button
          className={`unity-deck__btn${playing ? ' unity-deck__btn--live' : ''}`}
          onClick={playing ? sendStop : sendPlay}
          disabled={disabled}
          aria-label={playing ? 'Stop' : 'Play'}
        >
          {playing ? <Square size={12} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
        </button>
      </Tooltip>

      <Tooltip label="Pause" commandId="unity.pause" side="bottom">
        <button
          className={`unity-deck__btn${paused ? ' unity-deck__btn--active' : ''}`}
          onClick={sendPause}
          disabled={disabled || playState === 'Stopped'}
          aria-label="Pause"
          aria-pressed={paused}
        >
          <Pause size={13} fill="currentColor" />
        </button>
      </Tooltip>

      <Tooltip label="Restart" side="bottom">
        <button
          className="unity-deck__btn"
          onClick={() => { sendStop(); setTimeout(sendPlay, 100); }}
          disabled={disabled}
          aria-label="Restart"
        >
          <RotateCcw size={13} />
        </button>
      </Tooltip>
    </div>
  );
}

export default UnityPlayControls;
