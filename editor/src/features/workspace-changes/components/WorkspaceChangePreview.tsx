import { useEffect, useMemo, useRef, useState } from 'react';
import { createPatch } from 'diff';
import { useWorkspaceChangePreview, finishWorkspaceChangePreview } from '../../../stores/workspace-change-preview';
import { useWorkspaceStore } from '../../../stores/workspace';
import { invoke } from '@tauri-apps/api/core';
import { useNotificationsStore, notify } from '../../../stores/notifications';
import { useCommandsStore } from '../../../stores/commands';

export function WorkspaceChangePreview() {
  const files = useWorkspaceChangePreview(s => s.files);
  const workspace = useWorkspaceStore(s => s.workspacePath);
  const [selected, setSelected] = useState(0);
  const applyButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!workspace) return;
    let current = true;
    void invoke<unknown[]>('workspace_edit_pending', { workspacePath: workspace }).then(pending => {
      if (!current || !pending.length) return;
      useNotificationsStore.getState().addNotification({ type: 'warning', persistent: true,
        message: `${pending.length} interrupted workspace change(s) have recovery backups.`,
        actions: [{ label: 'Review recovery', run: () => { useCommandsStore.getState().executeCommand('workspace.reviewRecovery'); } }],
      });
    }).catch(error => { if (current) notify.error(`Could not check workspace recovery: ${String(error)}`); });
    return () => { current = false; };
  }, [workspace]);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    setSelected(0);
    if (files) applyButton.current?.focus();
    return () => { if (files) { finishWorkspaceChangePreview(false); if (previousFocus?.isConnected) previousFocus.focus(); } };
  }, [files, workspace]);
  const file = files?.[Math.min(selected, files.length - 1)];
  const patch = useMemo(() => file ? createPatch(file.path, file.before, file.after, 'Before', 'After') : '', [file]);
  if (!files) return null;
  return (
    <div className="settings-modal-overlay" data-workspace-change-overlay="true"
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') finishWorkspaceChangePreview(false);
        if (event.key === 'Tab') {
          const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button,[tabindex="0"]'));
          const index = targets.indexOf(document.activeElement as HTMLElement);
          if (targets.length) { event.preventDefault(); targets[(index + (event.shiftKey ? -1 : 1) + targets.length) % targets.length].focus(); }
        }
      }}>
      <section role="dialog" aria-modal="true" aria-label="Review workspace changes"
        style={{ width: 'min(1100px, 92vw)', height: '80vh', background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <header style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
          <strong>Review workspace changes</strong>
          <div style={{ marginTop: 6 }}>{files.length} file(s). Open documents remain unsaved. Use “Undo Last Workspace Change” to revert the operation.</div>
        </header>
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <nav aria-label="Changed files" style={{ width: 270, overflow: 'auto', borderRight: '1px solid var(--border)' }}>
            {files.map((f, i) => <button key={f.path} onClick={() => setSelected(i)} aria-pressed={i === selected}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: 10, overflowWrap: 'anywhere', color: 'inherit', background: i === selected ? 'rgba(127, 127, 127, 0.16)' : 'transparent', border: 0 }}>
              {workspace && f.path.startsWith(workspace + '/') ? f.path.slice(workspace.length + 1) : f.path}
              <small style={{ display: 'block', opacity: 0.7 }}>{f.buffer ? 'Open document' : 'Saved file'}</small>
            </button>)}
          </nav>
          <pre aria-label="Changes in selected file" tabIndex={0} style={{ flex: 1, overflow: 'auto', margin: 0, padding: 16, fontSize: 12 }}>{patch}</pre>
        </div>
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, padding: 16, borderTop: '1px solid var(--border)' }}>
          <button onClick={() => finishWorkspaceChangePreview(false)}>Cancel</button>
          <button ref={applyButton} onClick={() => finishWorkspaceChangePreview(true)}>Apply changes</button>
        </footer>
      </section>
    </div>
  );
}
