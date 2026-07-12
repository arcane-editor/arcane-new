import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Minus,
  Folder,
  Lock,
  Undo2,
  RefreshCw,
  ArrowDown,
  ArrowUp,
  X,
  ExternalLink,
  GitCommitHorizontal,
  AlertTriangle,
  Download,
} from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useGitStore, type GitFileStatus } from '../../../stores/git';
import type { GitLogEntry, CommitFileChange } from '../../../types';
import { useProjectContextStore } from '../../../stores/project-context';
import { formatRelativeDate } from '../../../utils/date';
import { canCommit } from '../../../utils/commit-gating';
import { getFileIcon } from '../../../utils/file-icons';
import AddWorktreeDialog from './AddWorktreeDialog';
import { openProjectInNewWindow } from '../../project';
import {
  findMetaPairingViolations,
  metaPairingChecksEnabled,
  type MetaPairingViolation,
} from '../services/unity-git';

const UNITY_YAML_EXTS = ['.unity', '.prefab', '.asset', '.mat', '.anim', '.controller'];
function isUnityYaml(path: string): boolean {
  const l = path.toLowerCase();
  return UNITY_YAML_EXTS.some((e) => l.endsWith(e));
}

function statusLabel(status: string): string {
  switch (status) {
    case 'modified': return 'M';
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'untracked': return 'U';
    case 'renamed': return 'R';
    default: return '?';
  }
}


function FileItem({
  file,
  onStage,
  onUnstage,
  onDiscard,
  onClick,
}: {
  file: GitFileStatus;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  onClick?: () => void;
}) {
  const fileName = file.path.split('/').pop() || file.path;
  const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

  return (
    <div className="scm-file-item" onClick={onClick}>
      <span className="icon" style={{ flexShrink: 0, display: 'flex' }}>
        {getFileIcon(fileName, 14)}
      </span>
      <span className="scm-file-name">
        {fileName}
        {dirPath && <span className="scm-file-path">{dirPath}</span>}
      </span>
      <div className="scm-file-actions">
        {file.staged ? (
          <button className="scm-file-action-btn" title="Unstage" onClick={(e) => { e.stopPropagation(); onUnstage?.(); }}>
            <Minus size={14} />
          </button>
        ) : (
          <>
            {onDiscard && (
              <button className="scm-file-action-btn" title="Discard Changes" onClick={(e) => { e.stopPropagation(); onDiscard(); }}>
                <Undo2 size={14} />
              </button>
            )}
            <button className="scm-file-action-btn" title="Stage" onClick={(e) => { e.stopPropagation(); onStage?.(); }}>
              <Plus size={14} />
            </button>
          </>
        )}
      </div>
      <span className={`scm-file-status ${file.status}`}>
        {statusLabel(file.status)}
      </span>
    </div>
  );
}

