# Unity Fine-Tune + Eval Growth Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the Unity eval from 12 → 44 tasks so it can gate a fine-tune, build the <$500 training-data pipeline (grounding pairs, repair pairs, verifier-filtered teacher traces), QLoRA-train a Unity-specialized open model on Together AI, and make an eval-gated go/no-go adoption decision.

**Architecture:** Three parts. (A) Eval growth in `editor/tooling/unity-eval/`: +32 hand-curated tasks (grounding-heavy — that's where both baselines failed), a third fixture, a `--repeats` flag for variance-aware gating, and fresh 44-task baselines. (B) Data pipeline in `editor/tooling/unity-finetune/`: three generators emitting OpenAI-chat-format JSONL — grounding pairs derived from the editor's deterministic migration maps + the server's `unity_api_signatures` D1 table (near-free), repair pairs from seeded corruptions scored by the eval's analyzer port, and teacher traces recorded by re-using `runTask` with a trace recorder, kept only when the task's checks pass (rejection sampling by verification). (C) Training + gate on Together AI (the single new account: teacher inference + LoRA fine-tune + serverless adapter serving), then a three-way eval (base vs fine-tune vs CF mid tier) and a written go/no-go.

**Tech Stack:** TypeScript + Bun (all generators/tests), existing unity-eval harness, wrangler (D1 export), Together AI REST API (`api.together.xyz`), curl/jq for API tasks.

## Global Constraints

- **Product model lineup stays frozen.** Nothing in this plan touches `arcane-server/src/config/plans.ts`, `llm-router.ts`, or any editor model routing. The fine-tune, if adopted, is wired in a LATER plan after the gate passes.
- **Exactly one new account: Together AI** (user constraint 2026-07-08: "prefer Cloudflare; only if not possible go elsewhere"). Verified impossible on CF: Workers AI has no training compute, and its LoRA serving supports only Mistral/Gemma/Llama-class bases ([docs](https://developers.cloudflare.com/workers-ai/features/fine-tunes/loras/)) — not Qwen-Coder. Teacher inference, training, and gate-serving all run on Together. The single API key lives in `editor/tooling/unity-finetune/.env` (gitignored) as `TOGETHER_API_KEY`; it is used OFFLINE only.
- **Budget ceiling $500 hard.** Every task that spends money appends a line to `editor/tooling/unity-finetune/BUDGET.md` (date, what, tokens, $). Planned envelope: teacher traces ≤$120, training ≤$150, eval/gate inference ≤$60, contingency the rest. Any task about to exceed its envelope STOPS and reports BLOCKED.
- **Base model:** primary `Qwen/Qwen3-Coder-30B-A3B-Instruct` IF Together's fine-tuning API lists it (Task 7 verifies); fallback `Qwen/Qwen2.5-Coder-14B-Instruct` (≤16B LoRA tier, $0.48/M training tokens). Teacher: `deepseek-ai/DeepSeek-V3.2` on Together (Task 7 verifies exact id; fallback the strongest Qwen3-Coder serverless model listed).
- **Dataset format:** OpenAI chat-completions JSONL (messages array incl. `tool_calls`/`tool` roles) — the exact wire format the Arcane loop emits via `convertToOpenAI` (`editor/src/features/ai-panel/services/openai-format.ts`). If Together's fine-tune endpoint rejects tool roles (Task 7 verifies), the fallback renderer flattens tool calls/results into tagged text blocks (`<tool_call>{json}</tool_call>` / `<tool_result>…</tool_result>`) — one renderer switch, same source data.
- **Eval gate (from the design spec §6):** adopt only if the fine-tune beats BOTH its own base model AND the CF mid tier (kimi-k2.7-code) on the 44-task eval's grounding + agentic families, with `--repeats 3` majority scoring. Ties/noise → no-go.
- All new code lives under `editor/tooling/unity-eval/` (Part A) and `editor/tooling/unity-finetune/` (Parts B/C); tests run with `bun test tooling/<dir>`; keep `bun test src` green; editor tsconfig is NOT restructured.
- Commits: conventional messages + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## Part A — Eval growth (12 → 44 tasks)

### Task 1: `--repeats` flag with majority scoring

**Files:**
- Modify: `editor/tooling/unity-eval/run-eval.ts`
- Modify: `editor/tooling/unity-eval/report.ts`
- Create: `editor/tooling/unity-eval/majority.ts`
- Test: `editor/tooling/unity-eval/majority.test.ts`

**Interfaces:**
- Consumes: `TaskResult` from `eval-types.ts`, `runTask` from `run-task.ts`.
- Produces: `majorityResult(runs: TaskResult[]): TaskResult & { runsPassed: number; runsTotal: number }` — pass = strict majority of runs passed; turns/wallMs/tokens are summed across runs (cost truth), checks taken from the LAST run. `run-eval.ts` gains `--repeats <n>` (default 1); the results JSON gains `repeats: n` and per-task `runsPassed`/`runsTotal`; `renderReport`'s Pass column shows `✅ 3/3`-style counts when repeats > 1.

- [ ] **Step 1: Write the failing test**

Create `editor/tooling/unity-eval/majority.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { majorityResult } from './majority';
import type { TaskResult } from './eval-types';

const r = (pass: boolean, tokens = 10): TaskResult => ({
  taskId: 't', family: 'grounding', pass,
  checks: [{ spec: { type: 'answer_matches', pattern: 'x' }, pass, detail: pass ? 'ok' : 'no' }],
  turns: 2, wallMs: 100, inputTokens: tokens, outputTokens: 5,
});

describe('majorityResult', () => {
  it('passes on strict majority', () => {
    expect(majorityResult([r(true), r(true), r(false)]).pass).toBe(true);
    expect(majorityResult([r(true), r(false), r(false)]).pass).toBe(false);
  });
  it('fails 1-of-2 (no strict majority)', () => {
    expect(majorityResult([r(true), r(false)]).pass).toBe(false);
  });
  it('sums cost fields and reports run counts', () => {
    const m = majorityResult([r(true, 10), r(true, 20), r(false, 30)]);
    expect(m.inputTokens).toBe(60);
    expect(m.runsPassed).toBe(2);
    expect(m.runsTotal).toBe(3);
  });
  it('takes checks from the last run', () => {
    const m = majorityResult([r(false), r(true)]);
    expect(m.checks[0].detail).toBe('ok');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd editor && bun test tooling/unity-eval/majority.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `majority.ts`**

```ts
import type { TaskResult } from './eval-types';

export interface MajorityResult extends TaskResult {
  runsPassed: number;
  runsTotal: number;
}

/** Majority scoring across repeated runs of one task (variance-aware gating). */
export function majorityResult(runs: TaskResult[]): MajorityResult {
  const last = runs[runs.length - 1];
  const runsPassed = runs.filter((x) => x.pass).length;
  return {
    ...last,
    pass: runsPassed * 2 > runs.length,
    checks: last.checks,
    turns: runs.reduce((n, x) => n + x.turns, 0),
    wallMs: runs.reduce((n, x) => n + x.wallMs, 0),
    inputTokens: runs.reduce((n, x) => n + x.inputTokens, 0),
    outputTokens: runs.reduce((n, x) => n + x.outputTokens, 0),
    runsPassed,
    runsTotal: runs.length,
  };
}
```

- [ ] **Step 4: Wire into run-eval.ts + report.ts**

`run-eval.ts`: add `'repeats': { type: 'string' }` to parseArgs options; `const repeats = Math.max(1, parseInt(values.repeats ?? '1', 10) || 1);` — in the task loop, run `runTask` `repeats` times collecting into an array, then `const r = repeats > 1 ? majorityResult(runs) : runs[0];`. Include `repeats` in the saved JSON payload.

`report.ts`: `renderReport` Pass cell → `r.pass ? '✅' : '❌'` plus `` `${(r as {runsPassed?: number}).runsPassed ?? ''}/${(r as {runsTotal?: number}).runsTotal ?? ''}` `` when `runsTotal` present (keep the plain form when absent).

- [ ] **Step 5: Verify + commit**

`cd editor && bun test tooling/unity-eval && bun test src` → all green.

```bash
git add editor/tooling/unity-eval && git commit -m "feat(eval): --repeats flag with majority scoring for variance-aware gating"
```

### Task 2: Third fixture — `urp2022-legacyinput` (mixed-trap project)

**Files:**
- Create: `editor/tooling/unity-eval/fixtures/urp2022-legacyinput/ProjectSettings/ProjectVersion.txt`
- Create: `editor/tooling/unity-eval/fixtures/urp2022-legacyinput/Packages/manifest.json`
- Create: `editor/tooling/unity-eval/fixtures/urp2022-legacyinput/Assets/Scripts/{SpawnManager.cs,LaserGun.cs}`
- Modify: `editor/tooling/unity-eval/eval-types.ts` (fixture union)
- Test: extend `editor/tooling/unity-eval/fixture-facts.test.ts`

**Interfaces:**
- Produces: fixture name `'urp2022-legacyinput'` added to `EvalTask['fixture']` union. The trap: URP pipeline BUT legacy Input Manager (real projects mix eras — models that infer "URP ⇒ new Input System" fail here).

- [ ] **Step 1: Failing test** — add to `fixture-facts.test.ts`:

```ts
  it('detects URP + legacy input (mixed-era fixture)', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'urp2022-legacyinput');
    expect(facts).toContain('Unity version: 2022.3.30f1');
    expect(facts).toContain('Render pipeline: URP');
    expect(facts).toContain('Input system: Input Manager (legacy)');
  });
```

Run → FAIL (fixture missing).

- [ ] **Step 2: Create the fixture**

`ProjectVersion.txt`:

```
m_EditorVersion: 2022.3.30f1
m_EditorVersionWithRevision: 2022.3.30f1 (deadbeef0001)
```

`Packages/manifest.json`:

```json
{
  "dependencies": {
    "com.unity.render-pipelines.universal": "14.0.11",
    "com.unity.textmeshpro": "3.0.6"
  }
}
```

`Assets/Scripts/SpawnManager.cs` (seeded: string-based Instantiate lookup + per-frame Find):

```csharp
using UnityEngine;

public class SpawnManager : MonoBehaviour
{
    [SerializeField] private GameObject enemyPrefab;
    [SerializeField] private float spawnInterval = 2f;

    private float timer;

    void Update()
    {
        timer += Time.deltaTime;
        var player = GameObject.Find("Player");
        if (timer >= spawnInterval && player != null)
        {
            Instantiate(enemyPrefab, player.transform.position + Vector3.forward * 10f, Quaternion.identity);
            timer = 0f;
        }
    }
}
```

`Assets/Scripts/LaserGun.cs` (seeded: legacy input + Camera.main per shot; deprecated-in-URP `camera.pixelRect` style usage avoided — keep it simple):

```csharp
using UnityEngine;

public class LaserGun : MonoBehaviour
{
    [SerializeField] private float range = 50f;

    void Update()
    {
        if (Input.GetButtonDown("Fire1"))
        {
            var ray = Camera.main.ScreenPointToRay(Input.mousePosition);
            if (Physics.Raycast(ray, out var hit, range))
            {
                Debug.Log("Hit " + hit.collider.name);
            }
        }
    }
}
```

- [ ] **Step 3: Widen the type union** — `eval-types.ts`: `fixture: 'builtin-legacy' | 'urp-newinput' | 'urp2022-legacyinput';`

- [ ] **Step 4: Verify + commit** — `bun test tooling/unity-eval` green.

```bash
git add editor/tooling/unity-eval && git commit -m "feat(eval): third fixture urp2022-legacyinput (mixed-era trap project)"
```

### Task 3: +32 seed tasks (16 grounding, 8 codegen, 8 agentic)

**Files:**
- Modify: `editor/tooling/unity-eval/tasks.ts`
- Test: `editor/tooling/unity-eval/tasks.test.ts` (new — structural self-checks)

**Interfaces:**
- Produces: `TASKS.length === 44`; ids unique; every fixture referenced exists; every regex compiles. Task authoring rules (bake into the test): grounding answers must be checkable by `answer_matches`/`answer_not_matches` with version-discriminating patterns; every `file_contains` pattern must NOT already match the pristine fixture (except rename-style tasks listed in an explicit allowlist constant).

- [ ] **Step 1: Write the structural test first**

Create `tasks.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TASKS } from './tasks';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
// Tasks whose file_contains intentionally matches pristine fixture content
// (e.g. "keep X while changing Y" checks).
const PRISTINE_MATCH_ALLOWLIST = new Set<string>([]);

