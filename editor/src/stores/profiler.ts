import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from './workspace';
import { useDebugStore } from './debug';
import type { CaptureMetadata, ProfilerCapabilities, ProfilerFrame, ProfilerQuery, ProfilerStatus } from '../types/profiler';

const rpc = <T>(method: string, params: Record<string, unknown> = {}) => invoke<T>('unity_ipc_request', { method, params, timeoutMs: 15000 });
interface ProfilerState {
  capabilities: ProfilerCapabilities | null; target: number | null; captures: CaptureMetadata[];
  captureId: string | null; frames: ProfilerFrame[]; frame: number | null; thread: number;
  data: ProfilerQuery | null; search: string; offset: number; following: boolean;
  recording: boolean; saving: boolean; busy: boolean; error: string | null; status: ProfilerStatus | null;
  connect: () => Promise<void>; refreshCaptures: () => Promise<void>; start: () => Promise<void>; stop: () => Promise<void>;
  selectCapture: (id: string) => Promise<void>; selectFrame: (frame: number, follow?: boolean) => Promise<void>;
  query: () => Promise<void>;
}
let timer: ReturnType<typeof setTimeout> | undefined;
let requestGeneration = 0;
let activeWorkspace: string | null = null;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
export const useProfilerStore = create<ProfilerState>((set, get) => ({
  capabilities: null, target: null, captures: [], captureId: null, frames: [], frame: null, thread: 0, data: null,
  search: '', offset: 0, following: true, recording: false, saving: false, busy: false, error: null, status: null,
  connect: async () => {
    set({ busy: true, error: null });
    try {
      if (useDebugStore.getState().status === 'paused') throw new Error('Resume the debugger before contacting Unity.');
      const capabilities = await rpc<ProfilerCapabilities>('getProfilerCapabilities');
      set({ capabilities, target: capabilities.selectedTarget });
      const status = await rpc<ProfilerStatus>('getProfilerStatus');
      if (status.captureId && (status.recording || status.saving || status.chunks.length)) {
        await get().refreshCaptures();
        if (!get().captures.some(c => c.id === status.captureId)) await invoke('profiler_create', { captureId: status.captureId, metadata: status.metadata });
        activeWorkspace = useWorkspaceStore.getState().workspacePath;
        set({ captureId: status.captureId, status, recording: status.recording, saving: status.saving || status.chunks.length > 0 });
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void poll(), 250);
      }
    }
    catch (e) { set({ error: `Connect Unity with the updated UnityIDE integration to record. ${errorText(e)}` }); }
    finally { set({ busy: false }); }
  },
  refreshCaptures: async () => { try { set({ captures: await invoke<CaptureMetadata[]>('profiler_list') }); } catch (e) { set({ error: errorText(e) }); } },
  start: async () => {
    if (get().busy || get().recording || get().saving) return;
    if (useDebugStore.getState().status === 'paused') { set({ error: 'Resume the debugger before recording Unity.' }); return; }
    const workspacePath = useWorkspaceStore.getState().workspacePath;
    if (!workspacePath || get().target == null) return;
    set({ busy: true, error: null });
    let started = false;
    try {
      const status = await rpc<ProfilerStatus>('startProfilerCapture', { target: get().target, limitBytes: 2 * 1024 ** 3 });
      started = true;
      await invoke('profiler_create', { captureId: status.captureId, metadata: status.metadata });
      activeWorkspace = workspacePath;
      set({ status, captureId: status.captureId, recording: true, saving: false, frames: [], frame: null, data: null, following: true });
      await get().refreshCaptures();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), 250);
    } catch (e) { if (started) await rpc('stopProfilerCapture').catch(() => {}); set({ error: errorText(e) }); }
    finally { set({ busy: false }); }
  },
  stop: async () => {
    if (useDebugStore.getState().status === 'paused') { set({ error: 'Resume the debugger before stopping the Unity capture.' }); return; }
    set({ busy: true });
    try { const status = await rpc<ProfilerStatus>('stopProfilerCapture'); set({ status, recording: false, saving: true }); }
    catch (e) { set({ error: errorText(e) }); }
    finally { set({ busy: false }); }
  },
  selectCapture: async (captureId) => {
    if (get().recording || get().saving) return;
    ++requestGeneration;
    set({ captureId, frame: null, data: null, error: null, offset: 0 });
    try {
      const frames = await invoke<ProfilerFrame[]>('profiler_frames', { captureId });
      if (get().captureId !== captureId) return;
      set({ frames }); if (frames[0]) await get().selectFrame(frames[0].frame);
    } catch (e) { set({ error: errorText(e) }); }
  },
  selectFrame: async (frame, following = false) => { set({ frame, following, offset: 0 }); await get().query(); },
  query: async () => {
    const { captureId, frame, thread, search, offset } = get(); if (!captureId || frame == null) return;
    const generation = ++requestGeneration;
    try {
      const data = await invoke<ProfilerQuery>('profiler_query', { captureId, frame, thread, search, offset });
      if (generation === requestGeneration) set({ data });
    } catch (e) { if (generation === requestGeneration) set({ error: errorText(e) }); }
  },
}));
async function poll(): Promise<void> {
  const store = useProfilerStore;
  try {
    if (useWorkspaceStore.getState().workspacePath !== activeWorkspace) throw new Error('Project changed. Completed capture data remains available.');
    // Unity cannot service bridge RPC while its managed main thread is suspended.
    if (useDebugStore.getState().status === 'paused') { timer = setTimeout(() => void poll(), 500); return; }
    const status = await rpc<ProfilerStatus>('getProfilerStatus');
    const captureId = store.getState().captureId;
    if (status.captureId !== captureId) throw new Error('Unity capture ended or changed. Completed data is preserved.');
    if (status.chunks.length) {
      await invoke('profiler_ingest', { workspacePath: activeWorkspace, captureId, chunks: status.chunks });
      await rpc('ackProfilerChunks', { captureId, chunks: status.chunks });
    }
    store.setState({ status, recording: status.recording, saving: status.saving || status.chunks.length > 0, error: status.error || null });
    const frames = await invoke<ProfilerFrame[]>('profiler_frames', { captureId });
    store.setState({ frames });
    if (store.getState().following && frames[0]) await store.getState().selectFrame(frames[0].frame, true);
    else if (status.chunks.length) await store.getState().query();
    if (status.recording || status.saving || status.chunks.length) timer = setTimeout(() => void poll(), 250);
    else { store.setState({ saving: false }); await store.getState().refreshCaptures(); }
  } catch (e) {
    store.setState({ recording: false, saving: false, error: `Capture interrupted: ${errorText(e)}` });
    // Best-effort release; completed chunks and the SQLite capture are retained.
    if (useWorkspaceStore.getState().workspacePath === activeWorkspace) await rpc('stopProfilerCapture').catch(() => {});
  }
}