function SourceControlPanel() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const openDiffTab = useWorkspaceStore((s) => s.openDiffTab);
  const openCommitDiffTab = useWorkspaceStore((s) => s.openCommitDiffTab);
  const stagedFiles = useGitStore((s) => s.stagedFiles);
  const unstagedFiles = useGitStore((s) => s.unstagedFiles);
  const refreshStatus = useGitStore((s) => s.refreshStatus);
  const refreshBranches = useGitStore((s) => s.refreshBranches);
  const isLoading = useGitStore((s) => s.isLoading);
  const commitMessage = useGitStore((s) => s.commitMessage);
  const setCommitMessage = useGitStore((s) => s.setCommitMessage);
  const amendMode = useGitStore((s) => s.amendMode);
  const setAmendMode = useGitStore((s) => s.setAmendMode);
  const commit = useGitStore((s) => s.commit);
  const stageFile = useGitStore((s) => s.stageFile);
  const unstageFile = useGitStore((s) => s.unstageFile);
  const stageAll = useGitStore((s) => s.stageAll);
  const unstageAll = useGitStore((s) => s.unstageAll);
  const discardFile = useGitStore((s) => s.discardFile);
  const discardAll = useGitStore((s) => s.discardAll);
  const isGitRepo = useGitStore((s) => s.isGitRepo);
  const ahead = useGitStore((s) => s.ahead);
  const behind = useGitStore((s) => s.behind);
  const isRemoteLoading = useGitStore((s) => s.isRemoteLoading);
  const lastError = useGitStore((s) => s.lastError);
  const clearError = useGitStore((s) => s.clearError);
  const fetchGit = useGitStore((s) => s.fetch);
  const pull = useGitStore((s) => s.pull);
  const push = useGitStore((s) => s.push);
  const commitLog = useGitStore((s) => s.commitLog);
  const commitDetails = useGitStore((s) => s.commitDetails);
  const getCommitDetail = useGitStore((s) => s.getCommitDetail);
  const worktrees = useGitStore((s) => s.worktrees);
  const refreshWorktrees = useGitStore((s) => s.refreshWorktrees);
  const removeWorktree = useGitStore((s) => s.removeWorktree);
  const stashes = useGitStore((s) => s.stashes);
  const refreshStashes = useGitStore((s) => s.refreshStashes);
  const stashPush = useGitStore((s) => s.stashPush);
  const stashApply = useGitStore((s) => s.stashApply);
  const stashPop = useGitStore((s) => s.stashPop);
  const stashDrop = useGitStore((s) => s.stashDrop);
  const runUnityYamlMerge = useGitStore((s) => s.runUnityYamlMerge);
  const resolveConflictSide = useGitStore((s) => s.resolveConflictSide);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const unityYamlMergePath = useProjectContextStore((s) => s.unityYamlMergePath);

  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [conflictsOpen, setConflictsOpen] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(true);
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [stashesOpen, setStashesOpen] = useState(false);
  const [showAddWorktree, setShowAddWorktree] = useState(false);
  const [metaWarning, setMetaWarning] = useState<MetaPairingViolation[] | null>(null);
  const [expandedCommits, setExpandedCommits] = useState<Set<string>>(new Set());

  // Conflicted (unmerged) files surface from either array; dedup by path.
  const conflictedFiles = (() => {
    const seen = new Set<string>();
    const out: GitFileStatus[] = [];
    for (const f of [...unstagedFiles, ...stagedFiles]) {
      if (f.conflicted && !seen.has(f.path)) {
        seen.add(f.path);
        out.push(f);
      }
    }
    return out;
  })();

  useEffect(() => {
    if (workspacePath && isGitRepo) {
      refreshStatus(workspacePath);
      refreshWorktrees(workspacePath);
      refreshStashes(workspacePath);
    }
  }, [workspacePath, isGitRepo, refreshStatus, refreshWorktrees, refreshStashes]);

  async function handleRemoveWorktree(path: string) {
    if (!workspacePath) return;
    try {
      await removeWorktree(workspacePath, path, false);
    } catch (err) {
      const msg = String(err ?? '');
      if (msg.toLowerCase().includes('contains modified or untracked')
        || msg.toLowerCase().includes('use --force')
        || msg.toLowerCase().includes('is dirty')) {
        if (confirm('Worktree has uncommitted changes. Force remove?')) {
          try { await removeWorktree(workspacePath, path, true); } catch { /* notify already raised */ }
        }
      }
    }
  }

  if (!isGitRepo) {
    return (
      <div className="sidebar">
        <div className="sidebar-header">Source Control</div>
        <div className="sidebar-empty">
          The folder is not a git repository
        </div>
      </div>
    );
  }

  async function doCommit() {
    if (!workspacePath) return;
    setMetaWarning(null);
    try {
      await commit(workspacePath);
    } catch (err) {
      console.error('[Git] Commit failed:', err);
    }
  }

  async function handleCommit() {
    if (!workspacePath) return;
    // Block-by-default when a staged asset/.meta is missing its paired half.
    if (isUnityProject && metaPairingChecksEnabled()) {
      const violations = findMetaPairingViolations(stagedFiles, unstagedFiles);
      if (violations.length > 0) {
        setMetaWarning(violations);
        return;
      }
    }
    await doCommit();
  }

  async function stagePairedAndCommit() {
    if (!workspacePath || !metaWarning) return;
    const pairs = Array.from(new Set(metaWarning.map((v) => v.missingPair)));
    for (const p of pairs) {
      try {
        await stageFile(workspacePath, p);
      } catch {
        /* keep going */
      }
    }
    await doCommit();
  }

  function handleFileClick(file: GitFileStatus) {
    const fileName = file.path.split('/').pop() || file.path;
    openDiffTab(file.path, fileName, file.staged);
  }

  function toggleCommit(hash: string) {
    setExpandedCommits((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
        if (workspacePath) getCommitDetail(workspacePath, hash);
      }
      return next;
    });
  }

  function handleCommitFileClick(entry: GitLogEntry, file: CommitFileChange) {
    const fileName = file.path.split('/').pop() || file.path;
    openCommitDiffTab(entry.hash, file.path, `${fileName} @ ${entry.hash.slice(0, 7)}`);
  }

  return (
    <div className="scm-panel">
      <div className="sidebar-header">Source Control</div>

      {/* Sync toolbar */}
      <div className="scm-toolbar">
        <button
          className={`scm-toolbar-btn${isLoading ? ' loading' : ''}`}
          title="Refresh"
          disabled={isLoading}
          onClick={() => {
            if (!workspacePath) return;
            refreshStatus(workspacePath);
            refreshBranches(workspacePath);
          }}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className={`scm-toolbar-btn${isRemoteLoading ? ' loading' : ''}`}
          title="Fetch"
          disabled={isRemoteLoading}
          onClick={() => workspacePath && fetchGit(workspacePath)}
        >
          <Download size={14} />
        </button>
        <button
          className="scm-toolbar-btn"
          title={`Pull${behind > 0 ? ` (${behind} behind)` : ''}`}
          disabled={isRemoteLoading}
          onClick={() => workspacePath && pull(workspacePath)}
        >
          <ArrowDown size={14} />
          {behind > 0 && <span className="scm-toolbar-badge">{behind}</span>}
        </button>
        <button
          className="scm-toolbar-btn"
          title={`Push${ahead > 0 ? ` (${ahead} ahead)` : ''}`}
          disabled={isRemoteLoading}
          onClick={() => workspacePath && push(workspacePath)}
        >
          <ArrowUp size={14} />
          {ahead > 0 && <span className="scm-toolbar-badge">{ahead}</span>}
        </button>
      </div>

      {/* Error banner */}
      {lastError && (
        <div className="scm-error-banner">
          <span>{lastError}</span>
          <button onClick={clearError}><X size={12} /></button>
        </div>
      )}

      {/* Commit box */}
      <div className="scm-commit-box">
        <textarea
          className="scm-commit-input"
          placeholder="Message (press Enter to commit)"
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleCommit();
            }
          }}
          rows={1}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        />
        <label className="scm-amend-checkbox">
          <input
            type="checkbox"
            checked={amendMode}
            onChange={(e) => setAmendMode(e.target.checked)}
          />
          Amend
        </label>
        <button
          className="scm-commit-btn"
          disabled={!canCommit(commitMessage, stagedFiles.length, unstagedFiles.length, amendMode)}
          onClick={handleCommit}
        >
          {amendMode ? 'Amend Last Commit' : 'Commit'}
        </button>
      </div>

      {/* Meta-pairing commit block (F-9) */}
      {metaWarning && (
        <div className="scm-error-banner" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={14} />
            <span>
              {metaWarning.length} staged file{metaWarning.length === 1 ? '' : 's'} missing the paired
              {' '}.meta/asset — committing can break references.
            </span>
          </div>
          <div style={{ fontSize: 11, opacity: 0.85 }}>
            {metaWarning.slice(0, 4).map((v) => v.staged.split('/').pop()).join(', ')}
            {metaWarning.length > 4 ? '…' : ''}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="asset-viewer-btn" onClick={stagePairedAndCommit}>
              Stage Paired &amp; Commit
            </button>
            <button className="asset-viewer-btn" onClick={doCommit}>
              Commit Anyway
            </button>
            <button className="asset-viewer-btn" onClick={() => setMetaWarning(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="scm-section">
        {/* Merge Conflicts (F-9) */}
        {conflictedFiles.length > 0 && (
          <>
            <div className="scm-section-header" onClick={() => setConflictsOpen(!conflictsOpen)}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--error-text)' }}>
                {conflictsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Merge Conflicts
              </span>
              <span className="scm-section-count">{conflictedFiles.length}</span>
            </div>
            {conflictsOpen &&
              conflictedFiles.map((file) => (
                <div key={`conflict-${file.path}`} className="scm-file-item" style={{ flexWrap: 'wrap', height: 'auto' }}>
                  <span className="icon" style={{ flexShrink: 0, display: 'flex' }}>
                    {getFileIcon(file.path.split('/').pop() || file.path, 14)}
                  </span>
                  <span
                    className="scm-file-name"
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleFileClick(file)}
                  >
                    {file.path.split('/').pop()}
                  </span>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', width: '100%', paddingLeft: 22, margin: '3px 0' }}>
                    {isUnityYaml(file.path) && unityYamlMergePath && (
                      <button
                        className="asset-viewer-btn"
                        title="Resolve with Unity's UnityYAMLMerge tool"
                        onClick={() => workspacePath && runUnityYamlMerge(workspacePath, unityYamlMergePath, file.path)}
                      >
                        UnityYAMLMerge
                      </button>
                    )}
                    <button
                      className="asset-viewer-btn"
                      onClick={() => workspacePath && resolveConflictSide(workspacePath, file.path, 'ours')}
                    >
                      Use Ours
                    </button>
                    <button
                      className="asset-viewer-btn"
                      onClick={() => workspacePath && resolveConflictSide(workspacePath, file.path, 'theirs')}
                    >
                      Use Theirs
                    </button>
                  </div>
                </div>
              ))}
          </>
        )}

        {/* Staged Changes */}
        {stagedFiles.length > 0 && (
          <>
            <div
              className="scm-section-header"
              onClick={() => setStagedOpen(!stagedOpen)}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {stagedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Staged Changes
              </span>
              <div className="scm-section-right">
                <div className="scm-section-actions">
                  <button
                    className="scm-file-action-btn"
                    title="Unstage All"
                    onClick={(e) => { e.stopPropagation(); workspacePath && unstageAll(workspacePath); }}
                  >
                    <Minus size={14} />
                  </button>
                </div>
                <span className="scm-section-count">{stagedFiles.length}</span>
              </div>
            </div>
            {stagedOpen && stagedFiles.filter((f) => !f.conflicted).map((file) => (
              <FileItem
                key={`staged-${file.path}`}
                file={file}
                onUnstage={() => workspacePath && unstageFile(workspacePath, file.path)}
                onClick={() => handleFileClick(file)}
              />
            ))}
          </>
        )}

        {/* Changes */}
        <div
          className="scm-section-header"
          onClick={() => setChangesOpen(!changesOpen)}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {changesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Changes
          </span>
          <div className="scm-section-right">
            {unstagedFiles.length > 0 && (
              <div className="scm-section-actions">
                <button
                  className="scm-file-action-btn"
                  title="Discard All"
                  onClick={(e) => { e.stopPropagation(); workspacePath && discardAll(workspacePath); }}
                >
                  <Undo2 size={14} />
                </button>
                <button
                  className="scm-file-action-btn"
                  title="Stage All"
                  onClick={(e) => { e.stopPropagation(); workspacePath && stageAll(workspacePath); }}
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
            <span className="scm-section-count">{unstagedFiles.length}</span>
          </div>
        </div>
        {changesOpen && unstagedFiles.filter((f) => !f.conflicted).map((file) => (
          <FileItem
            key={`unstaged-${file.path}`}
            file={file}
            onStage={() => workspacePath && stageFile(workspacePath, file.path)}
            onDiscard={() => workspacePath && discardFile(workspacePath, file.path, file.status === 'untracked')}
            onClick={() => handleFileClick(file)}
          />
        ))}

        {/* No changes */}
        {stagedFiles.length === 0 && unstagedFiles.length === 0 && (
          <div style={{ padding: '16px', color: 'var(--text-secondary)', textAlign: 'center', fontSize: 13 }}>
            No changes detected
          </div>
        )}

        {/* Commits */}
        <div
          className="scm-section-header"
          onClick={() => setCommitsOpen(!commitsOpen)}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {commitsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Commits
          </span>
          <span className="scm-section-count">{commitLog.length}</span>
        </div>
        {commitsOpen && commitLog.map((entry) => {
          const isExpanded = expandedCommits.has(entry.hash);
          const detail = commitDetails.get(entry.hash);
          return (
            <div key={entry.hash}>
              <div className="scm-commit-item" onClick={() => toggleCommit(entry.hash)}>
                <span className="scm-commit-chevron">
                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </span>
                <span className="scm-commit-icon"><GitCommitHorizontal size={14} /></span>
                <span className="scm-commit-message">{entry.message}</span>
                <span className="scm-commit-meta">
                  {entry.author} &middot; {formatRelativeDate(entry.date)}
                </span>
              </div>
              {isExpanded && (
                <div className="scm-commit-files">
                  {!detail && (
                    <div className="scm-commit-files-empty">Loading…</div>
                  )}
                  {detail && detail.files.length === 0 && (
                    <div className="scm-commit-files-empty">No file changes</div>
                  )}
                  {detail && detail.files.map((file) => (
                    <div
                      key={file.path}
                      className="scm-file-item scm-commit-file-item"
                      onClick={() => handleCommitFileClick(entry, file)}
                    >
                      <span className="icon" style={{ flexShrink: 0, display: 'flex' }}>
                        {getFileIcon(file.path.split('/').pop() || file.path, 14)}
                      </span>
                      <span className="scm-file-name">{file.path.split('/').pop()}</span>
                      <span className={`scm-file-status ${file.status}`}>
                        {statusLabel(file.status)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Worktrees */}
        <div
          className="scm-section-header"
          onClick={() => setWorktreesOpen(!worktreesOpen)}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {worktreesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Worktrees
          </span>
          <div className="scm-section-right">
            <div className="scm-section-actions">
              <button
                className="scm-file-action-btn"
                title="Add Worktree"
                onClick={(e) => { e.stopPropagation(); setShowAddWorktree(true); }}
              >
                <Plus size={14} />
              </button>
            </div>
            <span className="scm-section-count">{worktrees.length}</span>
          </div>
        </div>
        {worktreesOpen && worktrees.map((w) => {
          const isCurrent = w.path === workspacePath;
          const name = w.path.split('/').filter(Boolean).pop() ?? w.path;
          return (
            <div
              key={w.path}
              className={`scm-worktree-item${isCurrent ? ' is-current' : ''}${w.is_locked ? ' is-locked' : ''}`}
              title={w.path}
            >
              <span className="scm-worktree-icon">
                {w.is_locked ? <Lock size={12} /> : <Folder size={12} />}
              </span>
              <span className="scm-worktree-name">
                {name}{w.is_main ? ' (main)' : ''}
              </span>
              <span className="scm-worktree-branch">{w.branch ?? 'detached'}</span>
              <span className="scm-worktree-sha">{w.head.slice(0, 7)}</span>
              <div className="scm-worktree-actions">
                {!isCurrent && (
                  <button
                    className="scm-file-action-btn"
                    title="Open in new window"
                    onClick={() => openProjectInNewWindow(w.path)}
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
                {!w.is_main && (
                  <button
                    className="scm-file-action-btn"
                    title="Remove worktree"
                    onClick={() => handleRemoveWorktree(w.path)}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {worktreesOpen && worktrees.length === 0 && (
          <div style={{ padding: '8px 16px', color: 'var(--text-secondary)', fontSize: 12 }}>
            No worktrees
          </div>
        )}

        {/* Stashes */}
        <div
          className="scm-section-header"
          onClick={() => setStashesOpen(!stashesOpen)}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {stashesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Stashes
          </span>
          <div className="scm-section-right">
            <div className="scm-section-actions">
              <button
                className="scm-file-action-btn"
                title="Stash Changes"
                onClick={(e) => { e.stopPropagation(); workspacePath && stashPush(workspacePath); }}
              >
                <Plus size={14} />
              </button>
            </div>
            <span className="scm-section-count">{stashes.length}</span>
          </div>
        </div>
        {stashesOpen && stashes.map((s) => (
          <div key={s.index} className="scm-stash-item" title={s.message}>
            <span className="scm-stash-message">{s.message}</span>
            <span className="scm-stash-date">{formatRelativeDate(s.date)}</span>
            <div className="scm-stash-actions">
              <button
                className="scm-file-action-btn"
                title="Apply Stash"
                onClick={() => workspacePath && stashApply(workspacePath, s.index)}
              >
                <Download size={12} />
              </button>
              <button
                className="scm-file-action-btn"
                title="Pop Stash"
                onClick={() => workspacePath && stashPop(workspacePath, s.index)}
              >
                <Undo2 size={12} />
              </button>
              <button
                className="scm-file-action-btn"
                title="Drop Stash"
                onClick={() => workspacePath && stashDrop(workspacePath, s.index)}
              >
                <X size={12} />
              </button>
            </div>
          </div>
        ))}
        {stashesOpen && stashes.length === 0 && (
          <div style={{ padding: '8px 16px', color: 'var(--text-secondary)', fontSize: 12 }}>
            No stashes
          </div>
        )}
      </div>

      {showAddWorktree && <AddWorktreeDialog onClose={() => setShowAddWorktree(false)} />}
    </div>
  );
}

export default SourceControlPanel;