describe('TASKS structural integrity', () => {
  it('has 44 uniquely-idd tasks', () => {
    expect(TASKS.length).toBe(44);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(44);
  });
  it('families are balanced 16/16/12 (codegen/grounding/agentic)', () => {
    const by = (f: string) => TASKS.filter((t) => t.family === f).length;
    expect(by('codegen')).toBe(12);
    expect(by('grounding')).toBe(20);
    expect(by('agentic')).toBe(12);
  });
  it('every regex compiles', () => {
    for (const t of TASKS) for (const c of t.checks) {
      if ('pattern' in c) expect(() => new RegExp(c.pattern, c.flags)).not.toThrow();
    }
  });
  it('file_contains targets do not already match pristine fixtures', async () => {
    for (const t of TASKS) {
      if (PRISTINE_MATCH_ALLOWLIST.has(t.id)) continue;
      for (const c of t.checks) {
        if (c.type !== 'file_contains') continue;
        const p = join(FIXTURES, t.fixture, c.path);
        const content = await readFile(p, 'utf8').catch(() => null);
        if (content !== null) {
          expect(new RegExp(c.pattern, c.flags).test(content)).toBe(false);
        }
      }
    }
  });
});
```

Note the counts: existing 12 (4/4/4) + new 8 codegen, 16 grounding, 8 agentic = 12/20/12 = 44. Run → FAIL (length 12).

- [ ] **Step 2: Author the 32 new tasks in `tasks.ts`**

Keep the existing 12 unchanged. Append, following the existing object shape exactly. The authoritative list (id → fixture/mode → prompt gist → key checks); write full prompts in the style of the existing 12:

**Grounding (+16, ask mode).** Version/pipeline/input discriminators; each has an `answer_matches` for the correct-for-this-project API and an `answer_not_matches` for the wrong-era one:

| id | fixture | must match | must NOT match |
|---|---|---|---|
| grounding-urp-fog | urp-newinput | `RenderSettings\.fog|Volume|Fog` URP volume-based answer: `Volume` | `RenderSettings\.fogMode` as the primary answer — pattern `answer_not_matches: 'fogMode'` |
| grounding-builtin-fog | builtin-legacy | `RenderSettings\.fog` | `\bVolume profile\b|VolumeProfile` |
| grounding-urp-shader-name | urp-newinput | `Universal Render Pipeline/Lit|URP/Lit|"Universal` | `"Standard"` |
| grounding-builtin-shader-name | builtin-legacy | `"Standard"` | `Universal Render Pipeline/Lit` |
| grounding-mixed-input | urp2022-legacyinput | `Input\.GetAxis|Input\.GetButton` | `UnityEngine\.InputSystem` |
| grounding-mixed-pipeline | urp2022-legacyinput | `_BaseColor` | `"_Color"` |
| grounding-camera-stack | urp-newinput | `UniversalAdditionalCameraData|camera stack|cameraStack` | `Camera\.main\.rect` |
| grounding-postfx-builtin | builtin-legacy | `Post.?Processing Stack|OnRenderImage|Graphics\.Blit` | `VolumeProfile` |
| grounding-input-callback | urp-newinput | `InputAction|performed|callback` | `Input\.GetKeyDown` |
| grounding-legacy-axis-setup | builtin-legacy | `Input Manager|Project Settings|Input\.GetAxis` | `InputActionAsset` |
| grounding-version-api-1 | urp-newinput (Unity 6) | `FindFirstObjectByType|FindAnyObjectByType` | `FindObjectOfType\b` |
| grounding-version-api-2 | builtin-legacy (2022.3) | `FindObjectOfType|FindFirstObjectByType` | *(none — both valid in 2022.3; check only the match)* |
| grounding-linearvelocity | urp-newinput (Unity 6) | `linearVelocity` | `\bvelocity\b` as the recommended property |
| grounding-rb-velocity-2022 | builtin-legacy | `\bvelocity\b` | `linearVelocity` |
| grounding-textmesh-namespace | urp2022-legacyinput | `TMPro|TextMeshProUGUI` | `UnityEngine\.UI\.Text\b` as the recommendation |
| grounding-async-scene-load | builtin-legacy | `LoadSceneAsync` | `Application\.LoadLevel` |

