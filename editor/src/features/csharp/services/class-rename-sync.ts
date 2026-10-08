import { invoke } from '@tauri-apps/api/core';
import { useNotificationsStore } from '../../../stores/notifications';
import { useWorkspaceStore } from '../../../stores/workspace';
import { lspManager, fileUri, applyLspWorkspaceEdit, captureWorkspaceEditVersions, type LspWorkspaceEdit } from '../../lsp';

function stem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.cs$/i, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * After a `.cs` file is renamed via the IDE, if it declares a class matching the
 * OLD file name, offer to rename the class to match the NEW name (Unity requires
 * a MonoBehaviour's class name to equal its file name). Non-intrusive: a
 * dismissible notification, applied only if the user clicks. Reassures the user
 * that the paired `.meta` moved too, so the GUID — and all references — survive.
 */
export function offerClassRenameSync(oldPath: string, newPath: string): void {
  if (!newPath.toLowerCase().endsWith('.cs')) return;
  const oldStem = stem(oldPath);
  const newStem = stem(newPath);
  if (oldStem === newStem || !/^[A-Za-z_]\w*$/.test(newStem)) return;

  void invoke<string>('read_file', { path: newPath })
    .then((content) => {
      const classRe = new RegExp(`\\bclass\\s+${escapeRe(oldStem)}\\b`);
      if (!classRe.test(content)) return;

      useNotificationsStore.getState().addNotification({
        type: 'info',
        message: `Rename class "${oldStem}" → "${newStem}" to match the file? The .meta moved with it, so the GUID and all scene/prefab references are preserved.`,
        persistent: true,
        actions: [
          {
            label: 'Rename class',
            run: async () => {
              try {
                const workspace = useWorkspaceStore.getState();
                await workspace.openFile(newPath, newPath.split('/').pop() ?? newStem);
                // Resolve against the current buffer, never the text captured
                // when the notification was first offered.
                const current = useWorkspaceStore.getState().openFiles.find(f => f.path === newPath);
                const match = current && classRe.exec(current.content);
                if (!current || !match) throw new Error('The original class declaration no longer exists');
                const offset = match.index + match[0].lastIndexOf(oldStem);
                const prefix = current.content.slice(0, offset);
                const client = lspManager.client('csharp');
                if (!client.isRunning()) throw new Error('Wait for C# language services before renaming the class');
                const expectedBuffers = captureWorkspaceEditVersions();
                const edit = await client.request<LspWorkspaceEdit | null>('textDocument/rename', {
                  textDocument: { uri: fileUri(newPath) },
                  position: { line: prefix.split('\n').length - 1, character: prefix.length - prefix.lastIndexOf('\n') - 1 },
                  newName: newStem,
                });
                if (!edit) throw new Error('The language server could not resolve this class');
                await applyLspWorkspaceEdit(edit, { preview: true, expectedBuffers });
              } catch (error) {
                useNotificationsStore.getState().addNotification({ type: 'error', message: `Class rename stopped: ${String(error)}` });
              }
            },
          },
        ],
      });
    })
    .catch(() => {
      /* unreadable — skip the offer */
    });
}
