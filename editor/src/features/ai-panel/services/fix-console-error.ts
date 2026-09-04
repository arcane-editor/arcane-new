// Flagship workflow: "Fix this console error" (F-5.4). One-click on a Unity
// console error → assemble the error + stack-trace code regions into a prompt and
// drive the existing agent. The agent then uses the Unity read tools (esp.
// get_game_object) to distinguish code fixes from scene/inspector fixes, and the
// analyzer-gate (F-5.3) closes the loop on its edits.
//
// The prompt assembly itself lives in `prompts/console-repair.ts` — pure, with
// the file read injected — because Task 13's post-turn console check builds the
// same `<region>` blocks for its repair pass, and a second copy of this text
// would drift. This file keeps the store/Tauri wiring and nothing else; the
// prompt it produces is byte-identical to the one it produced before the
// extraction (`fix-console-error.test.ts`).

import { invoke } from '@tauri-apps/api/core';
import { getAgentService } from './agent-service';
import { buildFixPrompt, type RegionDeps } from './prompts/console-repair';
import { useAiStore } from '../../../stores/ai';
import { useUiStore } from '../../../stores/ui';
import { useWorkspaceStore } from '../../../stores/workspace';
import type { UnityLogEntry } from '../../../types/unity';

/** The production region reader: Tauri file reads, rooted at the open workspace. */
export function tauriRegionDeps(): RegionDeps {
  return {
    readFile: (path) => invoke<string>('read_file', { path }),
    workspacePath: useWorkspaceStore.getState().workspacePath,
  };
}

/**
 * Drive the agent to fix a console error/exception. Sends at the user's
 * current effort (never hardcoded — mirrors `summarizeSceneDiff`, P6.4).
 * Reveals the AI panel.
 */
export async function fixConsoleError(entry: UnityLogEntry): Promise<void> {
  const prompt = await buildFixPrompt(entry, tauriRegionDeps());
  const effort = useAiStore.getState().effort;
  useAiStore.getState().setMode('agent');
  const firstLine = entry.message.split('\n')[0] ?? '';
  const summary = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  useAiStore.getState().addUserMessage(`Fix this console error: ${summary}`);
  useUiStore.getState().setActiveRightSidebarView('ai-panel');
  useUiStore.getState().setRightSidebarVisible(true);
  await getAgentService().sendMessage(prompt, { mode: 'agent', effort });
}