Prompts phrase the question naturally, e.g. `grounding-linearvelocity`: "How do I set a Rigidbody's velocity directly from a script in this project? Show the idiomatic property to use." — the fixture facts (Unity 6000.0.23f1) make `linearVelocity` correct there and `velocity` correct in the 2022.3 fixture. Before finalizing `grounding-version-api-1/2` and `grounding-linearvelocity/rb-velocity-2022`, verify the deprecation boundary versions against `editor/src/features/ai-panel/services/unity-tools/migration-tool.ts` (the deterministic maps) and adjust the discriminating patterns if the maps say otherwise — the maps are the project's ground truth.

**Codegen (+8, agent mode).** Each ends with `analyzer_clean` on the new file + content checks:

| id | fixture | ask for | key checks |
|---|---|---|---|
| codegen-object-pool | urp2022-legacyinput | generic prefab object pool (Queue-based) used by SpawnManager | `file_exists Assets/Scripts/ObjectPool.cs`, `file_contains Queue|Stack`, `file_not_contains Instantiate.*Update` |
| codegen-singleton-audio | builtin-legacy | AudioManager singleton surviving scene loads | `DontDestroyOnLoad`, `file_not_contains FindObjectOfType.*Update` |
| codegen-coroutine-timer | builtin-legacy | countdown timer MonoBehaviour w/ UnityEvent on finish, coroutine-based | `IEnumerator`, `WaitForSeconds`, `UnityEvent` |
| codegen-input-rebind | urp-newinput | runtime rebind helper using InputActionRebindingExtensions | `PerformInteractiveRebinding`, `file_not_contains Input\.GetKey` |
| codegen-so-event-channel | urp-newinput | ScriptableObject event channel (raise/subscribe) | `ScriptableObject`, `CreateAssetMenu`, `event Action|UnityAction` |
| codegen-editor-tool | builtin-legacy | editor-only menu item that counts missing scripts in open scene — MUST be editor-guarded | `MenuItem`, `#if UNITY_EDITOR|Editor/` in path — this one exercises the analyzer error rule |
| codegen-physics-layermask | urp2022-legacyinput | raycast refactor of LaserGun using a serialized LayerMask | `LayerMask`, `file_not_contains GameObject\.Find` |
| codegen-save-json | builtin-legacy | JsonUtility save/load for player prefs data class | `JsonUtility`, `Application\.persistentDataPath` |

