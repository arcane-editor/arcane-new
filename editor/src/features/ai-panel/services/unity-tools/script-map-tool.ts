// Unity script-map tool (read-only, auto-approved). Gives the agent GROUND
// TRUTH about how many scripts exist and which are editor vs runtime, by
// assembly — backed by the Rust `unity_classify_scripts` command (asmdef graph
// + Unity's predefined-assembly rules). Use this instead of guessing from a
// flat `list` of `.cs` files: in Unity, an `Editor/` folder under a runtime
// asmdef is NOT editor code, and an Editor-only asmdef outside any `Editor/`
// folder IS — folder names alone are not decisive.

import { Type } from '@sinclair/typebox';
import { invoke } from '@tauri-apps/api/core';
import type { AgentTool } from '../vendor/types';
import { useWorkspaceStore } from '../../../../stores/workspace';
import { txt, cap } from './shared';

interface AssemblyScriptCount {
  name: string;
  is_editor_only: boolean;
  source: 'asmdef' | 'predefined';
  count: number;
  sample_paths: string[];
}

interface UnityScriptSummary {
  total: number;
  editor_count: number;
  runtime_count: number;
  by_assembly: AssemblyScriptCount[];
}

function formatSummary(s: UnityScriptSummary): string {
  const lines: string[] = [];
  lines.push('# Unity script classification (under Assets/)');
  lines.push('');
  lines.push(
    `**${s.total} C# scripts** — **${s.editor_count} editor-only**, **${s.runtime_count} runtime**.`,
  );
  lines.push('');
  lines.push(
    'Ground truth: each script is assigned to its owning Unity assembly (asmdef ' +
      'rules + predefined-assembly rules). "Editor script" = its assembly compiles ' +
      'for the Editor platform only (asmdef `includePlatforms: ["Editor"]`, or — ' +
      'with no asmdef — a script under an `Editor/` folder → `Assembly-CSharp-Editor`). ' +
      'A folder named `Editor` under a runtime asmdef is NOT editor code.',
  );
  lines.push('');
  lines.push('## By assembly');
  if (s.by_assembly.length === 0) {
    lines.push('(no C# scripts found under Assets/)');
  }
  for (const a of s.by_assembly) {
    const marker = a.is_editor_only ? '▸ ' : '';
    const kind = a.is_editor_only ? `${a.source}, Editor-only` : a.source;
    lines.push(
      `- ${marker}**${a.name}** (${kind}) — ${a.count} script${a.count === 1 ? '' : 's'}`,
    );
  }
  return lines.join('\n');
}

/**
 * `get_unity_script_map` — deterministic editor-vs-runtime script counts and a
 * per-assembly breakdown. Read-only, no live Unity Editor required.
 */
export function createUnityScriptMapTool(): AgentTool {
  return {
    name: 'get_unity_script_map',
    label: 'get unity script map',
    description:
      'Get a ground-truth classification of the project\'s C# scripts under Assets/: ' +
      'total count, how many are editor-only vs runtime, and a per-assembly breakdown ' +
      '(asmdef and predefined assemblies, with the Editor-only ones flagged). ' +
      'ALWAYS use this — not the `list` tool — to answer questions about how many ' +
      'scripts/editor scripts/runtime scripts there are, which assembly a category of ' +
      'scripts belongs to, or how the project is split into assemblies. Counting `.cs` ' +
      'files or assuming everything in an `Editor/` folder is an editor script is wrong ' +
      'in Unity once asmdefs are involved.',
    parameters: Type.Object({}),
    async execute() {
      const workspacePath = useWorkspaceStore.getState().workspacePath;
      if (!workspacePath) {
        return txt('No workspace is open, so there are no scripts to classify.');
      }
      try {
        const summary = await invoke<UnityScriptSummary>('unity_classify_scripts', {
          workspacePath,
        });
        return txt(cap(formatSummary(summary)));
      } catch (e) {
        return txt(
          `Could not classify scripts: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  };
}
