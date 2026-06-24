import { useEffect, useRef } from 'react';
import { useWorkspaceStore } from '../stores/workspace';
import { useSettingsStore } from '../stores/settings';

export function useAutoSave() {
  const autoSave = useSettingsStore((s) => s.settings['editor.autoSave']);
  const autoSaveDelay = useSettingsStore((s) => s.settings['editor.autoSaveDelay']);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const prevActiveRef = useRef<string | null>(null);

  // afterDelay mode
  useEffect(() => {
    if (autoSave !== 'afterDelay') return;

    const unsub = useWorkspaceStore.subscribe((state, prevState) => {
      for (const file of state.openFiles) {
        if (file.isDirty && !file.path.startsWith('diff://')) {
          const prevFile = prevState.openFiles.find((f) => f.path === file.path);
          if (!prevFile || prevFile.content !== file.content || !prevFile.isDirty) {
            const existing = timersRef.current.get(file.path);
            if (existing) clearTimeout(existing);

            const timer = setTimeout(() => {
              timersRef.current.delete(file.path);
              useWorkspaceStore.getState().saveFile(file.path).catch((err) => {
                console.warn('[AutoSave] afterDelay save failed:', err);
              });
            }, autoSaveDelay);

            timersRef.current.set(file.path, timer);
          }
        }
      }
    });

    return () => {
      unsub();
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, [autoSave, autoSaveDelay]);

  // onFocusChange mode
  useEffect(() => {
    if (autoSave !== 'onFocusChange') return;

    function saveAllDirty() {
      const { openFiles, saveFile } = useWorkspaceStore.getState();
      for (const file of openFiles) {
        if (file.isDirty && !file.path.startsWith('diff://')) {
          saveFile(file.path).catch((err) => {
            console.warn('[AutoSave] focus-blur save failed:', err);
          });
        }
      }
    }

    window.addEventListener('blur', saveAllDirty);

    const unsub = useWorkspaceStore.subscribe((state) => {
      const prevActive = prevActiveRef.current;
      if (state.activeFilePath !== prevActive && prevActive) {
        const prevFile = state.openFiles.find((f) => f.path === prevActive);
        if (prevFile?.isDirty && !prevActive.startsWith('diff://')) {
          useWorkspaceStore.getState().saveFile(prevActive).catch((err) => {
            console.warn('[AutoSave] focus-change save failed:', err);
          });
        }
      }
      prevActiveRef.current = state.activeFilePath;
    });

    return () => {
      window.removeEventListener('blur', saveAllDirty);
      unsub();
    };
  }, [autoSave]);
}
