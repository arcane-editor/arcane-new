/**
 * Content and copy rules for the chat's empty state.
 *
 * Pure and separate from the component for the reason `layout-sizes.ts` gives:
 * this project has no component-test infrastructure, so anything worth
 * verifying lives outside the React wiring.
 */

import type { ChatMode } from '../services/types';

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
