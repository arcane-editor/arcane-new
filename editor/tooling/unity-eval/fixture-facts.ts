/**
 * Headless replacement for unity-facts.ts: derives the "Unity project facts"
 * prompt block directly from fixture files (no Tauri, no stores).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contrastFactLines } from '../../src/features/ai-panel/services/prompts/unity-contrast';
import {
  subsystemInventoryLine,
  type SubsystemInventory,
} from '../../src/features/ai-panel/services/prompts/subsystem-facts';
import { readdir } from 'node:fs/promises';

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

/** Every file under `dir`, recursively. Fixtures are small; no excludes needed. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/**
 * Headless equivalent of the subsystem inventory `unity-facts.ts` derives from
 * the Rust asset index and the analyzers' UI Toolkit snapshot.
 *
 * Counts are approximated from the file tree, which is what a fixture gives us:
 * an `.asset` count stands in for the instance count, and its type count is not
 * knowable without the GUID index, so it is reported as the number of distinct
 * `.asset` files' owning scripts — unavailable here, hence 0 types means the
 * line is omitted rather than guessed at.
 */
async function detectFixtureInventory(fixtureDir: string): Promise<SubsystemInventory> {
  const files = await walk(fixtureDir);
  const count = (ext: string) => files.filter((f) => f.toLowerCase().endsWith(ext)).length;

  const inputAssets = count('.inputactions');
  const documents = count('.uxml');

  return {
    // Types need the GUID index (which script a `.asset` instances), and the
    // eval has no Rust side. Reporting a count we cannot derive would make the
    // eval prompt diverge from production in the one direction that matters:
    // claiming knowledge we do not have.
    scriptableObjects: null,
    uiToolkit: documents > 0 ? { documents, stylesheets: count('.uss') } : null,
    input: inputAssets > 0 ? { assets: inputAssets, maps: 0 } : null,
  };
}

export async function buildFixtureFacts(fixtureDir: string): Promise<string> {
  const { version, pipeline, inputSystem } = await detectFixtureFacts(fixtureDir);
  const inventory = subsystemInventoryLine(await detectFixtureInventory(fixtureDir));

  return [
    '## Unity project facts (authoritative — match these)',
    `- Unity version: ${version}`,
    `- Render pipeline: ${pipeline}`,
    `- Input system: ${INPUT_SYSTEM_WORDING[inputSystem]}`,
    // The subsystem inventory line production always emits (subsystem-facts.ts).
    // The per-subsystem DETAIL blocks are correctly absent: production selects
    // them from the conversation's active file, and a headless eval run has no
    // open file, so `selectSubsystems` would return none there too. This
    // includes `uiDesignFactLines` (Task 16, B9) — like the ScriptableObject
    // and UI Toolkit detail blocks it sits next to, it is only appended when
    // `selected.includes('uiToolkit')`, so it is correctly absent here for
    // the exact same reason, not an oversight.
    ...(inventory ? [inventory] : []),
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
