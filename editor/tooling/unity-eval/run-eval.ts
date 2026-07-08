/**
 * CLI: run the eval task set against one model config.
 *
 *   bun tooling/unity-eval/run-eval.ts \
 *     --base-url https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1 \
 *     --api-key-env CF_API_TOKEN --model @cf/moonshotai/kimi-k2.7-code \
 *     --label cf-mid [--filter grounding] [--reasoning-level high]
 *
 * Grounding (`unity_api_search` / `get_unity_docs`) replays committed
 * recordings by default — no network, deterministic, CI-safe (see
 * `api-recordings.ts`). Pass `--record` to instead hit a real arcane-server
 * (mirroring Variant B in README.md) and capture fresh recordings:
 *
 *   cd arcane-server && npm run dev   # separate terminal, local wrangler dev
 *   DEV_JWT=<token> bun tooling/unity-eval/run-eval.ts \
 *     --base-url http://localhost:8787/v1 --api-key-env DEV_JWT --model unused \
 *     --label local-record --record [--server-url http://localhost:8787] \
 *     [--recordings-dir <dir>]
 *
 * `--record` reuses the eval's existing auth mechanism — the same bearer
 * token resolved via `--api-key-env` is sent to `--server-url` (default
 * `http://localhost:8787`) for the grounding endpoints, since a `--record`
 * run's chat requests already have to target that same local arcane-server
 * instance (Variant B) for the token to be valid.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createEvalStreamFn } from './eval-stream';
import { runTask, type GroundingConfig } from './run-task';
import { renderReport } from './report';
import { TASKS } from './tasks';
import type { TaskResult } from './eval-types';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    'api-key-env': { type: 'string' },
    model: { type: 'string' },
    label: { type: 'string' },
    filter: { type: 'string' },
    'reasoning-level': { type: 'string' },
    record: { type: 'boolean', default: false },
    'server-url': { type: 'string', default: 'http://localhost:8787' },
    'recordings-dir': { type: 'string' },
  },
});

const baseUrl = values['base-url'];
const apiKeyEnv = values['api-key-env'];
const model = values.model;
const label = (values.label ?? model ?? 'run').replace(/[^\w.@-]/g, '-');
const reasoningLevel = values['reasoning-level'];
if (!baseUrl || !apiKeyEnv || !model) {
  console.error('Required: --base-url --api-key-env --model. See file header.');
  process.exit(1);
}
const apiKey = process.env[apiKeyEnv];
if (!apiKey) {
  console.error(`Env var ${apiKeyEnv} is not set.`);
  process.exit(1);
}

const groundingConfig: GroundingConfig = values.record
  ? { recordingsDir: values['recordings-dir'], record: { serverUrl: values['server-url'], token: apiKey } }
  : { recordingsDir: values['recordings-dir'] };
if (values.record) {
  console.error(
    `[unity-eval] --record: capturing live grounding responses from ${values['server-url']} into ` +
      `${values['recordings-dir'] ?? 'fixtures/api-recordings/'} (network calls WILL be made).`,
  );
}

const tasks = TASKS.filter((t) => !values.filter || t.id.includes(values.filter) || t.family.includes(values.filter));
const usage = { input: 0, output: 0, requests: 0 };
const streamFn = createEvalStreamFn({ baseUrl, apiKey, model, label, reasoningLevel }, usage);

const results: TaskResult[] = [];
for (const task of tasks) {
  console.error(`▶ ${task.id} …`);
  const r = await runTask(task, streamFn, usage, { grounding: groundingConfig });
  console.error(`  ${r.pass ? '✅' : '❌'} (${r.turns} turns, ${(r.wallMs / 1000).toFixed(1)}s)`);
  results.push(r);
}

const groundingCacheMisses = results.reduce((sum, r) => sum + r.groundingCacheMisses, 0);
const recordFailures = results.reduce((sum, r) => sum + r.recordFailures, 0);

const resultsDir = new URL('./results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(resultsDir, `${stamp}-${label}.json`);
await writeFile(
  outPath,
  JSON.stringify({ label, model, baseUrl, usage, groundingCacheMisses, recordFailures, results }, null, 2),
);

console.log(renderReport(results, label));
console.error(`\nSaved: ${outPath} — total tokens in/out: ${usage.input}/${usage.output} over ${usage.requests} requests`);
if (groundingCacheMisses > 0) {
  console.error(
    `[unity-eval] ${groundingCacheMisses} grounding cache miss(es) — see warnings above. ` +
      `Re-record with --record if these are expected (new model/prompt phrasing).`,
  );
}
if (recordFailures > 0) {
  console.error(
    `[unity-eval] ${recordFailures} grounding record failure/failures — see warnings above. ` +
      `Check token/server status and re-record with --record.`,
  );
}
