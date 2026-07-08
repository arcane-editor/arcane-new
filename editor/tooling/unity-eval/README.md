# Unity eval

Regression gate for Arcane's Unity agent: prompt, model, and routing changes
must not silently make the agent worse at Unity work. Per the approved
2026-07-07 design (`../../AI-SPEC.md` § Recommended Approach), this harness
drives the **real** vendor agent loop (`src/features/ai-panel/services/vendor`)
— same agent loop, message conversion, and system prompts — against small
fixture Unity projects, headlessly (no Tauri, no Unity Editor, no browser).
The tool set is reduced, though: see "Fidelity gaps" below before reading
too much into a single number.

## What it is

24 tasks across three families:

- **codegen** (8) — agent mode, asked to create/extend a script. Scored by
  `file_exists` / `file_contains` / `file_not_contains` + `analyzer_clean`.
  4 of the 8 are grounding-heavy "trap" tasks on `urp2022-legacyinput` (see
  below): the correct code still has to use *this project's* legacy input
  approach and URP/Lit shader property despite the render pipeline being URP.
- **grounding** (12) — ask mode, asked a question with a version/pipeline-
  dependent correct answer (URP vs Built-in color/texture property, new Input
  System vs legacy `Input.GetAxis`, deprecated-API awareness). Scored by
  `answer_matches` / `answer_not_matches` against the model's final text
  answer, and — for `grounding-urp-shader-name`, the one task where the
  correct answer is an exact shader-PATH string the injected facts block
  doesn't itself state — a `tool_called: unity_api_search` check that the
  model actually grounded itself instead of guessing. (Since P2.1's
  contrastive anti-default facts, the injected block *does* state the exact
  shader-property strings, so `grounding-urp-texture` and
  `grounding-trap-shader` no longer need this check — see the per-task
  comments in `tasks.ts`.)
- **agentic** (4) — agent mode, multi-step tasks requiring investigation
  (find a bug, not just apply a patch) and Unity-safe editing (e.g. rename a
  serialized field without losing Inspector-set values). Scored by file
  checks and `analyzer_clean`.

Each task runs against a **fresh copy** of its fixture in a temp directory, so
tasks that touch the same file (e.g. `agentic-update-perf` and
`agentic-lifecycle-typo`, both on `Mover.cs`) never interfere with each other.

### `analyzer_clean` — what it actually gates

`analyzer_clean` only fails a task on **error-severity** findings. Of the
Microsoft.Unity.Analyzers-style rules ported into `checks.ts`, the sole rule
with `defaultSeverity: 'error'` is `editor-api-in-runtime` (catches `using
UnityEditor;` / `UnityEditor.*` references leaking into a runtime assembly,
which breaks player builds). Every other rule defaults to `warning`/`info`
and cannot flip this check either way. The bugs seeded in `Mover.cs` and
`PlayerController.cs` (see below) are intentionally **not** analyzer-detected
— they're checked via `file_contains`/`file_not_contains` patterns instead,
because they're semantic/lifecycle bugs (a null Rigidbody reference, a
lowercase `update`), not `UNT####`-style static-analysis findings.

Unity `-batchmode` compile checking (the design doc's final verification
tier) is **deferred** until a Unity install exists on the eval machine.
`analyzer_clean` stands in as the compile-adjacent signal until then.

## How to run

```bash
cd editor
bun run eval -- --base-url <url> --api-key-env <ENV_VAR> --model <model-id> --label <run-name> [--filter <substring>] [--reasoning-level <low|mid|high|super>] [--repeats <N>]
```

- `--base-url` — an OpenAI-compatible base (no trailing `/chat/completions`;
  the harness appends that itself).
- `--api-key-env` — name of an env var holding the bearer token (never pass
  the key on the command line).
- `--model` — model id as understood by that endpoint.
- `--label` — short name embedded in the results filename and report.
- `--filter` — optional; matches against task id or family substring, e.g.
  `--filter grounding` or `--filter codegen-dash`.
- `--reasoning-level` — optional; when set, every request body gains
  `metadata: { reasoningLevel: <value> }`. This only matters when
  `--base-url` points at an **arcane-server** instance (its `/v1/chat/completions`
  route reads `metadata.reasoningLevel` to pick a model tier — see
  `resolveModelFromRequest()` in `arcane-server/src/routes/chat.ts`). It's a
  no-op against a raw Workers AI / vendor endpoint that doesn't look at it.
