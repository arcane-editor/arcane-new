/**
 * Tool-sandbox roots for a workspace. Non-Unity workspaces used to get NO
 * sandbox at all (allowedRoot null ⇒ `resolveWithinRoot` passes any absolute
 * path through, and auto apply-mode wrote it unprompted — ~/.ssh/config was
 * one bad tool call away). Unity keeps Assets/ FIRST (`primaryRoot` is bash's
 * default cwd and list's default scan root), plus .unityide/ (plan files, see
 * path-utils.ts's AllowedRoots note) and Packages/ — prompts/agent.ts
 * explicitly allows Packages/manifest.json edits after confirming, which the
 * old [Assets, .unityide] list refused. '/' is the no-workspace placeholder
 * (agent-service's getCurrentWorkspacePath fallback): deny-all rather than
 * sandbox-to-filesystem-root.
 *
 * `.arcane/` is the pre-rename name of `.unityide/` and stays allowed. That
 * directory lives in the USER'S Unity project, not in our config dir, so it
 * survives the rename untouched — and a session carried across by the config
 * migration still holds an `activePlanPath` pointing into it. Without this
 * entry, resuming any plan written before the rename is refused by the
 * sandbox, which reads to the user as "my plans stopped working". New plans
 * are only ever written to `.unityide/` (plan-files.ts).
 */
export const LEGACY_WORKSPACE_DIR = '.arcane';

export function computeAllowedRoots(
  workspacePath: string,
  isUnity: boolean,
  assetsRootPath: string | null,
): readonly string[] {
  if (!workspacePath || workspacePath === '/') return [];
  if (isUnity && assetsRootPath) {
    return [
      assetsRootPath,
      `${workspacePath}/.unityide`,
      `${workspacePath}/${LEGACY_WORKSPACE_DIR}`,
      `${workspacePath}/Packages`,
    ];
  }
  return [workspacePath];
}

/**
 * Write roots for an EXTERNAL agent (Claude Code over ACP).
 *
 * Deliberately not `computeAllowedRoots`. That function encodes the UnityIDE
 * agent's tool policy — on a Unity project it narrows to
 * `[Assets, .unityide, Packages]` — and applying it to an agent that runs its own
 * harness cages the legible path without closing the illegible one:
 * `acp-terminals.ts` hands the same agent an unconfined shell, so anything the
 * root check refuses through `fs/write_text_file` is one `sh -c` away.
 *
 * What is kept is the confinement that still does real work: a write stays
 * inside the open project, so a bad tool call cannot reach `~/.ssh/config`.
 * Reads are not routed through here at all — see `acp-fs.ts`.
 *
 * `''` / `'/'` is agent-service's no-workspace placeholder: deny-all, exactly
 * as `computeAllowedRoots` treats it, rather than sandboxing to the filesystem
 * root.
 */
export function computeExternalAgentWriteRoots(workspacePath: string): readonly string[] {
  if (!workspacePath || workspacePath === '/') return [];
  return [workspacePath];
}
