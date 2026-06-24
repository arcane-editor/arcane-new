import { invoke } from '@tauri-apps/api/core';

/**
 * One assembly-definition node in the project graph. JSON comes from Rust in
 * snake_case (Tauri's serde Serialize default), so the field names match the
 * backend `AsmdefNode` struct verbatim.
 */
export interface AsmdefNode {
  /** Assembly name (e.g. `Game.Core`). Falls back to the file stem. */
  name: string;
  /** Absolute path of the directory containing the `.asmdef`. */
  root_folder: string;
  /** Referenced assembly names, with `GUID:` references already resolved. */
  references: string[];
  /** `defineConstraints` array (e.g. `["UNITY_INCLUDE_TESTS"]`). */
  define_constraints: string[];
  /** `includePlatforms` array (empty = all platforms). */
  include_platforms: string[];
  /** `rootNamespace` if specified (Unity 2020.2+). */
  root_namespace: string | null;
  /** True when the assembly only compiles for the Editor platform. */
  is_editor_only: boolean;
}

/**
 * Thin `invoke` wrappers over the Rust asmdef commands. These never gate on
 * project type — callers (the store / activation) are responsible for only
 * invoking inside Unity projects.
 */

/** Scan Assets/ + Packages/, returning the full freshly-built graph. */
export function buildGraph(workspacePath: string): Promise<AsmdefNode[]> {
  return invoke<AsmdefNode[]>('asmdef_build_graph', { workspacePath });
}

/** Return the cached graph (Rust rebuilds on a workspace-path miss). */
export function getGraph(workspacePath: string): Promise<AsmdefNode[]> {
  return invoke<AsmdefNode[]>('asmdef_graph_get', { workspacePath });
}

/** Resolve a file's owning assembly via Unity's implicit asmdef rules. */
export function getOwningAssembly(
  workspacePath: string,
  filePath: string,
): Promise<string> {
  return invoke<string>('asmdef_owning_assembly', { workspacePath, filePath });
}
