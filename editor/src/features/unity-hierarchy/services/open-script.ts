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
    // `maxResults` / `extraExcludes`, NOT `limit`: both are non-Option args on
    // the Rust side, so a payload missing them is rejected by Tauri's
    // deserializer before the command body runs. This call site passed `limit`
    // and omitted `extraExcludes` from the day it shipped, and the catch below
    // swallowed the rejection — clicking a script component in the Hierarchy
    // has never once opened a file. `scripts/check-invoke-args.mjs` now fails
    // the build on this class of mismatch.
    const results = await invoke<FuzzyFileResult[]>('fuzzy_search_files', {
      workspacePath: ws,
      query: type,
      maxResults: 20,
      extraExcludes: useWorkspaceStore.getState().extraExcludePatterns,
      fileExtensions: ['cs'],
    });
    const target = `${type}.cs`.toLowerCase();
    const hit = results.find((r) => r.file_name.toLowerCase() === target);
    if (!hit) return false;
    await useWorkspaceStore.getState().openFile(hit.path, hit.file_name);
    return true;
  } catch (err) {
    // Never swallow silently again: a false return is indistinguishable from
    // "this component is a built-in with no script", which is exactly how the
    // original failure hid.
    console.warn('[Hierarchy] script lookup failed for', type, err);
    return false;
  }
}
