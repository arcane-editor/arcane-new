/**
 * CLI: run the eval task set against one model config.
 *
 *   bun tooling/unity-eval/run-eval.ts \
 *     --base-url https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1 \
 *     --api-key-env CF_API_TOKEN --model @cf/moonshotai/kimi-k2.7-code \
 *     --label cf-mid [--filter grounding] [--reasoning-level high] [--repeats 3]
 *
 * `--preset cf-low|cf-mid|cf-high|server-mid` (`presets.ts`) fills in
 * `--base-url`/`--api-key-env`/`--model`/`--reasoning-level`/`--label` from a
 * known-good per-model config — the `cf-*` presets need `CF_ACCOUNT_ID` +
 * `CF_API_TOKEN` in the environment (Variant A), `server-mid` needs
 * `DEV_JWT` against a locally running arcane-server (Variant B; see
 * README.md). Any explicit flag passed alongside `--preset` overrides that
 * preset's value for just that field:
 *
 *   CF_ACCOUNT_ID=<id> CF_API_TOKEN=<token> bun tooling/unity-eval/run-eval.ts --preset cf-mid
 *
 * `--repeats N` (default 1) runs each task N times sequentially and reduces
 * the N per-attempt results to one majority verdict per task via
 * `aggregate.ts`'s `aggregateAttempts` (pass iff `passCount >= ceil(N/2)`) —
 * see that file and README.md's "Results JSON" section for the shape this
 * adds to the output.
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
import { createEvalStreamFn, type EvalRequestState } from './eval-stream';
import { runTask, type GroundingConfig } from './run-task';
import { renderReport } from './report';
import { aggregateAttempts, type AggregatedTaskResult } from './aggregate';
import { TASKS } from './tasks';
import type { TaskResult } from './eval-types';
import { resolvePreset } from './presets';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    'api-key-env': { type: 'string' },
    model: { type: 'string' },
    label: { type: 'string' },
    filter: { type: 'string' },
    'reasoning-level': { type: 'string' },
    preset: { type: 'string' },
    record: { type: 'boolean', default: false },
    'server-url': { type: 'string', default: 'http://localhost:8787' },
    // Bearer token env var for --record's grounding server when it differs from
    // the chat endpoint's token (e.g. chat → local wrangler dev with a dev JWT,
    // recording → production arcane-server with a prod JWT). Falls back to
    // --api-key-env when omitted.
    'record-api-key-env': { type: 'string' },
    'recordings-dir': { type: 'string' },
    repeats: { type: 'string', default: '1' },
  },
});

let resolved: ReturnType<typeof resolvePreset>;
try {
  resolved = resolvePreset(
    values.preset,
    {
      baseUrl: values['base-url'],
      apiKeyEnv: values['api-key-env'],
      model: values.model,
      reasoningLevel: values['reasoning-level'],
      label: values.label,
    },
    process.env,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const baseUrl = resolved.baseUrl;
const apiKeyEnv = resolved.apiKeyEnv;
const model = resolved.model;
const label = (resolved.label ?? model ?? 'run').replace(/[^\w.@-]/g, '-');
const reasoningLevel = resolved.reasoningLevel;
if (!baseUrl || !apiKeyEnv || !model) {
  console.error(
    'Required: --base-url --api-key-env --model (or --preset cf-low|cf-mid|cf-high|server-mid). ' +
      'See file header.',
  );
  process.exit(1);
}
const apiKey = process.env[apiKeyEnv];
if (!apiKey) {
  console.error(`Env var ${apiKeyEnv} is not set.`);
  process.exit(1);
}
const repeats = Number.parseInt(values.repeats ?? '1', 10);
if (!Number.isInteger(repeats) || repeats < 1) {
  console.error(`--repeats must be a positive integer, got: ${values.repeats}`);
  process.exit(1);
}

const recordKeyEnv = values['record-api-key-env'];
const recordToken = recordKeyEnv ? process.env[recordKeyEnv] : apiKey;
if (values.record && recordKeyEnv && !recordToken) {
  console.error(`Env var ${recordKeyEnv} (--record-api-key-env) is not set.`);
  process.exit(1);
}
const groundingConfig: GroundingConfig = values.record
  ? { recordingsDir: values['recordings-dir'], record: { serverUrl: values['server-url'], token: recordToken! } }
  : { recordingsDir: values['recordings-dir'] };
if (values.record) {
  console.error(
    `[unity-eval] --record: capturing live grounding responses from ${values['server-url']} into ` +
      `${values['recordings-dir'] ?? 'fixtures/api-recordings/'} (network calls WILL be made).`,
  );
}

const tasks = TASKS.filter((t) => !values.filter || t.id.includes(values.filter) || t.family.includes(values.filter));
const usage = { input: 0, output: 0, requests: 0 };
// Shared across every task/repeat in this run; `runTask` mutates
// `.maxTokens` per task mode right before each `agent.prompt()` call (see
// `eval-stream.ts`'s `EvalRequestState` doc comment).
const requestState: EvalRequestState = { maxTokens: 8192 };
const streamFn = createEvalStreamFn({ baseUrl, apiKey, model, label, reasoningLevel }, usage, requestState);

const aggregated: AggregatedTaskResult[] = [];
for (const task of tasks) {
  const attempts: TaskResult[] = [];
  for (let attempt = 1; attempt <= repeats; attempt++) {
    const suffix = repeats > 1 ? ` (attempt ${attempt}/${repeats})` : '';
    console.error(`▶ ${task.id}${suffix} …`);
    const r = await runTask(task, streamFn, usage, { grounding: groundingConfig, requestState });
    console.error(`  ${r.pass ? '✅' : '❌'} (${r.turns} turns, ${(r.wallMs / 1000).toFixed(1)}s)`);
    attempts.push(r);
  }
  const agg = aggregateAttempts(attempts);
  if (agg.flaky) {
    console.error(`  ⚠ flaky: ${task.id} — ${agg.passCount}/${agg.repeats} attempts passed`);
  }
  aggregated.push(agg);
}

const groundingCacheMisses = aggregated.reduce(
  (sum, r) => sum + r.attempts.reduce((s, a) => s + a.groundingCacheMisses, 0),
  0,
);
const recordFailures = aggregated.reduce(
  (sum, r) => sum + r.attempts.reduce((s, a) => s + a.recordFailures, 0),
  0,
);
const groundingLintHits = aggregated.reduce(
  (sum, r) => sum + r.attempts.reduce((s, a) => s + a.groundingLintHits, 0),
  0,
);

const resultsDir = new URL('./results/', import.meta.url).pathname;
await mkdir(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(resultsDir, `${stamp}-${label}.json`);
await writeFile(
  outPath,
  JSON.stringify(
    {
      label,
      model,
      baseUrl,
      usage,
      repeats,
      groundingCacheMisses,
      recordFailures,
      groundingLintHits,
      results: aggregated,
    },
    null,
    2,
  ),
);

console.log(renderReport(aggregated, label));
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
if (groundingLintHits > 0) {
  console.error(
    `[unity-eval] ${groundingLintHits} ask-mode grounding-linter revise cycle(s) fired — ` +
      `the affected task(s) were graded on their post-revise answer (see groundingLintHits per task).`,
  );
}
