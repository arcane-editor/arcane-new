/**
 * Tool-sandbox roots for a workspace. Non-Unity workspaces used to get NO
 * sandbox at all (allowedRoot null ⇒ `resolveWithinRoot` passes any absolute
 * path through, and auto apply-mode wrote it unprompted — ~/.ssh/config was
 * one bad tool call away). Unity keeps Assets/ FIRST (`primaryRoot` is bash's
 * default cwd and list's default scan root), plus .arcane/ (plan files, see
 * path-utils.ts's AllowedRoots note) and Packages/ — prompts/agent.ts
 * explicitly allows Packages/manifest.json edits after confirming, which the
 * old [Assets, .arcane] list refused. '/' is the no-workspace placeholder
 * (agent-service's getCurrentWorkspacePath fallback): deny-all rather than
 * sandbox-to-filesystem-root.
 */
export function computeAllowedRoots(
  workspacePath: string,
  isUnity: boolean,
  assetsRootPath: string | null,
): readonly string[] {
  if (!workspacePath || workspacePath === '/') return [];
  if (isUnity && assetsRootPath) {
    return [assetsRootPath, `${workspacePath}/.arcane`, `${workspacePath}/Packages`];
  }
  return [workspacePath];
}
