/**
 * Content and copy rules for the chat's empty state.
 *
 * Pure and separate from the component for the reason `layout-sizes.ts` gives:
 * this project has no component-test infrastructure, so anything worth
 * verifying lives outside the React wiring.
 */

import type { AgentKind, ChatMode } from '../services/types';
import { isExternalAgent } from '../services/types';

/**
 * Opening prompts, per mode.
 *
 * Written as whole requests a Unity developer would actually type, and kept
 * free of invented file names — a starter naming `PlayerController.cs` in a
 * project that has no such file teaches the assistant is guessing. Each one is
 * phrased for the mode it sits under: questions under Ask, features under
 * Plan, edits under Agent.
 */
export const STARTERS: Record<ChatMode, string[]> = {
  ask: [
    'Explain how player input is handled here.',
    'Which scripts do work every frame?',
    'What calls GetComponent inside Update?',
  ],
  plan: [
    'Add a pause menu with resume and quit.',
    'Move input over to the new Input System.',
    'Add save and load for player progress.',
  ],
  agent: [
    'Cache the GetComponent calls in Update.',
    'Add a dash ability with a cooldown.',
    'Write EditMode tests for the damage math.',
  ],
};

/**
 * Opening prompts for an EXTERNAL agent — one set, not three.
 *
 * Arcane's `mode` is a property of Arcane's own loop: it swaps the toolset and
 * the system prompt before the vendor call. An external agent receives none of
 * that — it runs its own loop, and exposes its own equivalent (plan mode,
 * accept-edits, …) as session config options rendered in the composer. So the
 * mode the user last left the Arcane pill on says nothing about what an
 * external agent will do with a starter, and picking starters by it was
 * describing a setting that isn't in the request.
 *
 * Deliberately disjoint from `STARTERS`: a shared string would make the two
 * sets look interchangeable, which is exactly the confusion being fixed.
 */
export const EXTERNAL_STARTERS: string[] = [
  'Walk me through how this project is structured.',
  'Find the performance problems in this scene and fix them.',
  'Add a dash ability with a cooldown, then test it.',
];

/**
 * The starters to offer, given who is going to answer.
 *
 * `mode` is only consulted for the Arcane agent, because it is only real for
 * the Arcane agent.
 */
/**
 * What to say in place of the mode ladder when an external agent will answer.
 *
 * The ladder answers "what will pressing Enter do?" with three rungs the user
 * can pick between. An external agent gives that answer itself, so the slot
 * gets the two facts that actually change how the next send behaves — whose
 * account it spends and where its controls live — rather than a paragraph
 * about agent loops, which is a description of our plumbing and not something
 * the user operates.
 *
 * The name is data rather than literal copy so the block does not go stale the
 * way hardcoded Claude specifics have before (see CLAUDE.md on the previous
 * integration).
 */
export interface ExternalAgentBrief {
  name: string;
  /** One clause each; rendered as separate lines, so no sentence runs long. */
  facts: string[];
}

const EXTERNAL_BRIEFS: Record<string, ExternalAgentBrief> = {
  claude: {
    name: 'Claude Code',
    facts: [
      'Runs on your Anthropic account, with its own tools and permissions.',
      'Set its mode, model and effort in the toolbar below.',
    ],
  },
};

/** The brief for an external agent, or `null` when Arcane's own loop answers. */
export function externalAgentBrief(agent: AgentKind): ExternalAgentBrief | null {
  return isExternalAgent(agent) ? (EXTERNAL_BRIEFS[agent] ?? null) : null;
}

export function startersFor(agent: AgentKind, mode: ChatMode): string[] {
  return isExternalAgent(agent) ? EXTERNAL_STARTERS : STARTERS[mode];
}

export type IndexStatus = 'idle' | 'building' | 'ready' | 'error';

export interface GroundingInput {
  /** Folder name of the open workspace; null when no folder is open. */
  workspaceName: string | null;
  isUnityProject: boolean;
  unityVersion: string | null;
  indexStatus: IndexStatus;
  /** Assets carrying a GUID, once the index has been built. */
  assetCount: number | null;
}

/**
 * The one line above the empty state, naming what the assistant is looking at.
 *
 * It exists to answer "does this thing actually know my project?" before the
 * first message, so it reports real index state and never claims more than it
 * has: a count only appears once the index is genuinely ready and non-zero,
 * and a project with no index yet says so rather than padding the line.
 */
export function groundingLabel(input: GroundingInput): string {
  const { workspaceName, isUnityProject, unityVersion, indexStatus, assetCount } = input;

  if (!workspaceName) return 'Open a folder to start';
  if (!isUnityProject) return workspaceName;

  const unity = unityVersion ? `Unity ${unityVersion}` : 'Unity project';

  if (indexStatus === 'building') return `Indexing ${workspaceName}…`;
  if (indexStatus === 'ready' && assetCount !== null && assetCount > 0) {
    return `${assetCount.toLocaleString('en-US')} assets indexed · ${unity}`;
  }
  return `${workspaceName} · ${unity}`;
}
