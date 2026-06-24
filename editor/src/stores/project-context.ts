import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from './workspace';
import { useNotificationsStore } from './notifications';
import { useSettingsStore } from './settings';
import { useUnityIndexStore } from './unity-index';
import { requestOpenProjectInThisWindow } from '../features/project';

interface UnityProjectInfo {
  is_unity: boolean;
  unity_version: string | null;
  nested_project_path: string | null;
}

interface UnityEditorInstall {
  path: string;
  version: string;
  unity_yaml_merge_path: string | null;
}

// Tree/quick-open noise reduction for Unity projects. `.meta` files are NOT
// excluded here — their explorer visibility is controlled per-setting
// (`unity.explorer.hideMeta`) at the view layer so the toggle can show them.
// `.asset` files stay visible too (ScriptableObjects are first-class, and the
// structured Asset Viewer opens them). Generated csproj/sln stay hidden (Unity
// rewrites them; the IDE never edits them).
const UNITY_EXCLUDE_PATTERNS = [
  'Library/**',
  'Temp/**',
  'obj/**',
  'Logs/**',
  'UserSettings/**',
  'Build/**',
  'Builds/**',
  '.vs/**',
  '**/*.csproj',
  '*.sln',
];

interface ProjectContextState {
  isUnityProject: boolean;
  unityVersion: string | null;
  editorInstallPath: string | null;
  unityYamlMergePath: string | null;
  nestedProjectPath: string | null;

  detectProjectType: (workspacePath: string) => Promise<UnityProjectInfo | null>;
  applyDetection: (workspacePath: string, info: UnityProjectInfo) => void;
  reset: () => void;
}

/** Extract the last path segment (dirname) from a full path. */
function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
}

export const useProjectContextStore = create<ProjectContextState>((set) => ({
  isUnityProject: false,
  unityVersion: null,
  editorInstallPath: null,
  unityYamlMergePath: null,
  nestedProjectPath: null,

  detectProjectType: async (workspacePath: string) => {
    try {
      const info = await invoke<UnityProjectInfo>('detect_unity_project', {
        workspacePath,
      });
      useProjectContextStore.getState().applyDetection(workspacePath, info);
      return info;
    } catch (err) {
      console.warn('[ProjectContext] Detection failed:', err);
      return null;
    }
  },

  applyDetection: (workspacePath: string, info: UnityProjectInfo) => {
    set({
      isUnityProject: info.is_unity,
      unityVersion: info.unity_version,
      nestedProjectPath: info.nested_project_path,
    });

    if (info.is_unity) {
      // Workspace-rooted tree (so Assets, Packages, ProjectSettings are all
      // visible). The optional `unity.explorer.assetsFirst` setting pins the
      // Unity folders to the top at the view layer (see applyUnityTreeView).
      useWorkspaceStore.getState().setExcludePatterns(UNITY_EXCLUDE_PATTERNS);
      console.log(
        `[ProjectContext] Unity project detected (v${info.unity_version ?? 'unknown'})`,
      );

      // Background, non-blocking: build the persistent GUID / reverse-reference
      // index. Loads from disk if a fresh persisted index exists; otherwise
      // scans. Gated on the `unity.index.enabled` setting.
      if (useSettingsStore.getState().getSetting('unity.index.enabled')) {
        void useUnityIndexStore
          .getState()
          .build(workspacePath, info.unity_version ?? '');
      }

      // Fire-and-forget: resolve the Unity editor install path.
      if (info.unity_version) {
        invoke<UnityEditorInstall | null>('resolve_unity_editor', {
          version: info.unity_version,
        })
          .then((install) => {
            if (install) {
              set({
                editorInstallPath: install.path,
                unityYamlMergePath: install.unity_yaml_merge_path,
              });
              console.log(`[ProjectContext] Unity editor resolved: ${install.path}`);
            }
          })
          .catch((err) => {
            console.warn('[ProjectContext] resolve_unity_editor failed:', err);
          });
      }
    } else if (info.nested_project_path) {
      // Root is not a Unity project, but a nested child is — notify the user.
      const nestedPath = info.nested_project_path;
      const dirName = basename(nestedPath);
      useNotificationsStore.getState().addNotification({
        type: 'info',
        message: `Unity project found in "${dirName}"`,
        persistent: true,
        actions: [
          {
            label: 'Open it',
            run: () => {
              requestOpenProjectInThisWindow(nestedPath).catch((err) => {
                console.warn('[ProjectContext] Failed to open nested project:', err);
              });
            },
          },
        ],
      });
    }
  },

  reset: () => {
    set({
      isUnityProject: false,
      unityVersion: null,
      editorInstallPath: null,
      unityYamlMergePath: null,
      nestedProjectPath: null,
    });
    useWorkspaceStore.getState().setExcludePatterns([]);
  },
}));
