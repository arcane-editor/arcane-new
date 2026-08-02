import { Zap, X } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { notify } from '../../../stores/notifications';
import { openProjectInNewWindow } from '../services/multi-window';
import { rootBannerFor } from '../services/root-banner';

/**
 * Explains why Unity features are off when the opened folder sits inside (or
 * contains) a Unity project, and offers to open the project root instead.
 *
 * Rendering is decided by `rootBannerFor` so the logic stays unit-tested —
 * this component only wires stores to it.
 */
function ProjectRootBanner() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const ancestorProjectPath = useProjectContextStore((s) => s.ancestorProjectPath);
  const nestedProjectPath = useProjectContextStore((s) => s.nestedProjectPath);
  const dismissedPaths = useSettingsStore((s) => s.settings['project.rootBanner.dismissed']);
  const setSetting = useSettingsStore((s) => s.setSetting);

  const banner = rootBannerFor({
    isUnityProject,
    ancestorProjectPath,
    nestedProjectPath,
    workspacePath,
    dismissedPaths,
  });

  if (!banner) return null;

  const folderName = workspacePath?.split('/').filter(Boolean).pop() ?? 'This folder';

  function dismiss() {
    if (!workspacePath) return;
    if (dismissedPaths.includes(workspacePath)) return;
    setSetting('project.rootBanner.dismissed', [...dismissedPaths, workspacePath]);
  }

  // Extracted once so the closures below capture a plain string instead of
  // the nullable `banner` object.
  const projectPath = banner.projectPath;

  function openRoot() {
    openProjectInNewWindow(projectPath).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error(`Couldn't open ${projectPath}. (${msg})`);
      // Only drop the offer when the project is confirmed gone (tagged by
      // `openProjectInNewWindow`'s `dir_exists` guard) — a generic rejection
      // (e.g. a transient window-spawn failure) leaves the situation
      // unchanged, so a retry should still be offered next time.
      const missing = err instanceof Error && err.name === 'ProjectMissingError';
      if (missing) dismiss();
    });
  }

  return (
    <div className="project-root-banner">
      <span className="project-root-banner-icon">
        <Zap size={14} />
      </span>
      <span className="project-root-banner-text">
        {banner.kind === 'inside' ? (
          <>
            <strong>{folderName}</strong> is inside the Unity project{' '}
            <strong>{banner.projectName}</strong>. Unity features (console, play controls,
            bridge) need the project root.
          </>
        ) : (
          <>
            This folder contains the Unity project <strong>{banner.projectName}</strong>. Open
            it directly for Unity features.
          </>
        )}
      </span>
      <button className="project-root-banner-action" onClick={openRoot}>
        Open project root
      </button>
      <button className="project-root-banner-dismiss" onClick={dismiss} title="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

export default ProjectRootBanner;