**Agentic (+8, agent mode).** Multi-step investigate-and-fix on seeded bugs:

| id | fixture | prompt gist | key checks |
|---|---|---|---|
| agentic-find-in-update | urp2022-legacyinput | "SpawnManager causes frame drops — find and fix the per-frame problem" | `file_not_contains GameObject\.Find` inside Update (pattern `void Update\(\)[\s\S]*?GameObject\.Find` absent), `file_contains Start\(\)|Awake\(\)|\[SerializeField\]` |
| agentic-camera-main-cache | urp2022-legacyinput | "LaserGun hitches when firing — investigate" | `file_not_contains Update\(\)[\s\S]*?Camera\.main`, `analyzer_clean` |
| agentic-fsa-rename-2 | urp-newinput | rename `maxHealth` → `baseHealth` Inspector-safely | `FormerlySerializedAs\("maxHealth"\)`, `baseHealth`, not `\bint maxHealth\b` |
| agentic-multifile-refactor | urp2022-legacyinput | extract shared spawn-position logic from SpawnManager into a new static utility both scripts use | `file_exists Assets/Scripts/SpawnUtility.cs` (or accept any new file via prompt naming it), SpawnManager `file_contains SpawnUtility` |
| agentic-null-guard-event | urp-newinput | "Health.onDamaged throws when nothing subscribes — fix properly, not with a try/catch" | `file_contains \?\.Invoke|!= null`, `file_not_contains catch` |
| agentic-editor-leak | builtin-legacy | plant `using UnityEditor;` + `EditorUtility.SetDirty` into a NEW seeded runtime file `Assets/Scripts/SaveHelper.cs` (add it to the fixture in this task) with prompt "builds fail on device — find out why and fix" | `analyzer_clean Assets/Scripts/SaveHelper.cs`, `file_not_contains using UnityEditor;` un-guarded (allow `#if UNITY_EDITOR`) |
| agentic-deltatime-fixed | builtin-legacy | plant seeded `FixedUpdate` using `Time.deltaTime` in new fixture file `Assets/Scripts/Paddle.cs`; "physics feels inconsistent" | `file_contains fixedDeltaTime|Time\.deltaTime` corrected — pattern: `FixedUpdate` block no longer contains `Time\.deltaTime` (`file_not_contains FixedUpdate\(\)[\s\S]*?Time\.deltaTime`) |
| agentic-instantiate-parent | urp2022-legacyinput | "spawned enemies clutter the hierarchy root — organize them under a container at runtime" | `file_contains transform\)|SetParent`, `analyzer_clean` |