- `--repeats` — optional, default `1`. Runs each task `N` times sequentially
  and reduces the attempts to one majority verdict per task (pass iff
  `passCount >= ceil(N/2)` — see `aggregate.ts`). Use this to separate a real
  regression from run-to-run noise (see "Run-to-run variance is real" below)
  at the cost of an `N`×increase in requests/cost/time.

### Per-model presets (`--preset`)

`--preset cf-low|cf-mid|cf-high|server-mid` (`presets.ts`) fills in
`--base-url`/`--api-key-env`/`--model`/`--reasoning-level`/`--label` from a
known-good config for that model/tier, so you don't have to hand-copy model
ids out of `arcane-server/src/config/plans.ts`'s `INTENSITY_CONFIG`. Any
explicit flag passed alongside `--preset` overrides that preset's value for
just that field. Preset labels mirror `results/baselines/` naming
(`cf-mid-kimi-k2.7`, `cf-high-glm-5.2`) so a preset run's result JSON slots in
next to the existing baselines without a rename.

| Preset | Model | Needs |
|---|---|---|
| `cf-low` | `@cf/qwen/qwen2.5-coder-32b-instruct` | `CF_ACCOUNT_ID`, `CF_API_TOKEN` |
| `cf-mid` | `@cf/moonshotai/kimi-k2.7-code` | `CF_ACCOUNT_ID`, `CF_API_TOKEN` |
| `cf-high` | `@cf/zai-org/glm-5.2` | `CF_ACCOUNT_ID`, `CF_API_TOKEN` |
| `server-mid` | (server-routed, Variant B) | `DEV_JWT` against a local `wrangler dev` arcane-server |

Single preset:

```bash
cd editor && CF_ACCOUNT_ID=<id> CF_API_TOKEN=<token> bun run eval -- --preset cf-mid
```

Matrix — run every `cf-*` preset back to back (e.g. before/after a harness or
prompt change):

```bash
cd editor
for preset in cf-low cf-mid cf-high; do
  CF_ACCOUNT_ID=<id> CF_API_TOKEN=<token> bun run eval -- --preset "$preset" --label "$preset-after"
done
```

**Every harness, prompt, or routing change must be validated against at
least `cf-low` and `cf-mid` before merging** — `cf-low` is the tier most
likely to expose a prompt/tool change that only works when the model is
already strong, and `cf-mid` is today's production default; a change that
only gets tested against `cf-high` can silently regress the two tiers most
users actually run on.

### Results JSON

Output: a markdown report on stdout, and a JSON file written to
`tooling/unity-eval/results/<timestamp>-<label>.json`. Top-level shape:

```jsonc
{
  "label": "...", "model": "...", "baseUrl": "...",
  "usage": { "input": 0, "output": 0, "requests": 0 },
  "repeats": 1,                 // the --repeats value this run used
  "groundingCacheMisses": 0,
  "recordFailures": 0,
  "results": [
    {
      "taskId": "...", "family": "...",
      "pass": true,              // aggregated verdict, see aggregate.ts
      "passCount": 1, "repeats": 1,
      "flaky": false,            // true when attempts disagreed
      "attempts": [ /* 1..N TaskResult objects: pass, checks, turns, wallMs, inputTokens, outputTokens, error?, groundingCacheMisses, recordFailures */ ]
    },
    // ...
  ]
}
```

**Shape note (post-`--repeats`):** each `results[]` entry used to *be* a flat
`TaskResult` (with `turns`/`wallMs`/`checks`/etc. at the top level). It's now
an aggregated wrapper around 1..N `TaskResult`s in `attempts[]`, even at the
default `--repeats 1` — `taskId`, `family`, and `pass` still read the same at
the top level (so a naive `results[i].pass` check for the baseline-comparison
workflow still works unchanged), but per-attempt detail moved to
`attempts[0]` instead of the entry itself. `report.ts`'s table adds a `Score`
column (`passCount/repeats`) and marks a task `~` when its attempts disagreed
(flaky); the totals row counts aggregated verdicts, not raw attempts.

The whole `results/` directory is gitignored (run output is an artifact, not
source) — when you want to lock in a baseline for comparison, copy the JSON
into `results/baselines/` and force-add it
(`git add -f tooling/unity-eval/results/baselines/<file>.json`); that curated
subdir is the one exception meant to be committed.

## Analyzer gate (agent-mode write/edit)

