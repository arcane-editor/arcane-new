// Unity play-mode telemetry (F-4.5) — opt-in FPS/memory/GC strip in the status
// bar, fed by the bridge's `playmode_stats` stream (≤4Hz while playing).
export { TelemetryStatusItem } from './TelemetryStatusItem';
export { initUnityTelemetry } from './store';
