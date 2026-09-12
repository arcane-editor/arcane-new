import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../stores/workspace';
import { notify } from '../stores/notifications';

/** A conflict survives toast dismissal and autosave; only an explicit action resolves it. */
export function SaveConflictBanner() {
  const file = useWorkspaceStore((s) => s.openFiles.find((f) => f.path === s.activeFilePath));
  const path = file?.saveConflict ? file.path : null;
  const [disk, setDisk] = useState<{ path: string; text: string } | null>(null);
  const [readVersion, refreshDisk] = useState(0);
  useEffect(() => {
    setDisk(null);
    if (!path) return;
    let cancelled = false;
    void invoke<{ text: string | null }>('read_file_checked', { path }).then((read) => {
      if (!cancelled && typeof read.text === 'string') setDisk({ path, text: read.text });
    }).catch((err) => { if (!cancelled) notify.error(`Cannot read the conflicting file: ${String(err)}`); });
    return () => { cancelled = true; };
  }, [path, readVersion]);
  if (!path || !file) return null;
  const ready = disk?.path === path;
  const compare = () => {
    if (!ready) return;
    const tabPath = `diff://conflict/${path}`;
    useWorkspaceStore.setState((state) => ({
      openFiles: [...state.openFiles.filter((f) => f.path !== tabPath), {
        path: tabPath, name: `${file.name}: disk ↔ unsaved`, content: '', isDirty: false,
        diff: { originalContent: disk.text, modifiedContent: file.content, filePath: path, staged: false },
      }],
      activeFilePath: tabPath,
    }));
  };
  const overwrite = () => {
    if (!ready) return;
    // Permission applies only to the version offered here. A further external
    // change is caught by the native compare-before-replace check again.
    useWorkspaceStore.setState((state) => ({ openFiles: state.openFiles.map((f) => f.path === path
      ? { ...f, diskContent: disk.text, saveConflict: false } : f) }));
    setDisk(null);
    void useWorkspaceStore.getState().saveFile(path).catch(() => {})
      .finally(() => refreshDisk((version) => version + 1));
  };
  return <div role="alert" style={{ padding: 8, background: 'var(--bg-primary)', color: 'var(--text-primary)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
    <span>{file.name} changed on disk. Your unsaved edits are preserved.</span>
    <button disabled={!ready} onClick={compare}>Compare</button>
    <button disabled={!ready} onClick={overwrite}>Overwrite disk version</button>
    <button onClick={() => refreshDisk((version) => version + 1)}>Refresh disk version</button>
    <button onClick={() => void useWorkspaceStore.getState().reloadFileFromDisk(path)}>Discard edits and reload</button>
  </div>;
}
