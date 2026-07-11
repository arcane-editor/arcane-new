import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { fuzzyMatch } from '../../../utils/fuzzy-match';
import { getFileIcon } from '../../../utils/file-icons';
import { useCommandsStore } from '../../../stores/commands';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { isMac as platformIsMac } from '../../../utils/platform';
import { useDebouncedValue } from '../../../hooks/useDebouncedValue';
import { useDelayedTrue } from '../../../hooks/useDelayedTrue';

// The indeterminate loading bar only appears once a file search has been
// running continuously for this long, so the index-backed search (usually
// sub-10ms) never flashes it.
const LOADING_BAR_DELAY_MS = 100;

interface PaletteModalProps {
  initialMode: 'commands' | 'files';
  onClose: () => void;
}

interface FuzzyFileResult {
  path: string;
  relative_path: string;
  file_name: string;
  score: number;
  match_indices: number[];
}

function formatKeybinding(kb: string): string {
  const isMac = platformIsMac();
  return kb
    .split('+')
    .map((part) => {
      const p = part.toLowerCase().trim();
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'shift') return isMac ? '⇧' : 'Shift';
      if (p === 'alt') return isMac ? '⌥' : 'Alt';
      if (p === '`') return '`';
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(isMac ? '' : '+');
}

function highlightMatches(text: string, matchIndices: number[]): React.ReactNode {
  if (matchIndices.length === 0) return text;
  const matchSet = new Set(matchIndices);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < text.length; i++) {
    if (matchSet.has(i)) {
      parts.push(
        <span key={i} className="palette-highlight">
          {text[i]}
        </span>,
      );
    } else {
      parts.push(text[i]);
    }
  }
  return <>{parts}</>;
}

