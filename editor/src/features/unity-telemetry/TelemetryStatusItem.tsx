import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/settings';
import { useUnityStore } from '../../stores/unity';
import { useTelemetryStore } from './store';

/**
 * Compact play-mode telemetry strip for the status bar (F-4.5): an FPS sparkline
 * + live FPS, with a detail popover (frame time / memory / GC / draw calls).
 * Renders only while playing, the bridge is connected, and the user opted in
 * (`unity.telemetry.enabled`).
 */
export function TelemetryStatusItem() {
  const enabled = useSettingsStore((s) => s.settings['unity.telemetry.enabled']);
  const connected = useUnityStore((s) => s.connected);
  const playState = useUnityStore((s) => s.playState);
  const latest = useTelemetryStore((s) => s.latest);
  const samples = useTelemetryStore((s) => s.samples);
  const [showDetail, setShowDetail] = useState(false);

  useEffect(() => {
    if (playState !== 'Playing') useTelemetryStore.getState().clear();
  }, [playState]);

  if (!enabled || !connected || playState !== 'Playing' || !latest) return null;

  const W = 48;
  const H = 12;
  const fpsVals = samples.map((s) => s.fps);
  const max = Math.max(60, ...fpsVals);
  const pts = fpsVals
    .map((v, i) => `${(i / Math.max(1, fpsVals.length - 1)) * W},${(H - (v / max) * H).toFixed(1)}`)
    .join(' ');

  return (
    <span
      className="status-bar-item clickable"
      onClick={() => setShowDetail((d) => !d)}
      title="Unity play-mode telemetry"
      style={{ position: 'relative', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}
    >
      <svg width={W} height={H} style={{ display: 'block' }} aria-hidden>
        <polyline points={pts} fill="none" stroke="var(--accent, #4ec9b0)" strokeWidth={1} />
      </svg>
      <span>{Math.round(latest.fps)} fps</span>
      {showDetail && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: 6,
            background: 'var(--bg-dropdown, var(--bg-sidebar))',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '8px 10px',
            fontSize: 11,
            lineHeight: 1.6,
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 1000,
            color: 'var(--text-primary)',
          }}
        >
          <div>FPS: {latest.fps.toFixed(1)} ({latest.frameTimeMs.toFixed(1)} ms)</div>
          <div>
            Memory: {latest.totalMemoryMb.toFixed(0)} MB / {latest.reservedMemoryMb.toFixed(0)} MB reserved
          </div>
          <div>GC collections (interval): {latest.gcCollections}</div>
          {latest.drawCalls != null && <div>Draw calls: {latest.drawCalls}</div>}
          <div style={{ color: 'var(--text-secondary)' }}>Frame {latest.frameCount}</div>
        </div>
      )}
    </span>
  );
}

export default TelemetryStatusItem;
