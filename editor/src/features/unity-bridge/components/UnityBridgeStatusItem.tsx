import { useEffect, useRef, useState } from 'react';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUnityStore } from '../../../stores/unity';

const LABELS: Record<string, string> = {
  connected: 'Unity bridge connected',
  reloading: 'Unity reloading…',
  'not-installed': 'Unity bridge not installed',
  disconnected: 'Unity bridge disconnected',
};

/** Matches the ripple keyframe duration in App.css. */
const RIPPLE_MS = 900;

/**
 * Status-bar indicator for the Unity editor bridge.
 *
 * The connect moment is the one worth animating: it's the signal that the
 * editor now has a live Unity on the other end, and it arrives asynchronously
 * — often while the user is looking somewhere else entirely. So connecting
 * fires a one-shot ripple that draws the eye, and the steady state settles
 * into a slow breathing glow that reads as "alive" without pulling focus.
 *
 * `reloading` (domain reload / recompile) gets its own amber pulse rather than
 * falling back to the disconnected grey, because the connection is expected to
 * come back on its own and a grey dot would read as a failure.
 */
export function UnityBridgeStatusItem() {
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const unityVersion = useProjectContextStore((s) => s.unityVersion);
  const bridgeState = useUnityStore((s) => s.bridgeState);

  const [rippling, setRippling] = useState(false);
  const previousState = useRef(bridgeState);

  useEffect(() => {
    const wasConnected = previousState.current === 'connected';
    previousState.current = bridgeState;

    // Only the rising edge into `connected` ripples — a re-render that leaves
    // the state alone must not retrigger it. Coming back from `reloading` does
    // count: a domain reload really did drop the connection, and "Unity is back"
    // is precisely the moment worth surfacing.
    if (bridgeState !== 'connected' || wasConnected) return;

    setRippling(true);
    const timer = setTimeout(() => setRippling(false), RIPPLE_MS);
    return () => clearTimeout(timer);
  }, [bridgeState]);

  if (!isUnityProject) return null;

  return (
    <span className="status-bar-item" title={LABELS[bridgeState] ?? LABELS.disconnected}>
      <span className="icon">
        <span
          className={`unity-bridge-dot unity-bridge-dot--${bridgeState}${
            rippling ? ' unity-bridge-dot--just-connected' : ''
          }`}
          aria-hidden
        />
      </span>
      <span>{unityVersion ? `Unity ${unityVersion}` : 'Unity'}</span>
    </span>
  );
}
