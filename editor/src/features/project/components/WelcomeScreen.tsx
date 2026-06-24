import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useWorkspaceStore } from '../../../stores/workspace';
import { loadRecentProjects, removeRecentProject } from '../../../utils/persistence';

function WelcomeScreen({ hasWorkspace = false }: { hasWorkspace?: boolean }) {
  const [recents, setRecents] = useState<string[]>([]);

  useEffect(() => {
    if (!hasWorkspace) setRecents(loadRecentProjects());
  }, [hasWorkspace]);

  async function openFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Open Folder',
    });
    if (selected) {
      await useWorkspaceStore.getState().setWorkspace(selected as string);
    }
  }

  async function openRecent(path: string) {
    try {
      await useWorkspaceStore.getState().setWorkspace(path);
    } catch {
      // Path may have been deleted/moved — drop from recents
      removeRecentProject(path);
      setRecents(loadRecentProjects());
    }
  }

  if (hasWorkspace) {
    return (
      <div className="welcome-screen">
        <h2>Editor</h2>
        <p>Select a file from the explorer to get started</p>
        <span className="welcome-shortcut">Ctrl+O / Cmd+O to open a different folder</span>
      </div>
    );
  }

  return (
    <div className="welcome-screen">
      <h2>Editor</h2>
      <p>Open a folder to get started</p>
      <button className="welcome-btn" onClick={openFolder}>
        Open Folder
      </button>
      <span className="welcome-shortcut">Ctrl+O / Cmd+O</span>

      {recents.length > 0 && (
        <div className="welcome-recents">
          <div className="welcome-recents-title">Recent</div>
          <ul className="welcome-recents-list">
            {recents.map((path) => {
              const name = path.split('/').filter(Boolean).pop() ?? path;
              return (
                <li key={path}>
                  <button
                    className="welcome-recent-item"
                    onClick={() => openRecent(path)}
                    title={path}
                  >
                    <span className="welcome-recent-name">{name}</span>
                    <span className="welcome-recent-path">{path}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export default WelcomeScreen;
