# Unity eval

Regression gate for Arcane's Unity agent: prompt, model, and routing changes
must not silently make the agent worse at Unity work. Per the approved
2026-07-07 design (`../../AI-SPEC.md` § Recommended Approach), this harness
drives the **real** vendor agent loop (`src/features/ai-panel/services/vendor`)
— same tools, same system prompts, same message conversion — against small
fixture Unity projects, headlessly (no Tauri, no Unity Editor, no browser).

## What it is

12 seed tasks across three families:

- **codegen** (4) — agent mode, asked to create/extend a script. Scored by
  `file_exists` / `file_contains` / `file_not_contains` + `analyzer_clean`.
- **grounding** (4) — ask mode, asked a question with a version/pipeline-
  dependent correct answer (URP vs Built-in color property, new Input System
  vs legacy `Input.GetAxis`). Scored by `answer_matches` / `answer_not_matches`
  against the model's final text answer.
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
bun run eval -- --base-url <url> --api-key-env <ENV_VAR> --model <model-id> --label <run-name> [--filter <substring>] [--reasoning-level <low|mid|high|super>]
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

Output: a markdown report on stdout, and a JSON file written to
`tooling/unity-eval/results/<timestamp>-<label>.json` (per-task pass/fail,
turn count, wall time, token usage). The whole `results/` directory is
gitignored (run output is an artifact, not source) — when you want to lock
in a baseline for comparison, copy the JSON into `results/baselines/` and
force-add it (`git add -f tooling/unity-eval/results/baselines/<file>.json`);
that curated subdir is the one exception meant to be committed.

## Adding a task

Add an entry to the `TASKS` array in `tasks.ts`:

```ts
{
  id: 'family-short-slug',              // unique, kebab-case
  family: 'codegen' | 'grounding' | 'agentic',
  fixture: 'builtin-legacy' | 'urp-newinput',
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

A task passes only if every check passes and the run didn't error out or
exceed `maxTurns`.

## Fixtures

Two minimal Unity project skeletons live under `fixtures/`, each with a real
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

## Baseline results

**PENDING** — not yet run. Baselines must be captured against the same
models arcane-server actually serves, via Cloudflare's OpenAI-compatible
endpoint, so the eval measures the real frozen lineup. Two variants,
depending on whether the OpenAI-compat endpoint accepts the model id/tool
calls cleanly:

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

Once run, copy both result JSONs into `results/baselines/` and fill in:

| Label | Model | codegen | grounding | agentic | Total |
|---|---|---|---|---|---|
| cf-mid-kimi-k2.7 | @cf/moonshotai/kimi-k2.7-code | ?/4 | ?/4 | ?/4 | ?/12 |
| cf-high-glm-5.2 | @cf/zai-org/glm-5.2 | ?/4 | ?/4 | ?/4 | ?/12 |

This pair is also the direct answer to "is defaulting to high worth it,"
in numbers instead of vibes.

## The rule

**Every prompt, model, or routing change ships with a before/after eval run
in its PR description.** Point both runs at the same model/label pattern
(e.g. `<name>-before` / `<name>-after`), and call out any task that flips
pass↔fail. A run that regresses a previously-passing task without an
explanation in the PR is a blocker, not a nit.
