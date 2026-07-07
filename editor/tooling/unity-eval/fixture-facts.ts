/**
 * Headless replacement for unity-facts.ts: derives the "Unity project facts"
 * prompt block directly from fixture files (no Tauri, no stores).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildFixtureFacts(fixtureDir: string): Promise<string> {
  const versionTxt = await readFile(
    join(fixtureDir, 'ProjectSettings', 'ProjectVersion.txt'),
    'utf8',
  );
  const version = versionTxt.match(/m_EditorVersion:\s*(\S+)/)?.[1] ?? 'unknown';

  const manifest = JSON.parse(
    await readFile(join(fixtureDir, 'Packages', 'manifest.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> };
  const deps = manifest.dependencies ?? {};

  const pipeline = deps['com.unity.render-pipelines.universal']
    ? 'URP'
    : deps['com.unity.render-pipelines.high-definition']
      ? 'HDRP'
      : 'Built-in';
  const input = deps['com.unity.inputsystem']
    ? 'Input System (new)'
    : 'Input Manager (legacy)';

  return [
    '## Unity project facts (authoritative — match these)',
    `- Unity version: ${version}`,
    `- Render pipeline: ${pipeline}`,
    `- Input system: ${input}`,
  ].join('\n');
}
