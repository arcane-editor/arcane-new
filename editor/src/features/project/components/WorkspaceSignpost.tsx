import { useCommandsStore } from '../../../stores/commands';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUnityStore } from '../../../stores/unity';
import { useWorkspaceStore } from '../../../stores/workspace';
import { signpostShortcuts } from '../services/signpost';

/** Human-readable bridge state, mirroring the StatusBar cluster's tooltips. */
function bridgeLabel(state: string): string {
  switch (state) {
    case 'connected': return 'bridge connected';
    case 'reloading': return 'reloading…';
    case 'not-installed': return 'bridge not installed';
    default: return 'bridge disconnected';
  }
}

/**
 * Shown in place of the editor when a workspace is open but no file is —
 * the screen a user lands on right after opening a project.
 *
 * Replaces a near-empty "Select a file from the explorer to get started",
 * which spent prime real estate saying nothing. Answers the three questions
 * the Unity feedback raised: is the Unity integration working, which
 * shortcuts matter, and where the Unity features live.
 */
function WorkspaceSignpost() {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const unityVersion = useProjectContextStore((s) => s.unityVersion);
  const bridgeState = useUnityStore((s) => s.bridgeState);
  // Subscribing to the map keeps this in sync as commands register at boot.
  const commands = useCommandsStore((s) => s.commands);

  const shortcuts = signpostShortcuts(
    Array.from(commands.values())
      .filter((c) => c.keybinding)
      .map((c) => ({ id: c.id, keybinding: c.keybinding! })),
  );

  const projectName = workspacePath?.split('/').filter(Boolean).pop() ?? '';

  return (
    <div className="workspace-signpost">
      {projectName && <h2 className="workspace-signpost-title">{projectName}</h2>}

      {isUnityProject && (
        <p className="workspace-signpost-unity">
          {unityVersion ? `Unity ${unityVersion}` : 'Unity'} · {bridgeLabel(bridgeState)}
        </p>
      )}

      {shortcuts.length > 0 && (
        <ul className="workspace-signpost-shortcuts">
          {shortcuts.map((s) => (
            <li key={s.id}>
              <kbd>{s.keys}</kbd>
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
      )}

      {isUnityProject && (
        <p className="workspace-signpost-hint">
          Unity console, hierarchy and tests are in the left activity bar.
        </p>
      )}
    </div>
  );
}

export default WorkspaceSignpost;
