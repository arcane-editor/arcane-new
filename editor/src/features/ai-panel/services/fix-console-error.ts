// Flagship workflow: "Fix this console error" (F-5.4). One-click on a Unity
// console error → assemble the error + stack-trace code regions into a prompt and
// drive the existing agent. The agent then uses the Unity read tools (esp.
// get_game_object) to distinguish code fixes from scene/inspector fixes, and the
// analyzer-gate (F-5.3) closes the loop on its edits.

import { invoke } from '@tauri-apps/api/core';
import { getAgentService } from './agent-service';
import { useAiStore } from '../../../stores/ai';
import { useUiStore } from '../../../stores/ui';
import { useWorkspaceStore } from '../../../stores/workspace';
import { parseStackTrace, type UnityLogEntry, type StackFrame } from '../../../types/unity';

const CONTEXT_LINES = 12;

async function readRegion(frame: StackFrame): Promise<string | null> {
  const ws = useWorkspaceStore.getState().workspacePath;
  const abs =
    frame.filePath.startsWith('/') || /^[A-Za-z]:/.test(frame.filePath)
      ? frame.filePath
      : ws
        ? (ws.endsWith('/') ? ws : ws + '/') + frame.filePath
        : frame.filePath;
  try {
    const content = await invoke<string>('read_file', { path: abs });
    const lines = content.split('\n');
    const ln = frame.lineNumber;
    const start = Math.max(0, ln - 1 - CONTEXT_LINES);
    const end = Math.min(lines.length, ln + CONTEXT_LINES);
    const snippet = lines
      .slice(start, end)
      .map((l, i) => `${start + i + 1}: ${l}`)
      .join('\n');
    return `<region path="${frame.filePath}" line="${ln}">\n${snippet}\n</region>`;
  } catch {
    return null;
  }
}

/** Assemble the fix prompt for a console entry (exported for testing/reuse). */
export async function buildFixPrompt(entry: UnityLogEntry): Promise<string> {
  const frames = entry.parsedFrames ?? parseStackTrace(entry.stackTrace ?? '');
  const projectFrames = frames.filter((f) => /Assets\//.test(f.filePath)).slice(0, 4);
  const regions = (await Promise.all(projectFrames.map(readRegion))).filter(Boolean) as string[];

  return [
    `Fix this Unity console ${entry.logType.toLowerCase()}. First state the ROOT CAUSE in 2-3 sentences, then apply the fix.`,
    ``,
    `Error: ${entry.message}`,
    entry.stackTrace ? `\nStack trace:\n${entry.stackTrace}` : '',
    regions.length
      ? `\nRelevant code:\n${regions.join('\n\n')}`
      : `\n(No in-project stack frames resolved — infer from the message.)`,
    `\nGuidance: if this is a NullReferenceException on a serialized field, check whether the field is simply unassigned on the object in the scene (use get_scene_hierarchy / get_game_object) BEFORE adding a null-check — that is usually the real fix. If it's a typo'd Unity message (e.g. "update" vs "Update"), fix the casing. After editing, the Unity analyzer gate will flag any remaining issues.`,
  ].join('\n');
}

/**
 * Drive the agent to fix a console error/exception. Sends at the user's
 * current effort (never hardcoded — mirrors `summarizeSceneDiff`, P6.4).
 * Reveals the AI panel.
 */
export async function fixConsoleError(entry: UnityLogEntry): Promise<void> {
  const prompt = await buildFixPrompt(entry);
  const effort = useAiStore.getState().effort;
  useAiStore.getState().setMode('agent');
  useUiStore.getState().setActiveRightSidebarView('ai-panel');
  useUiStore.getState().setRightSidebarVisible(true);
  await getAgentService().sendMessage(prompt, { mode: 'agent', effort });
}
