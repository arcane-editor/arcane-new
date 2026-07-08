/**
 * CLI: run the eval task set against one model config.
 *
 *   bun tooling/unity-eval/run-eval.ts \
 *     --base-url https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1 \
 *     --api-key-env CF_API_TOKEN --model @cf/moonshotai/kimi-k2.7-code \
 *     --label cf-mid [--filter grounding] [--reasoning-level high]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createEvalStreamFn } from './eval-stream';
import { runTask } from './run-task';
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

const tasks = TASKS.filter((t) => !values.filter || t.id.includes(values.filter) || t.family.includes(values.filter));
const usage = { input: 0, output: 0, requests: 0 };
const streamFn = createEvalStreamFn({ baseUrl, apiKey, model, label, reasoningLevel }, usage);

const results: TaskResult[] = [];
for (const task of tasks) {
  console.error(`▶ ${task.id} …`);
  const r = await runTask(task, streamFn, usage);
  console.error(`  ${r.pass ? '✅' : '❌'} (${r.turns} turns, ${(r.wallMs / 1000).toFixed(1)}s)`);
  results.push(r);
}

const resultsDir = new URL('./results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(resultsDir, `${stamp}-${label}.json`);
await writeFile(outPath, JSON.stringify({ label, model, baseUrl, usage, results }, null, 2));

console.log(renderReport(results, label));
console.error(`\nSaved: ${outPath} — total tokens in/out: ${usage.input}/${usage.output} over ${usage.requests} requests`);