Agent-mode `write`/`edit` on a `.cs` path are wrapped with `eval-gates.ts`'s
`withEvalAnalyzerGate` — the eval's analog of production's F-5.3 analyzer gate
(`src/features/ai-panel/services/unity-tools/analyzer-gate.ts`,
`withUnityAnalyzerGate`, wired via `wrapCs` in `agent-service.ts`). After a
`.cs` write/edit, it re-reads the resulting file and runs the same ported
error-severity rule `analyzer_clean` uses (`analyzer-rule.ts` — only
`editor-api-in-runtime` can ever produce an error-severity finding, see that
file's header); if any error-severity findings were introduced, it appends
them to the tool result using production's exact
`[Unity analyzers] N error-severity issue(s)…` message so the eval agent gets
the same in-loop repair stimulus production gives it. Without this gate, eval
agent tasks never saw the findings that drive real self-correction turns —
`analyzer_clean` would only catch the *final* state, not exercise the repair
loop itself. `ask` mode has no write/edit tools, so the gate never applies
there.

## Grounding tools (`unity_api_search` / `get_unity_docs`)

Both `ask` and `agent` mode tasks get the same Unity read tools production
wires for every mode (`agent-service.ts`'s mode→tool map) — including
`unity_api_search`, the version-accurate API/docs grounding tool that hits
`arcane-server`'s `/v1/unity/api/search` + `/lookup` routes in production.
Since the eval must stay offline, deterministic, and CI-safe, it never talks
to that server directly. Instead `api-recordings.ts` implements the same
`UnityApiClient` interface (`unity-tools/api-search-tool.ts`) two ways:

- **Replay (default, every normal run).** Reads committed JSON recordings
  from `fixtures/api-recordings/<fixture-name>/<hash>.json`, where
  `<hash>` is a sha256 of the *normalized* request (`{ endpoint, query |
  type+member, unityVersion, renderPipeline, inputSystem }` — query text is
  trimmed, lowercased, and has internal whitespace collapsed first, so
  near-identical phrasing across runs/models still hits the same recording).
  Never touches the network: a cache miss logs one warning line to stderr
  (endpoint, normalized query/type+member, fixture) and returns
  `{ ok: false, reason: 'offline' }` — the same shape `unity_api_search`
  already renders as `[Unity grounding UNAVAILABLE: offline] ...`.
- **Record (`--record`).** Performs the real HTTP call against a live
  arcane-server and writes each response — success or failure — to its
  recording file before returning it, so a `--record` run is always live
  *and* capturing:

  ```bash
  # 1. start arcane-server locally (see "Variant B" below for minting a JWT)
  cd arcane-server && npm run dev

  # 2. run with --record, reusing the same --api-key-env token as the
  #    arcane-server bearer token (no separate auth flag)
  cd editor && DEV_JWT=<token> bun run eval -- \
    --base-url http://localhost:8787/v1 --api-key-env DEV_JWT --model unused \
    --label local-record --record \
    [--server-url http://localhost:8787] [--recordings-dir <dir>]
  ```

  `--server-url` defaults to `http://localhost:8787`; `--recordings-dir`
  overrides the default `fixtures/api-recordings/` (useful for a scratch
  re-record you don't intend to commit).

**Known limitation.** Replay hits depend on the model repeating normalized
query text close enough to something already recorded. New models, new
prompts, or a model just phrasing a search differently *will* produce
misses — this is expected, not silent: each miss logs a warning and
increments a per-task counter surfaced as `groundingCacheMisses` on the
`TaskResult` and summed into the run's results JSON. A run with nonzero
`groundingCacheMisses` isn't automatically wrong, but it means some
`unity_api_search` calls that turn saw `UNAVAILABLE: offline` instead of
real data — treat elevated miss counts as a cue to re-record (`--record` is
cheap: it's just one more live pass over the same tasks). Recordings also
carry a `recordedAt` timestamp — they're a point-in-time snapshot of
whatever the corpus (Vectorize/D1) contained at capture time, so a stale
recording can silently diverge from what production would return today if
the corpus has since been re-ingested.

## Adding a task

Add an entry to the `TASKS` array in `tasks.ts`:

```ts
{
  id: 'family-short-slug',              // unique, kebab-case
  family: 'codegen' | 'grounding' | 'agentic',
  fixture: 'builtin-legacy' | 'urp-newinput' | 'urp2022-legacyinput',
  mode: 'agent' | 'ask',                // 'ask' gets no write/edit/bash tools
  prompt: 'What to ask the agent.',
  checks: [ /* one or more CheckSpec */ ],
  maxTurns: 12,                         // optional, default 12 (soft cap — an
                                         // over-cap run fails with "max turns
                                         // exceeded")
}
```

Check types (`eval-types.ts`):

| type | fields | checks |
|---|---|---|
| `file_exists` | `path` | file exists in the task's workDir |
| `file_contains` | `path`, `pattern`, `flags?` | regex matches file content |
| `file_not_contains` | `path`, `pattern`, `flags?` | regex does not match file content |
| `analyzer_clean` | `glob` | no error-severity `editor-api-in-runtime` findings across matched files |
| `answer_matches` | `pattern`, `flags?` | regex matches the model's final text answer |
| `answer_not_matches` | `pattern`, `flags?` | regex does not match the model's final text answer |
| `tool_called` | `tool` | the named tool (`AgentTool.name`, e.g. `unity_api_search`) was executed at least once during the run |
| `tool_not_called` | `tool` | the named tool was never executed during the run |

`tool_called`/`tool_not_called` are scored against `TaskResult.toolCalls` — a
chronological list of tool names recorded on the agent loop's
`tool_execution_start` event (`run-task.ts`), i.e. tools that actually ran,
not merely ones the model attempted to call. Available in both `ask` and
`agent` mode, since Unity grounding tools (`unity_api_search`,
`get_unity_docs`) are wired into every mode (see "Grounding tools" below).

A task passes only if every check passes and the run didn't error out or
exceed `maxTurns`. `tasks.test.ts` runs pure structural self-tests over the
whole `TASKS` array (unique ids, fixtures that exist on disk, valid check
kinds, ask-mode tasks never asserting a file-mutation check, agent-mode
codegen tasks always asserting at least one file check) — no LLM involved.

## Fixtures

Three minimal Unity project skeletons live under `fixtures/`, each with a real
`ProjectSettings/ProjectVersion.txt` and `Packages/manifest.json` so
`fixture-facts.ts` can derive version/pipeline/input facts the same way the
real app's `unity-facts.ts` does — this is what lets the grounding tasks
distinguish "correct for this project" answers from generically-plausible
but wrong ones.

- **`builtin-legacy`** — Built-in render pipeline, legacy Input Manager.
  - `Assets/Scripts/PlayerController.cs` — seeded bugs:
    - `Start()` calls `rb.linearVelocity = ...` but `rb` (a `Rigidbody`
      field) is never assigned via `GetComponent`/`RequireComponent` →
      `NullReferenceException` at runtime (`agentic-nre-fix`).
    - `[SerializeField] private float speed` — a rename target for the
      Inspector-safe-rename task (`agentic-fsa-rename`); the correct fix adds
      `[FormerlySerializedAs("speed")]` so existing scene/prefab data isn't
      orphaned.
  - `Assets/Scripts/Mover.cs` — seeded bug: `void update()` (lowercase) —
    looks like the Unity lifecycle method `Update()` but isn't, so it's
    never invoked by the engine (`agentic-lifecycle-typo`). It also calls
    `GetComponent<Rigidbody>()` inside that per-frame method, which is a
    separate perf problem once the casing is fixed (`agentic-update-perf`) —
    each task runs on its own fixture copy, so fixing one doesn't affect the
    other's starting state.
- **`urp-newinput`** — Universal Render Pipeline, new Input System.
  - `Assets/Scripts/Health.cs` — a minimal `MonoBehaviour` with `maxHealth`/
    `Current`, extended by `codegen-damage-event`.
- **`urp2022-legacyinput`** — the trap fixture: Universal Render Pipeline
  (2022.3 LTS) with the project still pinned to the LEGACY Input Manager
  (`ProjectSettings/ProjectSettings.asset`'s `activeInputHandler: 0`), and no
  `com.unity.inputsystem` package in the manifest either way. This is the
  cross-combination that breaks two shortcuts at once: inferring input
  system from package presence (there's nothing to infer from — the package
  is simply absent, same as `builtin-legacy`), and a model's training-default
  assumption that "URP project" implies "new Input System" (they're
  independent settings; plenty of real projects pair one render pipeline
  with either input system). `fixture-facts.ts` reads `activeInputHandler`
  from `ProjectSettings.asset` — the same authoritative source production's
  `detectInputSystem` uses — specifically so this fixture reports "legacy"
  correctly instead of guessing "new" from the render pipeline or the
  missing package. Also home to six of the tasks added to grow the suite
  past its original 12: `grounding-trap-shader`/`grounding-trap-input` (the
  same trap from both directions — URP-correct shader property, legacy-
  correct input) and four `codegen-trap-*` tasks that ask the agent to write
  code and check it lands on the right side of the trap.

## Baseline results

**Current baselines — captured 2026-07-08 (evening), 24 tasks × `--repeats 3`,
majority scoring.** Chat via Variant B (local `wrangler dev` arcane-server,
tier via `--reasoning-level`, remote Workers AI binding = real production
routing + the real frozen models); grounding recorded live from the
**production** server (`--record --server-url https://api.arcaneai.org
--record-api-key-env PROD_JWT`) so `unity_api_search` served real
Vectorize/D1 corpus data (zero record failures, zero cache misses). Result
JSONs live in `results/baselines/` (the `2026-07-08T16*/17*` trio).

| Label | Model | codegen | grounding | agentic | Total |
|---|---|---|---|---|---|
| cf-low-qwen2.5-coder | @cf/qwen/qwen2.5-coder-32b-instruct | 0/8 | 4/12 | 0/4 | **4/24** |
| cf-mid-kimi-k2.7 | @cf/moonshotai/kimi-k2.7-code | 8/8 | 8/12 | 4/4 | **20/24** |
| cf-high-glm-5.2 | @cf/zai-org/glm-5.2 | 8/8 | 8/12 | 4/4 | **20/24** |

What failed, concretely:

- **cf-low fails every write-task** (0/8 codegen, 0/4 agentic, zero transport
  errors) — a systematic tool/edit-format failure on qwen2.5-coder in this
  harness, not a knowledge gap. This is the biggest known headroom for
  harness work (loop robustness / edit-format tuning), tracked for Phase 3.
- mid: `grounding-urp-texture`, `grounding-urp-shader-name`,
  `grounding-trap-shader` (+ flaky `grounding-input-read`).
- high: `grounding-urp-shader-name`, `grounding-trap-shader`
  (+ flaky `grounding-urp-color`, `grounding-trap-input`).
- The persistent misses are the **exact-name grounding trio** (the three
  tasks whose correct answer is a literal property/shader name the injected
  facts don't state) — the precise target of the Phase-2 contrastive-facts +
  answer-linter work.

**Corpus coverage caveat:** the grounding corpus (D1 + Vectorize) currently
contains **only Unity 6000.3**. `urp-newinput` was aligned to 6000.3.5f2 so
its grounding is real; `urp2022-legacyinput` (2022.3) is deliberately
uncovered — its tasks measure facts-only behavior under explicit
`grounding UNAVAILABLE`/no-matches conditions. Ingesting 2022.3/6000.0
corpora is an ops follow-up (see `arcane-server/scripts/README.md`).

An earlier same-day 3-tier run (kept only in local `results/`, not
baselines) was captured while every grounding call 500'd (local D1 missing
`unity_api_signatures`): low 4/24, mid 18/24, high 16/24. The +2/+4
mid/high delta against those runs is the measured value of working
version-matched grounding.

### Historical (12-task suite, 2026-07-08 morning)

| Label | codegen | grounding | agentic | Total |
|---|---|---|---|---|
| cf-mid-kimi-k2.7 | 4/4 | 3/4 | 4/4 | **11/12** |
| cf-high-glm-5.2 | 4/4 | 2/4 | 4/4 | **10/12** |

Captured against the original 4/4/4 suite with only the 5 fs tools wired, no
gates, `max_tokens: 8192`, before the fixture/version alignment — not
comparable to the current suite. Failures were the `_Color`-in-URP and
`Input.GetAxis`-under-new-Input-System leaks.

Caveats to keep honest:

- **Fidelity gaps.** *(Recorded 2026-07-08, ahead of the fixes below.)* The
  harness wired up only the 5 basic fs tools (read/list/write/edit/bash) — no
  `unity_api_search`, no analyzer/compile gates — even though the system
  prompts advertise those tools. So the grounding scores above measure the
  bare model's Unity knowledge *without* the product's grounding tools;
  production, which does have them, may do better. The harness also pinned
  `max_tokens: 8192` vs production's 16384 (chat) / 24576 (plan, edit). Since
  then: `unity_api_search` + `get_unity_docs` have been wired into every mode
  via replay/record recordings (see "Grounding tools" above); the
  error-severity analyzer gate is now wired into agent-mode write/edit (see
  "Analyzer gate" above); and `max_tokens` now matches production per task
  mode (`ask` → 16384, `agent` → 24576, see "How to run"). These baselines
  predate all three and should be re-captured to measure their effect. The
  **compile gate** (real Unity compiler errors fed back to the agent) remains
  open — it needs a live Unity bridge connection the headless eval doesn't
  have.
- **Run-to-run variance is real.** Grounding tasks flipped pass/fail between
  runs of the same model. Treat single-run deltas of ±1 task as noise; the
  12-task suite is a smoke gate, not a benchmark. Grow the task set before
  drawing fine-grained conclusions.
- **`answer_not_matches` is strict**: an answer that gives the right API but
  *also* mentions the wrong-pipeline one ("in Built-in you'd use `_Color`")
  scores as a fail. That strictness is intentional (hedged answers are what
  ungrounded models do) but it inflates the miss rate vs. human judgment —
  a candidate refinement when the suite grows.
- **On "is defaulting to high worth it":** on this small suite the mid model
  scored one task higher and ran ~30-50% faster. Within noise, but the
  burden of proof is now on `high` — revisit the default once the suite is
  bigger (see `docs/superpowers/specs/2026-07-07-unity-ai-differentiation-design.md`
  Phase 1 acceptance).
- A first, pre-retry attempt scored mid 8/12 / high 6/12 — **9 of 10 of
  those failures were Workers AI transients** (per-minute rate limit 3021,
  502/1031, dropped connections) plus multi-minute hangs, which motivated
  the retry + per-request-timeout hardening in `eval-stream.ts`. Kept out of
  `results/baselines/` deliberately; the transient-polluted JSONs remain in
  local `results/` history only.

The original run instructions (either variant works):

**Variant A — direct against Cloudflare's OpenAI-compatible endpoint**
(preferred; needs `CF_ACCOUNT_ID` and a `CF_API_TOKEN` with Workers AI read
permission — `wrangler whoami` or the dashboard):

```bash
# mid tier (default until this plan ships)
cd editor && CF_API_TOKEN=<token> bun run eval -- \
  --base-url https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1 \
  --api-key-env CF_API_TOKEN --model @cf/moonshotai/kimi-k2.7-code --label cf-mid-kimi-k2.7

# high tier (the new default effort)
cd editor && CF_API_TOKEN=<token> bun run eval -- \
  --base-url https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/v1 \
  --api-key-env CF_API_TOKEN --model @cf/zai-org/glm-5.2 --label cf-high-glm-5.2
```

**Variant B — fallback through a local `wrangler dev` arcane-server**, used
if Variant A rejects a model id or tool-call format. This exercises the real
routing path (`metadata.reasoningLevel` → `resolveModelFromRequest()` →
`INTENSITY_CONFIG` tier lookup, `arcane-server/src/routes/chat.ts`) instead
of naming a model id directly:

```bash
# 1. start arcane-server locally (default port 8787)
cd arcane-server && npm run dev

# 2. mint a dev JWT (arcane-server has no standalone dev-token script —
#    sign up/log in for a real one against the local instance)
curl -X POST http://localhost:8787/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"eval@example.com","password":"eval-password-123"}'
# copy the returned token into DEV_JWT

# 3. run the eval against it, selecting tier via --reasoning-level
#    (arcane-server ignores the request body's `model` field entirely —
#    resolveModelFromRequest() in chat.ts picks the model 100% server-side
#    from `metadata.reasoningLevel`, so `--model` here is just a required
#    CLI flag / label, not something the server reads)
cd editor && DEV_JWT=<token> bun run eval -- \
  --base-url http://localhost:8787/v1 \
  --api-key-env DEV_JWT --model unused --reasoning-level mid --label local-mid
cd editor && DEV_JWT=<token> bun run eval -- \
  --base-url http://localhost:8787/v1 \
  --api-key-env DEV_JWT --model unused --reasoning-level high --label local-high
```

When re-running baselines, copy the new result JSONs into
`results/baselines/` (`git add -f` — the parent `results/` dir is
gitignored) and update the table above.

## The rule

**Every prompt, model, or routing change ships with a before/after eval run
in its PR description.** Point both runs at the same model/label pattern
(e.g. `<name>-before` / `<name>-after`), and call out any task that flips
pass↔fail. A run that regresses a previously-passing task without an
explanation in the PR is a blocker, not a nit.