For `agentic-editor-leak` and `agentic-deltatime-fixed`, the new seeded files are added to the FIXTURE in this same task (they're inert for all other tasks). Add both to the fixtures with exact content written in this step (SaveHelper: a small static-using class calling `EditorUtility.SetDirty(target)` in a `Save()` method; Paddle: `void FixedUpdate() { transform.Translate(Vector3.right * speed * Time.deltaTime); }` with a `[SerializeField] float speed = 5f;`).

- [ ] **Step 3: Iterate until the structural test passes** — `bun test tooling/unity-eval/tasks.test.ts`. The pristine-match test WILL catch authoring mistakes (e.g. a `file_contains` matching seeded content); fix patterns or add the task id to the allowlist ONLY when intentional.

- [ ] **Step 4: Smoke one new task headlessly** — reuse the scripted-mock pattern from `run-task.test.ts` for `agentic-editor-leak` (mock model writes the guarded fix; assert pass). Append that one test to `run-task.test.ts`.

- [ ] **Step 5: Full verify + commit**

```bash
cd editor && bun test tooling/unity-eval && bun test src
git add editor/tooling/unity-eval && git commit -m "feat(eval): grow to 44 tasks (grounding-heavy) + structural self-tests"
```

### Task 4: Re-baseline at 44 tasks (mid + high, repeats 3)

**Files:**
- Modify: `editor/tooling/unity-eval/README.md` (baseline table v2)
- Create: `editor/tooling/unity-eval/results/baselines/` two new JSONs (git add -f)

**Interfaces:** Produces the gate reference numbers all of Part C compares against.

- [ ] **Step 1: Start local server** — `cd arcane-server && npx wrangler dev --port 8787` (background), login as the existing eval users (`eval-mid@arcane.dev` / `eval-high@arcane.dev`, passwords in `.superpowers/sdd/progress.md` history — or sign up fresh ones).
- [ ] **Step 2: Run** (expect ~45-90 min each with repeats 3; transient retries are built in):

```bash
cd editor && EVAL_JWT=<mid-jwt> bun run eval -- --base-url http://localhost:8787/v1 --api-key-env EVAL_JWT --model @cf/moonshotai/kimi-k2.7-code --label cf-mid-kimi-k2.7-44 --reasoning-level mid --repeats 3
cd editor && EVAL_JWT=<high-jwt> bun run eval -- --base-url http://localhost:8787/v1 --api-key-env EVAL_JWT --model @cf/zai-org/glm-5.2 --label cf-high-glm-5.2-44 --reasoning-level high --repeats 3
```

Watch the $1/hr per-user cap: with repeats 3 a run may hit it — if 429s appear, the harness retries but if the cap window blocks hard, split with `--filter` by family and merge results manually (note it in the README).
- [ ] **Step 3: Commit** — copy JSONs to `results/baselines/`, `git add -f`, update README table (append a "44-task baselines" section; keep the 12-task table for history), note pass@3 per family.

```bash
git add -f editor/tooling/unity-eval/results/baselines/*.json && git add editor/tooling/unity-eval/README.md && git commit -m "docs(eval): 44-task repeats-3 baselines for fine-tune gate"
```

---

## Part B — Training-data pipeline (`editor/tooling/unity-finetune/`)

### Task 5: Grounding + repair pair generators

**Files:**
- Create: `editor/tooling/unity-finetune/{gen-grounding-pairs.ts,gen-repair-pairs.ts,dataset-types.ts}`
- Create: `editor/tooling/unity-finetune/.gitignore` (`data/`, `.env`, `BUDGET.md` NOT ignored — budget is committed)
- Test: `editor/tooling/unity-finetune/gen-grounding-pairs.test.ts`, `gen-repair-pairs.test.ts`

**Interfaces:**
- `dataset-types.ts`: `export interface ChatSample { messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[] }>; source: string }` (JSONL line shape; `source` stripped before upload).
- `genGroundingPairs(opts: { migrationMaps: MigrationMap[]; signatures: SignatureRow[] }): ChatSample[]` — deterministic, no LLM, no network.
- `genRepairPairs(fixturesDir: string): Promise<ChatSample[]>` — corruption templates + analyzer port from `../unity-eval/checks.ts`.

- [ ] **Step 1: Locate the two ground-truth sources (read-only recon, exact commands)**

```bash
grep -rn "export" editor/src/features/ai-panel/services/unity-tools/migration-tool.ts | head -20
cd arcane-server && npx wrangler d1 execute arcane-db --remote --command "SELECT COUNT(*) FROM unity_api_signatures;" && npx wrangler d1 execute arcane-db --remote --command "PRAGMA table_info(unity_api_signatures);"
```

Record the migration-map export names and the signatures schema in the task report. Export the signatures once:

```bash
npx wrangler d1 execute arcane-db --remote --json --command "SELECT * FROM unity_api_signatures;" > ../editor/tooling/unity-finetune/data/unity_api_signatures.json
```

(If the table is large, page with LIMIT/OFFSET into one file.) `data/` is gitignored.

- [ ] **Step 2: Write failing tests**

`gen-grounding-pairs.test.ts` — feed 2 hand-made migration entries + 2 signature rows; assert: each yields ≥2 ChatSamples (a "how do I X in <version/pipeline>" Q→A and a deprecated→replacement pair); every sample has exactly one system message stating Unity version/pipeline facts (reuse the `## Unity project facts` block format from `../unity-eval/fixture-facts.ts`), one user question, one assistant answer containing the correct API and NOT the deprecated one.

`gen-repair-pairs.test.ts` — corrupt a known-clean C# snippet with each corruption template (e.g. inject un-guarded `using UnityEditor;`); assert the generated sample's user message contains the corrupted code + a realistic compiler/analyzer error line, and the assistant message contains the fixed code that passes the analyzer port (`runChecks` with `analyzer_clean` on a temp file).

- [ ] **Step 3: Implement generators**

`gen-grounding-pairs.ts` core:

```ts
import type { ChatSample } from './dataset-types';

interface MigrationEntry { from: string; to: string; context: string; version?: string; pipeline?: string }
interface SignatureRow { type_name: string; member: string; signature: string; unity_version: string; deprecated?: string | null }

const factsBlock = (version: string, pipeline: string, input: string) => [
  '## Unity project facts (authoritative — match these)',
  `- Unity version: ${version}`,
  `- Render pipeline: ${pipeline}`,
  `- Input system: ${input}`,
].join('\n');

export function genGroundingPairs(opts: { migrationMaps: MigrationEntry[]; signatures: SignatureRow[] }): ChatSample[] {
  const out: ChatSample[] = [];
  for (const m of opts.migrationMaps) {
    out.push({
      source: `migration:${m.from}`,
      messages: [
        { role: 'system', content: `You are an AI Unity expert. ${factsBlock(m.version ?? '6000.0.23f1', m.pipeline ?? 'URP', 'Input System (new)')}` },
        { role: 'user', content: `My code uses \`${m.from}\`. What should I use in this project, and why?` },
        { role: 'assistant', content: `Use \`${m.to}\` — ${m.context} \`${m.from}\` is the wrong API for this project's setup; replace it with \`${m.to}\`.` },
      ],
    });
  }
  for (const s of opts.signatures) {
    out.push({
      source: `signature:${s.type_name}.${s.member}`,
      messages: [
        { role: 'system', content: `You are an AI Unity expert. ${factsBlock(s.unity_version, 'URP', 'Input System (new)')}` },
        { role: 'user', content: `What is the exact signature of \`${s.type_name}.${s.member}\` in this Unity version?` },
        { role: 'assistant', content: `In Unity ${s.unity_version}: \`${s.signature}\`${s.deprecated ? ` — note: deprecated (${s.deprecated}); prefer the replacement the docs point to.` : ''}` },
      ],
    });
  }
  return out;
}
```

Add a `main` block (`if (import.meta.main)`) that loads the real migration maps (import from the editor source module found in Step 1) + `data/unity_api_signatures.json`, generates, dedups by `source`, writes `data/grounding-pairs.jsonl`, prints counts. Adapt field names to the REAL schema recorded in Step 1 — the interfaces above are the plan's guess and the implementer must reconcile them.

`gen-repair-pairs.ts`: corruption templates array — each `{ name, corrupt(code: string): string, errorLine(file: string): string }`: (1) inject `using UnityEditor;` + `EditorUtility.SetDirty(this);` (analyzer-detectable — validate the fix with `runChecks analyzer_clean`); (2) rename `Update` → `update` with error line "warning: method 'update' looks like Unity message 'Update' but will never be called"; (3) `Time.deltaTime` in `FixedUpdate` (message from the near-miss family); (4) deprecated-API substitution reversed from the migration maps (error line = real CS0618-style text: `'X' is obsolete: 'use Y'`). Source clean snippets: the three fixtures' .cs files + the fix side of each pair. Sample shape: system = agent persona line + facts; user = "This file fails: <error line>\n```csharp\n<corrupted>\n```\nFix it."; assistant = corrected code in a fenced block with a one-line why.

- [ ] **Step 4: Run tests → pass; run mains; inspect**

```bash
cd editor && bun test tooling/unity-finetune
bun tooling/unity-finetune/gen-grounding-pairs.ts && bun tooling/unity-finetune/gen-repair-pairs.ts
head -c 2000 tooling/unity-finetune/data/grounding-pairs.jsonl
```

Expect thousands of grounding pairs (scales with signature-table size) and ~50-200 repair pairs. Record counts in BUDGET.md ($0 spent).

- [ ] **Step 5: Commit** (generators + tests, NOT data/)

```bash
git add editor/tooling/unity-finetune && git commit -m "feat(finetune): deterministic grounding + repair pair generators"
```

### Task 6: Teacher-trace recorder (rejection sampling through the eval harness)

**Files:**
- Create: `editor/tooling/unity-finetune/{trace-recorder.ts,gen-traces.ts,trace-tasks.ts}`
- Test: `editor/tooling/unity-finetune/trace-recorder.test.ts`

**Interfaces:**
- Consumes: `runTask(task, streamFn, usage, opts)` and `createEvalStreamFn` from `../unity-eval/`; `convertToOpenAI` from `editor/src/features/ai-panel/services/openai-format.ts`.
- Produces: `withTraceRecording(streamFn: StreamFn, sink: TraceSink): StreamFn` — wraps any StreamFn; on every call captures the FULL OpenAI-format request messages (via `convertToOpenAI(context.systemPrompt, context.messages)`) and the final assistant message; `sink.finalize(taskResult)` writes one JSONL line per PASSING task: `{ messages: <full conversation incl. tool results and final answer>, source: 'trace:<taskId>' }`. Failing tasks are DISCARDED (that is the rejection sampling).
- `trace-tasks.ts`: `TRACE_TASKS: EvalTask[]` — 60-100 task variants generated from templates over the three fixtures (prompt paraphrases × target-file variations of the eval families, EXCLUDING the 44 gate tasks' exact ids/prompts — the gate must stay unseen).

- [ ] **Step 1: Failing test** — scripted StreamFn (reuse `run-task.test.ts`'s pattern) through `withTraceRecording`; assert the sink receives a message array whose last assistant message matches the script, that tool_calls appear as OpenAI `tool_calls` and tool results as `role: 'tool'` messages, and that `finalize({pass: false})` writes nothing.
- [ ] **Step 2: Implement** — the wrapper intercepts the StreamFn: on call, stores `convertToOpenAI(...)` of the request; on 'done', appends the assistant message (text + tool_calls in OpenAI shape — reuse the conversion helpers in `openai-format.ts`); the LAST call's stored request + final assistant message = the complete conversation (the request already embeds all prior turns).
- [ ] **Step 3: `gen-traces.ts` CLI** — args: `--teacher-model <id> --api-key-env TOGETHER_API_KEY --limit <n> --budget-usd <n>`; teacher endpoint `https://api.together.xyz/v1`; loops TRACE_TASKS through `runTask(task, withTraceRecording(createEvalStreamFn(...)), usage)`; stops at `--limit` kept traces or `--budget-usd` estimated spend (use Together's pricing for the teacher id — take input/output $/M as CLI args `--price-in --price-out` to avoid hardcoding); appends spend to BUDGET.md; writes `data/traces.jsonl`.
- [ ] **Step 4: Verify with mock, then a 3-task PAID smoke** (`--limit 3 --budget-usd 2`) once Task 7's key exists — if the key isn't provisioned yet, mark this step deferred-to-Task-8 in the report rather than blocking.
- [ ] **Step 5: Commit**

