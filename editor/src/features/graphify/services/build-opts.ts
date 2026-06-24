import { useProjectContextStore } from '../../../stores/project-context';
import type { GraphifyBuildOpts } from './graphify-client';

/**
 * Pick the right build scope for the active workspace.
 *
 * - Unity: scan only `Assets/` and only extract `.cs` files. Assets/ contains
 *   the user's scripts; Library/, Temp/, obj/, Build/ live at the workspace
 *   root and are automatically invisible when `--root Assets` is passed. The
 *   extension filter then drops `.meta`, `.prefab`, `.unity`, `.asset` etc.
 * - Everything else: scan the whole workspace; graphify's own detection rules
 *   pick the right code files.
 */
export function computeBuildOpts(): GraphifyBuildOpts {
  if (useProjectContextStore.getState().isUnityProject) {
    return { root: 'Assets', includeExt: ['.cs'] };
  }
  return {};
}
