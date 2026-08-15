/**
 * Tauri wrappers around the bundled arcane-graph sidecar.
 *
 * The sidecar is a PyInstaller binary that runs graphify's structural
 * extraction (AST only, no LLM). Graph artifacts live at
 * `~/.arcane/graphs/<sha1>/graph.json` on the host filesystem.
 */

import { invoke } from '@tauri-apps/api/core';

export interface GraphifyCheckResult {
  available: boolean;
  version: string | null;
}

export interface GraphifyBuildResult {
  nodes: number;
  edges: number;
  communities: number;
  graph_path: string;
  summary_path: string;
}

export interface GraphifyBuildOpts {
  /** Restrict scanning to this subdirectory of the workspace (e.g. 'Assets'). */
  root?: string;
  /** If provided, only code files with these extensions are extracted. */
  includeExt?: string[];
}

export interface GraphifyGodNode {
  label?: string;
  source_file?: string;
}

export interface GraphifySummary {
  nodes: number;
  edges: number;
  communities: number;
  god_nodes: GraphifyGodNode[];
  graph_path: string;
}

export interface GraphifyLoadSummaryResult {
  available: boolean;
  graph_path: string | null;
  summary: GraphifySummary | null;
  last_built_at_ms: number | null;
}

export async function graphifyCheck(): Promise<GraphifyCheckResult> {
  return invoke<GraphifyCheckResult>('graphify_check');
}

export async function graphifyBuild(
  workspacePath: string,
  opts?: GraphifyBuildOpts,
): Promise<GraphifyBuildResult> {
  return invoke<GraphifyBuildResult>('graphify_build', {
    workspacePath,
    root: opts?.root,
    includeExt: opts?.includeExt,
  });
}

export async function graphifyQuery(
  workspacePath: string,
  question: string,
  opts?: { budget?: number; dfs?: boolean },
): Promise<string> {
  return invoke<string>('graphify_query', {
    workspacePath,
    question,
    budget: opts?.budget,
    dfs: opts?.dfs,
  });
}

export async function graphifySymbols(
  workspacePath: string,
  opts: { file?: string; typeName?: string },
): Promise<string> {
  return invoke<string>('graphify_symbols', {
    workspacePath,
    file: opts.file ?? null,
    typeName: opts.typeName ?? null,
  });
}

export async function graphifyExplain(
  workspacePath: string,
  node: string,
): Promise<string> {
  return invoke<string>('graphify_explain', { workspacePath, node });
}

export async function graphifyPath(
  workspacePath: string,
  a: string,
  b: string,
): Promise<string> {
  return invoke<string>('graphify_path', { workspacePath, a, b });
}

export async function graphifyLoadSummary(
  workspacePath: string,
): Promise<GraphifyLoadSummaryResult> {
  return invoke<GraphifyLoadSummaryResult>('graphify_load_summary', { workspacePath });
}
