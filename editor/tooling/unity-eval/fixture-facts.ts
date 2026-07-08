/**
 * Headless replacement for unity-facts.ts: derives the "Unity project facts"
 * prompt block directly from fixture files (no Tauri, no stores).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contrastFactLines } from '../../src/features/ai-panel/services/prompts/unity-contrast';

type RenderPipeline = 'URP' | 'HDRP' | 'Built-in';

/** Tri-state Unity input-system configuration (see `detectInputSystemState` below). */
type InputSystemState = 'Legacy' | 'New' | 'Both';

const INPUT_SYSTEM_WORDING: Record<InputSystemState, string> = {
  Legacy: 'Input Manager (legacy)',
  New: 'Input System (new)',
  Both: 'Both (Input Manager + Input System)',
};

/**
 * Structured equivalent of the grounding context production derives via
 * `getUnityGroundingContext()` (`ai-panel/services/prompts/unity-facts.ts`)
 * — same shape the version-accurate API tools (`unity_api_search`) key their
 * Vectorize/D1 filters on. Used to construct the eval's replay/record
 * grounding client (`api-recordings.ts`) instead of the store-backed getter.
 */
export interface FixtureGroundingContext {
  unityVersion: string;
  renderPipeline: RenderPipeline;
  inputSystem: InputSystemState;
}

interface RawFixtureFacts {
  version: string;
  pipeline: RenderPipeline;
  inputSystem: InputSystemState;
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Bun-safe PORT of `detectInputSystem` (`ai-panel/services/prompts/
 * unity-facts.ts`, ~lines 54-62): `ProjectSettings/ProjectSettings.asset`'s
 * `activeInputHandler` is Unity's authoritative input-system flag (0 =
 * legacy Input Manager, 1 = new Input System, 2 = both) — NOT
 * `com.unity.inputsystem` package presence, which is only a proxy and gets
 * it wrong for a project that added/kept the package without ever switching
 * `Edit > Project Settings > Player > Active Input Handling` (or the
 * reverse: switched to the new Input System while the package is still
 * present under a different name/version). Package presence is used below
 * ONLY as a fallback for fixtures that ship no `ProjectSettings.asset` at
 * all (matching this file's pre-existing fixtures, none of which have one).
 */
async function detectInputSystemState(
  fixtureDir: string,
  hasInputSystemPkg: boolean,
): Promise<InputSystemState> {
  const projectSettings = await tryRead(
    join(fixtureDir, 'ProjectSettings', 'ProjectSettings.asset'),
  );
  if (projectSettings) {
    const m = projectSettings.match(/activeInputHandler:\s*(\d)/);
    if (m) {
      return m[1] === '0' ? 'Legacy' : m[1] === '1' ? 'New' : 'Both';
    }
  }
  return hasInputSystemPkg ? 'New' : 'Legacy';
}

async function detectFixtureFacts(fixtureDir: string): Promise<RawFixtureFacts> {
  const versionTxt = await readFile(
    join(fixtureDir, 'ProjectSettings', 'ProjectVersion.txt'),
    'utf8',
  );
  const version = versionTxt.match(/m_EditorVersion:\s*(\S+)/)?.[1] ?? 'unknown';

  const manifest = JSON.parse(
    await readFile(join(fixtureDir, 'Packages', 'manifest.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const deps = manifest.dependencies ?? {};

  const pipeline: RenderPipeline = deps['com.unity.render-pipelines.universal']
    ? 'URP'
    : deps['com.unity.render-pipelines.high-definition']
      ? 'HDRP'
      : 'Built-in';

  const inputSystem = await detectInputSystemState(fixtureDir, !!deps['com.unity.inputsystem']);

  return { version, pipeline, inputSystem };
}

export async function buildFixtureFacts(fixtureDir: string): Promise<string> {
  const { version, pipeline, inputSystem } = await detectFixtureFacts(fixtureDir);

  return [
    '## Unity project facts (authoritative — match these)',
    `- Unity version: ${version}`,
    `- Render pipeline: ${pipeline}`,
    `- Input system: ${INPUT_SYSTEM_WORDING[inputSystem]}`,
    // Contrastive anti-default facts (P2.1, unity-contrast.ts) — ADDITIONS
    // only, derived from the SAME pipeline/inputSystem values just detected
    // above, so pre-existing fact strings above stay byte-identical.
    ...contrastFactLines({ renderPipeline: pipeline, inputSystem }),
  ].join('\n');
}

/**
 * Structured grounding context (version/pipeline/input) for the same
 * fixture `buildFixtureFacts` reads — feeds `createReplayApiClient` /
 * `createRecordingApiClient` (`api-recordings.ts`) so the eval's
 * `unity_api_search` tool keys its cache/requests exactly the way
 * production's `getUnityGroundingContext()` does.
 */
export async function buildFixtureGroundingContext(fixtureDir: string): Promise<FixtureGroundingContext> {
  const { version, pipeline, inputSystem } = await detectFixtureFacts(fixtureDir);
  return { unityVersion: version, renderPipeline: pipeline, inputSystem };
}
