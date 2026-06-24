import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { GitBranch, Check } from 'lucide-react';
import { fuzzyMatch } from '../../../utils/fuzzy-match';
import { useGitStore } from '../../../stores/git';
import { useWorkspaceStore } from '../../../stores/workspace';

function highlightMatches(text: string, matchIndices: number[]): React.ReactNode {
  if (matchIndices.length === 0) return text;
  const matchSet = new Set(matchIndices);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < text.length; i++) {
    if (matchSet.has(i)) {
      parts.push(<span key={i} className="palette-highlight">{text[i]}</span>);
    } else {
      parts.push(text[i]);
    }
  }
  return <>{parts}</>;
}

function BranchPicker({ onClose }: { onClose: () => void }) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const branches = useGitStore((s) => s.branches);
  const currentBranch = useGitStore((s) => s.branch);
  const switchBranch = useGitStore((s) => s.switchBranch);
  const refreshBranches = useGitStore((s) => s.refreshBranches);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (workspacePath) refreshBranches(workspacePath);
  }, [workspacePath, refreshBranches]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    if (!query.trim()) {
      return branches.map((b) => ({ name: b, matches: [] as number[], score: 0 }))
        .sort((a, b) => (a.name === currentBranch ? -1 : b.name === currentBranch ? 1 : 0));
    }
    return branches
      .map((b) => {
        const result = fuzzyMatch(query, b);
        if (!result) return null;
        return { name: b, matches: result.matches, score: result.score };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score);
  }, [query, branches, currentBranch]);

  useEffect(() => { setSelectedIndex(0); }, [query]);

  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelect = useCallback(async (index: number) => {
    const result = results[index];
    if (!result || !workspacePath) return;
    if (result.name !== currentBranch) {
      try { await switchBranch(workspacePath, result.name); } catch (e) { console.error(e); }
    }
    onClose();
  }, [results, workspacePath, currentBranch, switchBranch, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setSelectedIndex((i) => (i + 1) % Math.max(1, results.length)); break;
      case 'ArrowUp': e.preventDefault(); setSelectedIndex((i) => (i - 1 + Math.max(1, results.length)) % Math.max(1, results.length)); break;
      case 'Enter': e.preventDefault(); handleSelect(selectedIndex); break;
      case 'Escape': e.preventDefault(); onClose(); break;
    }
  }, [results.length, selectedIndex, handleSelect, onClose]);

  return (
    <div className="palette-overlay" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--overlay-shadow)' }}>
      <div className="palette-panel" onClick={(e) => e.stopPropagation()}
        style={{ position: 'fixed', top: 0, left: '50%', transform: 'translateX(-50%)', width: 500, maxWidth: '90vw', background: 'var(--bg-primary)', border: '1px solid var(--border)', boxShadow: 'var(--overlay-shadow)', borderRadius: '0 0 6px 6px', overflow: 'hidden' }}>
        <input ref={inputRef} type="text" value={query}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={handleKeyDown}
          placeholder="Switch to branch..."
          style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-input)', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
        <div ref={listRef} style={{ maxHeight: 350, overflowY: 'auto' }}>
          {results.map((result, index) => (
            <div key={result.name} data-index={index}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => handleSelect(index)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', cursor: 'pointer', background: index === selectedIndex ? 'var(--hover)' : 'transparent', color: 'var(--text-primary)', fontSize: 13, userSelect: 'none' }}>
              <GitBranch size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{highlightMatches(result.name, result.matches)}</span>
              {result.name === currentBranch && <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
            </div>
          ))}
          {results.length === 0 && (
            <div style={{ padding: '12px 14px', color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center' }}>
              No matching branches
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default BranchPicker;