```bash
git add editor/tooling/unity-finetune && git commit -m "feat(finetune): teacher-trace recorder with verification-based rejection sampling"
```

---

## Part C — Train + gate (Together AI)

### Task 7: Together account bootstrap + capability verification (USER-INTERACTIVE)

**Files:**
- Create: `editor/tooling/unity-finetune/PROVIDER.md` (verified facts: model ids, prices, formats)
- Create: `editor/tooling/unity-finetune/BUDGET.md` (running ledger)

This task needs the user once: create the Together AI account, generate an API key, put it in `editor/tooling/unity-finetune/.env` as `TOGETHER_API_KEY=...`. Everything after is scripted.

- [ ] **Step 1: Verify inference catalog (teacher + gate serving)**

```bash
source editor/tooling/unity-finetune/.env
curl -s https://api.together.xyz/v1/models -H "Authorization: Bearer $TOGETHER_API_KEY" | python3 -c "import sys,json;[print(m['id']) for m in json.load(sys.stdin) if any(k in m['id'].lower() for k in ('deepseek','qwen'))]"
```

Record in PROVIDER.md: the strongest DeepSeek chat model id (teacher), the exact `Qwen3-Coder-30B-A3B` id if present, `Qwen2.5-Coder-14B/32B` ids, with their $/M prices from https://www.together.ai/pricing.