function PaletteModal({ initialMode, onClose }: PaletteModalProps) {
  const getCommands = useCommandsStore((s) => s.getCommands);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openFile = useWorkspaceStore((s) => s.openFile);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);

  const [inputValue, setInputValue] = useState(() =>
    initialMode === 'commands' ? '> ' : '',
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [fileResults, setFileResults] = useState<FuzzyFileResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchGenRef = useRef(0); // prevent stale results

  // Determine current mode from input value
  const isCommandMode = inputValue.startsWith('>');
  const query = isCommandMode ? inputValue.slice(1).trimStart() : inputValue.trim();
  const debouncedFileQuery = useDebouncedValue(query, 150);

  // Build command results (local, synchronous — commands are few)
  const commandResults = useMemo(() => {
    if (!isCommandMode) return [];
    const commands = getCommands();
    if (!query) {
      return commands.map((cmd) => ({ cmd, matches: [] as number[], score: 0 }));
    }
    return commands
      .map((cmd) => {
        const result = fuzzyMatch(query, cmd.label);
        if (!result) return null;
        return { cmd, matches: result.matches, score: result.score };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score);
  }, [isCommandMode, query, getCommands]);

  // Recent files: shown in file mode while the query is empty. Reads
  // `openFiles` from the store directly (not a reactive subscription) so
  // unrelated workspace-store updates (e.g. a background tab open/close)
  // don't re-run this — it only needs a fresh read on mount/mode-change.
  // Also owns clearing results on entry into command mode.
  useEffect(() => {
    // Invalidate any in-flight search before setFileResults, so stale results
    // cannot clobber the cleared or recent-files list.
    searchGenRef.current++;

    if (isCommandMode) {
      setFileResults([]);
      setIsSearching(false);
      return;
    }

    if (debouncedFileQuery) return; // handled by the search effect below

    const { openFiles } = useWorkspaceStore.getState();
    const prefix = workspacePath ? workspacePath + '/' : '';
    const seen = new Set<string>();
    const recentFiles: FuzzyFileResult[] = openFiles
      .filter((f) => {
        if (f.path.startsWith('diff://') || f.path.startsWith('auth://')) return false;
        if (isUnityProject && !f.path.toLowerCase().endsWith('.cs')) return false;
        if (seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
      })
      .slice(0, 10)
      .map((f) => ({
        path: f.path,
        relative_path: prefix ? f.path.replace(prefix, '') : f.path,
        file_name: f.name,
        score: 0,
        match_indices: [],
      }));
    setFileResults(recentFiles);
    setIsSearching(false);
  }, [isCommandMode, debouncedFileQuery, workspacePath, isUnityProject]);

  // File search: async, Rust-backed; debounce comes from useDebouncedValue
  // above. Stale results are intentionally kept on the screen while a new
  // search is in flight (and even if it errors) — only the empty-query and
  // command-mode cases above replace `fileResults` wholesale. This avoids
  // the list flickering to a loading/empty state on every keystroke.
  useEffect(() => {
    if (isCommandMode) return;
    if (!debouncedFileQuery) return; // handled by the recent-files effect above

    setIsSearching(true);
    const gen = ++searchGenRef.current;

    (async () => {
      if (!workspacePath) {
        setIsSearching(false);
        return;
      }

      try {
        const { extraExcludePatterns } = useWorkspaceStore.getState();
        const results = await invoke<FuzzyFileResult[]>('fuzzy_search_files', {
          workspacePath,
          query: debouncedFileQuery,
          maxResults: 100,
          extraExcludes: extraExcludePatterns ?? [],
          fileExtensions: isUnityProject ? ['cs'] : null,
        });

        // Only apply if this is still the latest search
        if (gen === searchGenRef.current) {
          setFileResults(results);
          setIsSearching(false);
        }
      } catch {
        // Keep stale results on error — just stop the loading state.
        if (gen === searchGenRef.current) {
          setIsSearching(false);
        }
      }
    })();
  }, [isCommandMode, debouncedFileQuery, workspacePath, isUnityProject]);

  const totalResults = isCommandMode ? commandResults.length : fileResults.length;
  const showLoadingBar = useDelayedTrue(isSearching, LOADING_BAR_DELAY_MS);

  // Reset selection when results change. `query` (not debounced) changes on
  // every keystroke, so this always snaps back to 0 the instant the user
  // types — even while stale `fileResults` from the prior query are still
  // on screen — which keeps the clamp correct without needing to key off
  // the (intentionally stale-tolerant) results array itself.
  useEffect(() => {
    setSelectedIndex(0);
  }, [totalResults, query, isCommandMode]);

  // Auto-focus input
  useEffect(() => {
    inputRef.current?.focus();
    if (initialMode === 'commands') {
      const len = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(len, len);
    }
  }, [initialMode]);

  // Virtual scrolling
  const rowVirtualizer = useVirtualizer({
    count: totalResults,
    getScrollElement: () => listRef.current,
    estimateSize: () => 32,
    overscan: 5,
  });

  // Scroll selected item into view via virtualizer
  useEffect(() => {
    if (totalResults > 0) {
      rowVirtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
    }
  }, [selectedIndex, totalResults, rowVirtualizer]);

  const handleSelect = useCallback(
    (index: number) => {
      if (isCommandMode) {
        const result = commandResults[index];
        if (result) {
          result.cmd.handler();
          onClose();
        }
      } else {
        const result = fileResults[index];
        if (result) {
          openFile(result.path, result.file_name);
          onClose();
        }
      }
    },
    [isCommandMode, commandResults, fileResults, openFile, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % Math.max(1, totalResults));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => (i - 1 + Math.max(1, totalResults)) % Math.max(1, totalResults));
          break;
        case 'Enter':
          e.preventDefault();
          handleSelect(selectedIndex);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [totalResults, selectedIndex, handleSelect, onClose],
  );

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    setSelectedIndex(0);
  }, []);

  const placeholder = isCommandMode
    ? 'Type a command name...'
    : 'Search files by name...';

  return (
    <div
      className="palette-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--overlay-shadow)',
      }}
    >
      <div
        className="palette-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 600,
          maxWidth: '90vw',
          background: 'var(--bg-primary)',
          border: '1px solid var(--border)',
          boxShadow: 'var(--overlay-shadow)',
          borderRadius: '0 0 6px 6px',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          style={{
            width: '100%',
            padding: '10px 14px',
            background: 'var(--bg-input)',
            border: 'none',
            borderBottom: '1px solid var(--border)',
            color: 'var(--text-primary)',
            fontSize: 14,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div
          ref={listRef}
          className="palette-list"
          style={{
            maxHeight: 350,
            overflowY: 'auto',
            position: 'relative',
          }}
        >
          {/* Zero-height sticky anchor: keeps the loading bar pinned to the
              visible top of the list (not the top of the scrolled content)
              without shifting any row below it — layout-stable loading. */}
          <div className="search-progress-anchor">
            {showLoadingBar && <div className="search-progress-bar" />}
          </div>

          {totalResults > 0 && (
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                const index = virtualItem.index;

                if (isCommandMode) {
                  const result = commandResults[index];
                  if (!result) return null;
                  return (
                    <div
                      key={result.cmd.id}
                      data-index={index}
                      ref={rowVirtualizer.measureElement}
                      className={`palette-item${index === selectedIndex ? ' palette-item-selected' : ''}`}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => handleSelect(index)}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualItem.start}px)`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 14px',
                        cursor: 'pointer',
                        background: index === selectedIndex ? 'var(--hover)' : 'transparent',
                        color: 'var(--text-primary)',
                        fontSize: 13,
                        userSelect: 'none',
                        boxSizing: 'border-box',
                      }}
                    >
                      <span className="palette-item-label">
                        <span style={{ color: 'var(--text-secondary)', marginRight: 4 }}>
                          {result.cmd.category}:
                        </span>
                        {highlightMatches(result.cmd.label, result.matches)}
                      </span>
                      {result.cmd.keybinding && (
                        <span
                          className="palette-keybinding"
                          style={{
                            background: 'var(--badge-bg)',
                            color: 'var(--text-secondary)',
                            padding: '1px 6px',
                            borderRadius: 3,
                            fontSize: 11,
                            fontFamily: 'monospace',
                            whiteSpace: 'nowrap',
                            marginLeft: 12,
                            flexShrink: 0,
                          }}
                        >
                          {formatKeybinding(result.cmd.keybinding)}
                        </span>
                      )}
                    </div>
                  );
                }

                // File mode
                const result = fileResults[index];
                if (!result) return null;
                return (
                  <div
                    key={result.path}
                    data-index={index}
                    ref={rowVirtualizer.measureElement}
                    className={`palette-item${index === selectedIndex ? ' palette-item-selected' : ''}`}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => handleSelect(index)}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualItem.start}px)`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 14px',
                      cursor: 'pointer',
                      background: index === selectedIndex ? 'var(--hover)' : 'transparent',
                      color: 'var(--text-primary)',
                      fontSize: 13,
                      userSelect: 'none',
                      boxSizing: 'border-box',
                    }}
                  >
                    {getFileIcon(result.file_name, 14)}
                    <span style={{ fontWeight: 600, flexShrink: 0 }}>
                      {result.file_name}
                    </span>
                    <span
                      style={{
                        color: 'var(--text-secondary)',
                        fontSize: 12,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {highlightMatches(result.relative_path, result.match_indices)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {isCommandMode
            ? totalResults === 0 && (
                <div
                  style={{
                    padding: '12px 14px',
                    color: 'var(--text-secondary)',
                    fontSize: 13,
                    textAlign: 'center',
                  }}
                >
                  No matching commands
                </div>
              )
            : !isSearching && query && fileResults.length === 0 && (
                <div
                  style={{
                    padding: '12px 14px',
                    color: 'var(--text-secondary)',
                    fontSize: 13,
                    textAlign: 'center',
                  }}
                >
                  No matching files
                </div>
              )}
        </div>
      </div>
    </div>
  );
}

export default PaletteModal;
