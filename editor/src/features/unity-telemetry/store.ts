import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import type { PlayModeStats } from '../../types/unity';

const MAX_SAMPLES = 60; // ~15s of history at 4Hz

interface TelemetryState {
  samples: PlayModeStats[];
  latest: PlayModeStats | null;
  push: (s: PlayModeStats) => void;
  clear: () => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  samples: [],
  latest: null,
  push: (s) =>
    set((state) => {
      const samples = [...state.samples, s];
      return { samples: samples.length > MAX_SAMPLES ? samples.slice(-MAX_SAMPLES) : samples, latest: s };
    }),
  clear: () => set({ samples: [], latest: null }),
}));

let initialized = false;

/** Wire the `unity-playmode-stats` stream into the telemetry store. Idempotent. */
export function initUnityTelemetry(): void {
  if (initialized) return;
  initialized = true;
  listen<PlayModeStats>('unity-playmode-stats', (e) => {
    useTelemetryStore.getState().push(e.payload);
  }).catch(() => {
    initialized = false;
  });
}
