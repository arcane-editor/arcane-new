import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useGitStore } from '../../../stores/git';
import { useWorkspaceStore } from '../../../stores/workspace';

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : p;
}
function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function AddWorktreeDialog({ onClose }: { onClose: () => void }) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const branches = useGitStore((s) => s.branches);
  const refreshBranches = useGitStore((s) => s.refreshBranches);
  const addWorktree = useGitStore((s) => s.addWorktree);

  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [path, setPath] = useState('');
  const [branch, setBranch] = useState(branches[0] ?? '');
  const [newBranch, setNewBranch] = useState('');
  const [from, setFrom] = useState(branches[0] ?? '');
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (workspacePath) refreshBranches(workspacePath);
    inputRef.current?.focus();
  }, [workspacePath, refreshBranches]);

  useEffect(() => {
    if (!branch && branches[0]) setBranch(branches[0]);
    if (!from && branches[0]) setFrom(branches[0]);
  }, [branches, branch, from]);

  useEffect(() => {
    if (path || !workspacePath) return;
    const slug = (mode === 'new' ? newBranch : branch).replace(/[^A-Za-z0-9._-]+/g, '-') || 'wt';
    setPath(`${dirname(workspacePath)}/${basename(workspacePath)}-${slug}`);
  }, [workspacePath, mode, branch, newBranch, path]);

  async function browse() {
    const sel = await open({ directory: true, multiple: false, defaultPath: dirname(workspacePath ?? '') });
    if (typeof sel === 'string') setPath(sel);
  }

  async function submit() {
    if (!workspacePath || !path.trim()) return;
    if (mode === 'new' && !newBranch.trim()) return;
    setBusy(true);
    try {
      await addWorktree(workspacePath, {
        path: path.trim(),
        branch: mode === 'existing' ? branch : (from || undefined),
        newBranch: mode === 'new' ? newBranch.trim() : undefined,
        force,
      });
      onClose();
    } catch {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  }

  return (
    <div className="palette-overlay" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--overlay-shadow)' }}>
      <div className="palette-panel" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}
        style={{ position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', width: 520, maxWidth: '92vw', background: 'var(--bg-primary)', border: '1px solid var(--border)', boxShadow: 'var(--overlay-shadow)', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          Add Worktree
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Path</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input ref={inputRef} type="text" value={path} onChange={(e) => setPath(e.target.value)}
                placeholder="/absolute/path/to/worktree"
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                style={{ flex: 1, padding: '8px 10px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 13, outline: 'none' }} />
              <button onClick={browse}
                style={{ padding: '8px 12px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 }}>
                Browse
              </button>
            </div>
          </label>

          <div style={{ display: 'flex', gap: 18, fontSize: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text-primary)' }}>
              <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Existing branch
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--text-primary)' }}>
              <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> Create new branch
            </label>
          </div>

          {mode === 'existing' ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Branch</span>
              <select value={branch} onChange={(e) => setBranch(e.target.value)}
                style={{ padding: '8px 10px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 13 }}>
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
          ) : (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>New branch name</span>
                <input type="text" value={newBranch} onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="feature/x"
                  autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  style={{ padding: '8px 10px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 13, outline: 'none' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>From</span>
                <select value={from} onChange={(e) => setFrom(e.target.value)}
                  style={{ padding: '8px 10px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 13 }}>
                  {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
            </>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Force (use existing directory)
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
          <button onClick={onClose}
            style={{ padding: '6px 14px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 }}>
            Cancel
          </button>
          <button onClick={submit} disabled={busy || !path.trim() || (mode === 'new' && !newBranch.trim())}
            style={{ padding: '6px 14px', background: 'var(--accent)', border: 'none', borderRadius: 4, color: 'var(--bg-primary)', cursor: 'pointer', fontSize: 12, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Adding…' : 'Add Worktree'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AddWorktreeDialog;
