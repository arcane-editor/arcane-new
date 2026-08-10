import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Boxes, CheckCircle, Circle, GitBranch, LoaderCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useAuthStore } from '../../../stores/auth';
import { useUiStore } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUnityStore } from '../../../stores/unity';
import { useGitStore } from '../../../stores/git';
import { useCommandsStore } from '../../../stores/commands';
import { useAsmdefStore } from '../../../stores/asmdef';
import { lspManager } from '../../lsp';
import { GraphifyStatusBadge } from '../../graphify';
import { TelemetryStatusItem } from '../../unity-telemetry';
import { UnityBridgeStatusItem } from '../../unity-bridge';
import { InlineSuggestStatusItem } from '../../inline-suggest';
import { detectLanguage } from '../../../utils/language-detect';
import { getDocumentInfo } from '../../editor';

async function openLspTrace() {
  try {
    const path = await invoke<string>('lsp_trace_path');
    await openPath(path);
  } catch (err) {
    console.error('[StatusBar] Failed to open LSP trace:', err);
  }
}

function detectLanguageName(filename: string): string {
  return detectLanguage(filename).displayName;
}

function StatusBar() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const cursorPosition = useUiStore((s) => s.cursorPosition);
  const diagnosticCounts = useUiStore((s) => s.diagnosticCounts);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const unityCompiling = useUnityStore((s) => s.isCompiling);

  // Recomputed on file switch and on every cursor move. cursorPosition already
  // updates on edits and tab switches, so it is the cheapest correct trigger:
  // Monaco owns indentation/EOL and there is no store mirror of them.
  const docInfo = useMemo(
    () => getDocumentInfo(activeFilePath),
    [activeFilePath, cursorPosition],
  );
  const isGitRepo = useGitStore((s) => s.isGitRepo);
  const branch = useGitStore((s) => s.branch);
  const credits = useAuthStore((s) => s.credits);
  const activeFile = openFiles.find((f) => f.path === activeFilePath);
  const language = activeFile ? detectLanguageName(activeFile.name) : null;
  const lspStatus = useUiStore((s) => s.lspStatus);
  const lspProgress = useUiStore((s) => s.lspProgress);
  const isLspLoading = lspStatus === 'starting' || lspStatus === 'indexing';
  const progressSuffix = lspProgress ? ` — ${lspProgress.slice(0, 40)}` : '';
  const lspStatusLabel = isLspLoading
    ? `LSP: Loading${progressSuffix}`
    : lspStatus === 'ready'
      ? 'LSP: Ready'
      : lspStatus === 'error'
        ? 'LSP: Error'
        : 'LSP: Idle';
  const baseTitle = isLspLoading
    ? 'Language server is starting/indexing'
    : lspStatus === 'ready'
      ? 'Language server is ready'
      : lspStatus === 'error'
        ? `Language server failed to start\n${lspManager.client('csharp').getRecentStderr().slice(-5).join('\n')}`
        : 'Language server is idle';
  const lspStatusTitle = `${baseTitle}\n\nClick to open LSP trace log`;

  // Owning-assembly label for the active C# file (Unity projects only). Resolved
  // in an effect — never on render — so we don't invoke the backend per paint.
  // Re-runs when the asmdef graph changes (the dependency below) so the label
  // updates after a refresh/quick-fix.
  const asmdefGraph = useAsmdefStore((s) => s.graph);
  const [owningAssembly, setOwningAssembly] = useState<string | null>(null);
  const isActiveCs = !!activeFilePath && activeFilePath.endsWith('.cs');
  useEffect(() => {
    if (!isUnityProject || !isActiveCs || !activeFilePath) {
      setOwningAssembly(null);
      return;
    }
    let cancelled = false;
    useAsmdefStore
      .getState()
      .getOwningAssembly(activeFilePath)
      .then((name) => {
        if (!cancelled) setOwningAssembly(name);
      });
    return () => {
      cancelled = true;
    };
  }, [isUnityProject, isActiveCs, activeFilePath, asmdefGraph]);

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        {isGitRepo && branch && (
          <span
            className="status-bar-item clickable"
            onClick={() => useCommandsStore.getState().executeCommand('git.switchBranch')}
            title="Switch Branch (⇧⌘B)"
          >
            <span className="icon"><GitBranch size={14} /></span>
            <span>{branch}</span>
          </span>
        )}

        {language && (
          <span className="status-bar-item">
            <span className="icon"><CheckCircle size={14} /></span>
            <span>{language}</span>
          </span>
        )}

        <UnityBridgeStatusItem />

        {isUnityProject && unityCompiling && (
          <span className="status-bar-item" title="Unity is compiling scripts">
            <span className="icon"><LoaderCircle size={13} className="spin" /></span>
            <span>Compiling…</span>
          </span>
        )}

        {isUnityProject && <TelemetryStatusItem />}

        {isUnityProject && isActiveCs && owningAssembly && (
          <span className="status-bar-item" title="Owning assembly">
            <span className="icon"><Boxes size={14} /></span>
            <span>{owningAssembly}</span>
          </span>
        )}

        {workspacePath && (
          <span
            className="status-bar-item clickable"
            title={lspStatusTitle}
            onClick={openLspTrace}
            style={{ cursor: 'pointer' }}
          >
            <span className="icon">
              {isLspLoading ? (
                <LoaderCircle size={14} className="animate-spin" />
              ) : lspStatus === 'ready' ? (
                <CheckCircle size={14} />
              ) : lspStatus === 'error' ? (
                <AlertCircle size={14} />
              ) : (
                <Circle size={14} style={{ opacity: 0.5 }} />
              )}
            </span>
            <span>{lspStatusLabel}</span>
          </span>
        )}

        <span
          className="status-bar-item clickable"
          title="Warnings — open Problems"
          onClick={() => useUiStore.getState().setActiveBottomTab('problems')}
          style={{ cursor: 'pointer' }}
        >
          <span className="icon"><AlertTriangle size={14} /></span>
          <span>{diagnosticCounts.warnings}</span>
        </span>

        <span
          className="status-bar-item clickable"
          title="Errors — open Problems"
          onClick={() => useUiStore.getState().setActiveBottomTab('problems')}
          style={{ cursor: 'pointer' }}
        >
          <span className="icon"><AlertCircle size={14} /></span>
          <span>{diagnosticCounts.errors}</span>
        </span>
      </div>

      <div className="status-bar-right">
        {credits !== null && credits < 10 && (
          <span
            className="status-bar-item clickable"
            onClick={() => void useAuthStore.getState().openBilling()}
            title="You're almost out of AI credits — click to manage your plan."
            style={{ cursor: 'pointer', color: 'var(--warning)' }}
          >
            <span className="icon"><AlertTriangle size={14} /></span>
            <span>{Math.max(0, Math.floor(credits))} credits</span>
          </span>
        )}
        <InlineSuggestStatusItem />
        <GraphifyStatusBadge />
        {cursorPosition && (
          <span className="status-bar-item">
            Ln {cursorPosition.line}, Col {cursorPosition.column}
          </span>
        )}

        {/* Derived from the live Monaco model. These were the literals
            `Spaces: 4` / `UTF-8` / `LF`, which said Spaces on a tab-indented
            file and LF on a CRLF one. Encoding is gone entirely: the backend
            reads and writes UTF-8 only, so the value could never vary. */}
        {docInfo && (
          <>
            <span className="status-bar-item">{docInfo.indent}</span>
            <span className="status-bar-item">{docInfo.eol}</span>
          </>
        )}


        {!workspacePath && (
          <span className="status-bar-item">No folder open</span>
        )}
      </div>

    </div>
  );
}

export default StatusBar;
