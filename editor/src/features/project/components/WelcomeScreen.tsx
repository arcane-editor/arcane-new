import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { openProjectInNewWindow } from '../services/multi-window';
import { loadRecentProjects, removeRecentProject } from '../../../utils/persistence';
import { notify } from '../../../stores/notifications';
import WorkspaceSignpost from './WorkspaceSignpost';

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
      try {
        await openProjectInNewWindow(selected as string);
      } catch (err) {
        // Rare (the folder was just picked), but possible: deleted between
        // pick and open, or the window itself failed to spawn.
        const msg = err instanceof Error ? err.message : String(err);
        notify.error(`Couldn't open ${selected} — it may have been moved or deleted. (${msg})`);
      }
    }
  }

  async function openRecent(path: string) {
    try {
      await openProjectInNewWindow(path);
    } catch (err) {
      // Only drop the recent entry when the project itself is confirmed
      // gone (tagged by `openProjectInNewWindow`'s `dir_exists` guard, which
      // throws before any new window exists) — not for a rare window-spawn
      // failure on an otherwise-valid path.
      const missing = err instanceof Error && err.name === 'ProjectMissingError';
      if (missing) {
        notify.error(`Couldn't open ${path} — it may have been moved or deleted.`);
        removeRecentProject(path);
        setRecents(loadRecentProjects());
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        notify.error(`Couldn't open ${path}. (${msg})`);
      }
    }
  }

  if (hasWorkspace) {
    return <WorkspaceSignpost />;
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
