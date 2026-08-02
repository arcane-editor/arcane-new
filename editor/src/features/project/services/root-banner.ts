/**
 * Decides whether to offer re-rooting the workspace at a nearby Unity project.
 *
 * Unity features are gated on `isUnityProject`, which is only true when the
 * opened folder is itself a Unity root. Opening `Assets/Scripts` therefore
 * turns every Unity surface off — the activity-bar icons, the bridge status,
 * the console — with nothing on screen explaining why. This is the decision
 * behind the banner that explains it.
 */
export interface RootBannerInput {
  isUnityProject: boolean;
  /** Nearest Unity root ABOVE the workspace (workspace is inside a project). */
  ancestorProjectPath: string | null;
  /** Nearest Unity root BELOW the workspace (workspace contains a project). */
  nestedProjectPath: string | null;
  workspacePath: string | null;
  /** Workspace paths for which the user already dismissed this banner. */
  dismissedPaths: string[];
}

export interface RootBanner {
  kind: 'inside' | 'contains';
  projectPath: string;
  projectName: string;
}

/** Last non-empty path segment. Paths are `/`-separated by the time they
 *  reach the frontend (see src-tauri/src/path_util.rs). */
function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

export function rootBannerFor(input: RootBannerInput): RootBanner | null {
  const { isUnityProject, ancestorProjectPath, nestedProjectPath, workspacePath, dismissedPaths } =
    input;

  // A Unity root already has every feature on — nothing to offer.
  if (isUnityProject) return null;
  if (!workspacePath) return null;
  if (dismissedPaths.includes(workspacePath)) return null;

  // Ancestor wins: being inside a project is the more specific situation, and
  // it is what explains why Unity features are off right now.
  const projectPath = ancestorProjectPath ?? nestedProjectPath;
  if (!projectPath) return null;

  return {
    kind: ancestorProjectPath ? 'inside' : 'contains',
    projectPath,
    projectName: basename(projectPath),
  };
}