- [ ] **Step 2: Verify fine-tunable models + dataset format**

```bash
curl -s https://api.together.xyz/v1/fine-tunes/models -H "Authorization: Bearer $TOGETHER_API_KEY" | head -c 3000
```

(Exact endpoint per current docs — if 404, consult https://docs.together.ai/docs/fine-tuning and record the correct one.) Decide the BASE: Qwen3-Coder-30B-A3B if listed, else Qwen2.5-Coder-14B-Instruct. Also verify whether the fine-tune data format accepts `tool_calls`/`tool` roles (docs section "data formats"); record VERDICT in PROVIDER.md — this selects the Task 8 renderer path.

- [ ] **Step 3: Teacher smoke + run the deferred Task 6 Step 4 paid smoke.** Verify 3 kept traces exist in `data/traces.jsonl` and BUDGET.md shows the spend.
- [ ] **Step 4: Commit** PROVIDER.md + BUDGET.md.

```bash
git add editor/tooling/unity-finetune/{PROVIDER.md,BUDGET.md} && git commit -m "docs(finetune): Together capability verification + budget ledger"
```

### Task 8: Dataset assembly + full trace generation

**Files:**
- Create: `editor/tooling/unity-finetune/assemble-dataset.ts`
- Test: `editor/tooling/unity-finetune/assemble-dataset.test.ts`

**Interfaces:** `assembleDataset(inputs: { files: string[]; toolRolesSupported: boolean; maxSamples?: Record<string, number> }): { train: ChatSample[]; holdout: ChatSample[] }` — merge, dedup (hash of messages), flatten tool roles to tagged text when `!toolRolesSupported`, cap grounding pairs (they're cheap and would swamp traces — cap at 3× trace count), strip `source`, 98/2 train/holdout split, write `data/train.jsonl` + `data/holdout.jsonl` + a stats block (sample counts by source prefix, token estimate via chars/3.5).

- [ ] **Step 1: TDD the assembler** (dedup, flattening — assert a `tool_calls` message becomes a `<tool_call>` text block when unsupported; cap logic; split determinism with a seeded shuffle — use a simple LCG, not Math.random).
- [ ] **Step 2: Full trace run.** `bun tooling/unity-finetune/gen-traces.ts --teacher-model <id from PROVIDER.md> --api-key-env TOGETHER_API_KEY --limit 1500 --budget-usd 100 --price-in <x> --price-out <y>` — expect hours; run in background; kept-trace yield from rejection sampling will be 40-70%. Record final spend.
- [ ] **Step 3: Assemble.** Run the assembler with the Task-7 `toolRolesSupported` verdict; sanity-read 5 random samples by eye; record stats in BUDGET.md.
- [ ] **Step 4: Commit** (code + tests only; data stays local).

```bash
git add editor/tooling/unity-finetune && git commit -m "feat(finetune): dataset assembler + full teacher-trace generation run"
```

### Task 9: LoRA fine-tune on Together

**Files:**
- Create: `editor/tooling/unity-finetune/train.md` (exact commands run + job ids + loss curves summary)

- [ ] **Step 1: Upload dataset** — `curl -s -X POST https://api.together.xyz/v1/files -H "Authorization: Bearer $TOGETHER_API_KEY" -F "file=@editor/tooling/unity-finetune/data/train.jsonl" -F purpose=fine-tune` → record file id.
- [ ] **Step 2: Launch LoRA job** — per PROVIDER.md's verified endpoint/params: base = the Task-7 decision; LoRA rank 16, alpha 32, lr 1e-4, 2 epochs, completion-only loss if supported. Estimated cost = train-token count × per-M rate from PROVIDER.md — append the estimate to BUDGET.md BEFORE launching; STOP if projected total > $430 (leave gate headroom).
- [ ] **Step 3: Poll to completion** (`/v1/fine-tunes/<id>`), record final loss + adapter/model id in train.md.
- [ ] **Step 4: Smoke the adapter** — one chat call to the fine-tuned model id (serverless LoRA); expect a coherent Unity answer mentioning the facts block's pipeline.
- [ ] **Step 5: Commit** train.md + BUDGET.md.

```bash
git add editor/tooling/unity-finetune && git commit -m "feat(finetune): LoRA training run on Together (see train.md)"
```

### Task 10: The gate — three-way eval + go/no-go

**Files:**
- Create: `editor/tooling/unity-finetune/GATE-DECISION.md`
- Create: two/three baseline JSONs in `editor/tooling/unity-eval/results/baselines/`

- [ ] **Step 1: Run the 44-task eval, repeats 3, against three configs:**

```bash
cd editor
# (a) fine-tune (Together serverless LoRA)
TOGETHER_API_KEY=... bun run eval -- --base-url https://api.together.xyz/v1 --api-key-env TOGETHER_API_KEY --model <finetune-id> --label ft-unity-v1 --repeats 3
# (b) its base model (same endpoint, base id)
TOGETHER_API_KEY=... bun run eval -- --base-url https://api.together.xyz/v1 --api-key-env TOGETHER_API_KEY --model <base-id> --label ft-base --repeats 3
# (c) CF mid tier — reuse Task 4's cf-mid 44-task baseline (do not re-run)
```

- [ ] **Step 2: Write GATE-DECISION.md** — per-family pass@3 table for (a)/(b)/(c); the spec's rule verbatim: ADOPT only if (a) > (b) AND (a) > (c) on grounding AND agentic families; anything else = NO-GO with the numbers. Include cost columns (tokens × Together price vs CF price) and total project spend from BUDGET.md.
- [ ] **Step 3: Commit** — results JSONs (`git add -f`), GATE-DECISION.md, README baseline-table update.

```bash
git add -f editor/tooling/unity-eval/results/baselines/*.json && git add editor/tooling/unity-finetune editor/tooling/unity-eval/README.md && git commit -m "docs(finetune): gate decision — three-way 44-task eval results"
```

- [ ] **Step 4: If GO** — write a one-paragraph follow-up note in GATE-DECISION.md scoping the NEXT plan (serving/productization: Together serverless per-token behind a new arcane-server tier, BYO-LoRA options, pricing) — that work is explicitly OUT of this plan.

---

## Self-review notes

- **Spec coverage (design doc §6):** data sources — verified traces (T6/T8), grounding pairs (T5), repair pairs (T5); base model + fallback (T7 decides against live catalog, spec's Qwen3-Coder-30B-A3B primary honored); training QLoRA-equivalent LoRA via managed API (T9; spec allowed "managed alternative: Together"); gate = beats base AND mid tier on grounding+agentic (T10, spec §6 verbatim); budget $230-500 (BUDGET.md ledger, hard stops in T8/T9). Eval growth to spec's 40-80 range (44) with variance handling (T1) — prerequisite the spec's Phase-1 acceptance implied.
- **User constraints:** CF preferred → verified impossible for training (no training product; LoRA serving limited to Mistral/Gemma/Llama bases), so exactly ONE new account (Together) covering teacher+train+serve; product lineup untouched anywhere.
- **Known uncertainties, handled as verify-first steps:** Together's current fine-tune endpoint paths/format and tool-role support (T7 records PROVIDER.md verdict; T8 renderer switch); `unity_api_signatures` real schema (T5 Step 1 recon); migration-map export names (T5 Step 1); deprecation boundary versions for new grounding tasks (T3 checks against migration-tool.ts).
- **Type consistency:** `ChatSample` (T5) consumed by T6 sink and T8 assembler; `MajorityResult` (T1) consumed by run-eval/report; `TRACE_TASKS` reuses `EvalTask` unchanged; fixture union widened once (T2) and used by T3.
- **Leakage control:** gate tasks (the 44) excluded from TRACE_TASKS by construction (T6); holdout split in T8 is for training-loss sanity only, the real test is the unseen gate.
