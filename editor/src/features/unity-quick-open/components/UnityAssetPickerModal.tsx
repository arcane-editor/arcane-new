import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getFileIcon } from '../../../utils/file-icons';
import { useWorkspaceStore } from '../../../stores/workspace';

export type UnityPickerMode = 'scene' | 'asset';

interface FuzzyFileResult {
  path: string;
  relative_path: string;
  file_name: string;
}

const EXTENSIONS: Record<UnityPickerMode, string[]> = {
  scene: ['unity'],
  asset: ['prefab', 'asset', 'mat', 'controller', 'anim', 'unity'],
};

const TITLES: Record<UnityPickerMode, string> = {
  scene: 'Open Scene',
  asset: 'Find Asset',
};

interface Props {
  mode: UnityPickerMode;
  onClose: () => void;
}

/**
 * A lightweight fuzzy picker for Unity scenes/assets. Unity quick-open (Cmd+P)
 * is .cs-only, so scenes and assets are otherwise unreachable from the palette —
 * this fills that gap for the "Unity: Open Scene…" / "Unity: Find Asset…" verbs.
 */
export function UnityAssetPickerModal({ mode, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FuzzyFileResult[]>([]);
  const [selected, setSelected] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ws = useWorkspaceStore.getState().workspacePath;
    if (!ws) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await invoke<FuzzyFileResult[]>('fuzzy_search_files', {
          workspacePath: ws,
          query,
          limit: 50,
          fileExtensions: EXTENSIONS[mode],
        });
        setResults(res);
        setSelected(0);
      } catch {
        setResults([]);
      }
    }, 120);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, mode]);

  function open(r: FuzzyFileResult) {
    void useWorkspaceStore.getState().openFile(r.path, r.file_name);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[selected];
      if (r) open(r);
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder={`${TITLES[mode]}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <div className="palette-list">
          {query && results.length === 0 && (
            <div className="palette-empty" style={{ padding: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
              No {mode === 'scene' ? 'scenes' : 'assets'} found.
            </div>
          )}
          {!query && (
            <div className="palette-empty" style={{ padding: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
              Type to search {mode === 'scene' ? 'scenes' : 'assets'}…
            </div>
          )}
          {results.map((r, i) => (
            <div
              key={r.path}
              className={`palette-item${i === selected ? ' selected' : ''}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => open(r)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                cursor: 'pointer',
                background: i === selected ? 'var(--hover)' : 'transparent',
              }}
            >
              <span style={{ flexShrink: 0 }}>{getFileIcon(r.file_name, 14)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.file_name}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  color: 'var(--text-secondary)',
                  fontSize: 11,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {r.relative_path}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default UnityAssetPickerModal;
