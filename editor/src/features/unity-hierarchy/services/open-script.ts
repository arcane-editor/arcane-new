import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';

interface FuzzyFileResult {
  path: string;
  relative_path: string;
  file_name: string;
}

/**
 * Resolve a MonoBehaviour component type name to its `.cs` file and open it.
 *
 * Unity REQUIRES a MonoBehaviour's source file name to equal its class name, so
 * `PlayerController` ⇒ `PlayerController.cs` is an exact, reliable mapping — no
 * GUID needed. Built-in components (Transform, Rigidbody, …) have no project
 * `.cs`, so this returns false (the caller treats that as "not a user script").
 */
export async function openScriptForType(type: string): Promise<boolean> {
  const ws = useWorkspaceStore.getState().workspacePath;
  if (!ws) return false;
  try {
    const results = await invoke<FuzzyFileResult[]>('fuzzy_search_files', {
      workspacePath: ws,
      query: type,
      limit: 20,
      fileExtensions: ['cs'],
    });
    const target = `${type}.cs`.toLowerCase();
    const hit = results.find((r) => r.file_name.toLowerCase() === target);
    if (!hit) return false;
    await useWorkspaceStore.getState().openFile(hit.path, hit.file_name);
    return true;
  } catch {
    return false;
  }
}
