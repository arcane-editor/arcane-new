/**
 * Headless replacement for unity-facts.ts: derives the "Unity project facts"
 * prompt block directly from fixture files (no Tauri, no stores).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

type RenderPipeline = 'URP' | 'HDRP' | 'Built-in';

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
  inputSystem: 'New' | 'Legacy';
}

interface RawFixtureFacts {
  version: string;
  pipeline: RenderPipeline;
  isNewInput: boolean;
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

  return { version, pipeline, isNewInput: !!deps['com.unity.inputsystem'] };
}

export async function buildFixtureFacts(fixtureDir: string): Promise<string> {
  const { version, pipeline, isNewInput } = await detectFixtureFacts(fixtureDir);
  const input = isNewInput ? 'Input System (new)' : 'Input Manager (legacy)';

  return [
    '## Unity project facts (authoritative — match these)',
    `- Unity version: ${version}`,
    `- Render pipeline: ${pipeline}`,
    `- Input system: ${input}`,
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
  const { version, pipeline, isNewInput } = await detectFixtureFacts(fixtureDir);
  return { unityVersion: version, renderPipeline: pipeline, inputSystem: isNewInput ? 'New' : 'Legacy' };
}
