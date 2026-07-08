// Flagship workflow: "Summarize this scene change" (P6.4). One-click action
// from the SceneDiffViewer header → assemble the already-computed STRUCTURED
// diff text (never raw YAML) into an ask-mode prompt and drive the existing
// agent, mirroring the "Fix this console error" one-click pattern (F-5.4,
// see fix-console-error.ts). Unity-asset-viewer does its own formatting via
// `formatSceneDiffForPrompt` and passes plain text in here — this file never
// imports scene-diff types, keeping the feature dependency one-way
// (unity-asset-viewer → ai-panel barrel).
//
// `agent-service`/`stores/ai`/`stores/ui` are imported lazily (inside
// `summarizeSceneDiff`, not at module scope) so that `buildSummarizePrompt` —
// the pure part covered by unit tests — stays import-cheap: those modules
// pull in the full AiChatPanel component tree, which touches `document` at
// module-eval time and can't load outside a browser/DOM environment.

const TASK_FRAMING =
  'Summarize this Unity scene/prefab change for a code review — what changed, what it likely affects, anything risky:';

export interface SummarizeSceneDiffArgs {
  /** Workspace-relative path of the diffed asset, e.g. "Assets/Scenes/Main.unity". */
  filePath: string;
  /**
   * Pre-formatted structured diff text — the unity-asset-viewer's
   * `formatSceneDiffForPrompt(diff)` output. Never raw YAML.
   */
  promptText: string;
}

/** Assemble the summarize prompt (exported for testing/reuse). Pure. */
export function buildSummarizePrompt({ filePath, promptText }: SummarizeSceneDiffArgs): string {
  return [TASK_FRAMING, '', `File: ${filePath}`, '', promptText].join('\n');
}

/**
 * Drive the agent to summarize a scene/prefab diff. Sends in ask mode, at
 * the user's current effort (never hardcoded). Reveals the AI panel.
 */
export async function summarizeSceneDiff(args: SummarizeSceneDiffArgs): Promise<void> {
  const [{ getAgentService }, { useAiStore }, { useUiStore }] = await Promise.all([
    import('./agent-service'),
    import('../../../stores/ai'),
    import('../../../stores/ui'),
  ]);

  const prompt = buildSummarizePrompt(args);
  const effort = useAiStore.getState().effort;
  useAiStore.getState().setMode('ask');
  useAiStore.getState().addUserMessage(`Summarize this scene change: ${args.filePath}`);
  useUiStore.getState().setActiveRightSidebarView('ai-panel');
  useUiStore.getState().setRightSidebarVisible(true);
  await getAgentService().sendMessage(prompt, { mode: 'ask', effort });
}
