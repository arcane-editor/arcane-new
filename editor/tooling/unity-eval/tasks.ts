import type { EvalTask } from './eval-types';

export const TASKS: EvalTask[] = [
  // ── codegen ──────────────────────────────────────────────────────────
  {
    id: 'codegen-dash-cooldown', family: 'codegen', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'Add a dash ability: create Assets/Scripts/PlayerDash.cs, a MonoBehaviour that dashes the player forward when the dash key is pressed, with a 2 second cooldown. Use this project\'s input system.',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/PlayerDash.cs' },
      { type: 'file_contains', path: 'Assets/Scripts/PlayerDash.cs', pattern: 'cooldown', flags: 'i' },
      { type: 'file_not_contains', path: 'Assets/Scripts/PlayerDash.cs', pattern: 'UnityEngine\\.InputSystem' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/PlayerDash.cs' },
    ],
  },
  {
    id: 'codegen-damage-event', family: 'codegen', fixture: 'urp-newinput', mode: 'agent',
    prompt: 'Extend Assets/Scripts/Health.cs with a TakeDamage(int amount) method that clamps at zero and raises a UnityEvent<int> named onDamaged when damage is applied.',
    checks: [
      { type: 'file_contains', path: 'Assets/Scripts/Health.cs', pattern: 'TakeDamage' },
      { type: 'file_contains', path: 'Assets/Scripts/Health.cs', pattern: 'UnityEvent' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/Health.cs' },
    ],
  },
  {
    id: 'codegen-canvas-fade', family: 'codegen', fixture: 'urp-newinput', mode: 'agent',
    prompt: 'Create Assets/Scripts/UIFader.cs: a MonoBehaviour with a public method FadeOut(float seconds) that fades a CanvasGroup to alpha 0 over the given duration using a coroutine (not async/await).',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/UIFader.cs' },
      { type: 'file_contains', path: 'Assets/Scripts/UIFader.cs', pattern: 'IEnumerator' },
      { type: 'file_not_contains', path: 'Assets/Scripts/UIFader.cs', pattern: 'async\\s+void' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/UIFader.cs' },
    ],
  },
  {
    id: 'codegen-so-config', family: 'codegen', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'Create Assets/Scripts/EnemyConfig.cs: a ScriptableObject holding enemy stats (name, maxHealth, moveSpeed) that designers can create from the Assets menu.',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/EnemyConfig.cs' },
      { type: 'file_contains', path: 'Assets/Scripts/EnemyConfig.cs', pattern: 'ScriptableObject' },
      { type: 'file_contains', path: 'Assets/Scripts/EnemyConfig.cs', pattern: 'CreateAssetMenu' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/EnemyConfig.cs' },
    ],
  },

  // ── codegen (UI generation) ──────────────────────────────────────────
  // `urp-newinput`'s fixture ships a seeded HUD (Assets/UI/HUD.uxml +
  // Theme.uss, copied verbatim from `editor/fixtures/uitoolkit/` — see that
  // fixture's own doc comment) so the project already "counts as" UI
  // Toolkit before this task's turn starts. `unity_ui_scaffold`/
  // `unity_ui_write` aren't in the headless eval's toolset (see
  // `run-task.ts`'s "Deliberately ABSENT" list — they need a live bridge to
  // resolve GUIDs/PanelSettings), so the agent has to reach the same result
  // through the generic `write` tool, the same as every other codegen task.
  // Theme.uss's seeded `box-shadow` (a CSS property USS does not implement —
  // see that file's own comment) is the trap: an agent that imitates the
  // existing stylesheet's pattern instead of writing valid USS fails the
  // `file_not_contains` check below.
  {
    id: 'codegen-ui-hud', family: 'codegen', fixture: 'urp-newinput', mode: 'agent',
    prompt: 'This project already has a HUD built with UI Toolkit (Assets/UI/HUD.uxml, Assets/UI/Theme.uss). Add a new pause menu screen: create Assets/UI/PauseMenu.uxml and Assets/UI/PauseMenu.uss, styled consistently with the existing theme.',
    checks: [
      { type: 'file_exists', path: 'Assets/UI/PauseMenu.uxml' },
      { type: 'file_exists', path: 'Assets/UI/PauseMenu.uss' },
      { type: 'file_not_contains', path: 'Assets/UI/PauseMenu.uss', pattern: 'box-shadow|grid-template', flags: 'i' },
    ],
  },

  // ── codegen (trap fixture: URP + legacy Input Manager) ──────────────
  // All four tasks below share `urp2022-legacyinput`, whose
  // `PlayerMover.cs` already models the project's actual (legacy)
  // input approach — the trap is that "URP" alone is not evidence of the
  // new Input System (see `fixture-facts.test.ts`'s
  // `activeInputHandler`-authoritative regression test).
  {
    id: 'codegen-trap-mover', family: 'codegen', fixture: 'urp2022-legacyinput', mode: 'agent',
    prompt: 'Create Assets/Scripts/CharacterMover.cs: a MonoBehaviour that moves the player based on horizontal/vertical movement input, using this project\'s existing input approach (see PlayerMover.cs for reference).',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/CharacterMover.cs' },
      // Correct here: `activeInputHandler: 0` in ProjectSettings.asset means
      // legacy Input Manager, regardless of the URP render pipeline.
      { type: 'file_contains', path: 'Assets/Scripts/CharacterMover.cs', pattern: 'Input\\.GetAxis|Input\\.GetKey' },
      { type: 'file_not_contains', path: 'Assets/Scripts/CharacterMover.cs', pattern: 'UnityEngine\\.InputSystem' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/CharacterMover.cs' },
    ],
  },
  {
    id: 'codegen-trap-material', family: 'codegen', fixture: 'urp2022-legacyinput', mode: 'agent',
    prompt: 'Create Assets/Scripts/TintOnHit.cs: a MonoBehaviour with a public method Tint(Color c) that sets a Renderer\'s material color at runtime. This project\'s materials use the URP/Lit shader.',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/TintOnHit.cs' },
      // Accept either spelling: `material.color = c` and
      // `SetColor("_BaseColor", c)` are both correct on URP/Lit in
      // 2022.3 — URP/Lit declares `[MainColor] _BaseColor`, and Unity's
      // `Material.color` accessor maps to the property tagged `[MainColor]`
      // (since ~2019.3), so `material.color` deterministically writes
      // `_BaseColor` on URP/Lit. Accept-either remains correct because
      // models may write either form.
      { type: 'file_contains', path: 'Assets/Scripts/TintOnHit.cs', pattern: 'material\\.color\\s*=|_BaseColor' },
      { type: 'file_not_contains', path: 'Assets/Scripts/TintOnHit.cs', pattern: '"_Color"' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/TintOnHit.cs' },
    ],
  },
  {
    id: 'codegen-trap-jump', family: 'codegen', fixture: 'urp2022-legacyinput', mode: 'agent',
    prompt: 'Create Assets/Scripts/PlayerJump.cs: a MonoBehaviour with a Rigidbody that applies an upward jump impulse when the jump key is pressed this frame, using this project\'s existing input approach.',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/PlayerJump.cs' },
      { type: 'file_contains', path: 'Assets/Scripts/PlayerJump.cs', pattern: 'GetKeyDown|GetButtonDown' },
      { type: 'file_not_contains', path: 'Assets/Scripts/PlayerJump.cs', pattern: 'UnityEngine\\.InputSystem' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/PlayerJump.cs' },
    ],
  },
  {
    // Mirrors `codegen-canvas-fade`'s prompt/checks exactly, on the trap
    // fixture — the coroutine-vs-async-void distinction doesn't depend on
    // pipeline/input, so this is breadth (more attempts on the trap
    // fixture), not a new correctness dimension.
    id: 'codegen-trap-fade', family: 'codegen', fixture: 'urp2022-legacyinput', mode: 'agent',
    prompt: 'Create Assets/Scripts/UIFader.cs: a MonoBehaviour with a public method FadeOut(float seconds) that fades a CanvasGroup to alpha 0 over the given duration using a coroutine (not async/await).',
    checks: [
      { type: 'file_exists', path: 'Assets/Scripts/UIFader.cs' },
      { type: 'file_contains', path: 'Assets/Scripts/UIFader.cs', pattern: 'IEnumerator' },
      { type: 'file_not_contains', path: 'Assets/Scripts/UIFader.cs', pattern: 'async\\s+void' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/UIFader.cs' },
    ],
  },

  // ── grounding (ask mode: version/pipeline-correct answers) ──────────
  {
    id: 'grounding-urp-color', family: 'grounding', fixture: 'urp-newinput', mode: 'ask',
    prompt: 'How do I change a material\'s main color from a script at runtime in this project?',
    checks: [
      { type: 'answer_matches', pattern: '_BaseColor' },
      { type: 'answer_not_matches', pattern: '"_Color"' },
    ],
  },
  {
    id: 'grounding-builtin-color', family: 'grounding', fixture: 'builtin-legacy', mode: 'ask',
    prompt: 'How do I change a material\'s main color from a script at runtime in this project?',
    checks: [
      { type: 'answer_matches', pattern: '\\.color\\s*=|"_Color"' },
      // Scoped to the quoted/recommendation form: since P2.1's contrast facts, a
      // CORRECT answer often explains "_BaseColor is the URP name — wrong here";
      // bare `_BaseColor` failed those correct contrast answers (phase2 runs).
      { type: 'answer_not_matches', pattern: '"_BaseColor"' },
    ],
  },
  {
    id: 'grounding-input-read', family: 'grounding', fixture: 'urp-newinput', mode: 'ask',
    prompt: 'Show me the idiomatic way to read WASD movement input in this project.',
    checks: [
      { type: 'answer_matches', pattern: 'InputAction|InputSystem|InputValue' },
      // Invocation-scoped (same rationale as grounding-deprecated-loadlevel):
      // correct answers may cite Input.GetAxis only to negate it.
      { type: 'answer_not_matches', pattern: 'Input\\.GetAxis\\s*\\(' },
    ],
  },
  {
    id: 'grounding-legacy-input', family: 'grounding', fixture: 'builtin-legacy', mode: 'ask',
    prompt: 'Show me the idiomatic way to read WASD movement input in this project.',
    checks: [
      { type: 'answer_matches', pattern: 'Input\\.GetAxis' },
      // using-directive-scoped: contrast facts make correct answers mention the
      // InputSystem package by name to warn against it.
      { type: 'answer_not_matches', pattern: 'using\\s+UnityEngine\\.InputSystem' },
    ],
  },

  // ── grounding (exact property/shader-name — facts alone can't answer) ──
  // `fixture-facts.ts`'s injected block states version/pipeline/input-system
  // wording (see `buildFixtureFacts`) plus, since P2.1, contrastive
  // anti-default facts (`unity-contrast.ts`) appended at the end — and those
  // DO now name exact shader-property strings (`_BaseColor`/`_BaseMap` for
  // URP, `_Color`/`_MainTex` for Built-in) directly in the prompt. It still
  // never names an exact SHADER PATH string (e.g. "Universal Render
  // Pipeline/Lit") — no row in the contrast table covers that. So of the
  // three tasks that originally got a `tool_called: unity_api_search` check
  // here (facts alone couldn't answer them), only `grounding-urp-shader-name`
  // still needs it; see the per-task comments below for why the other two
  // lost theirs (established rule: `tool_called` only where facts are
  // insufficient).
  {
    id: 'grounding-urp-texture', family: 'grounding', fixture: 'urp-newinput', mode: 'ask',
    prompt: 'How do I set a material\'s main texture from a script at runtime in this project?',
    checks: [
      { type: 'answer_matches', pattern: '_BaseMap' },
      // Same "reject only as the recommended property" strictness as
      // `grounding-urp-color`'s `"_Color"` check: this only fails on the
      // literal quoted string (i.e. the model actually recommending
      // `_MainTex` as the property to set), not an incidental mention of
      // the legacy name.
      { type: 'answer_not_matches', pattern: '"_MainTex"' },
      // P2.1 (deliberate removal): `unity-contrast.ts`'s `urp-color` row
      // states `_BaseMap`/`_Color` explicitly for every URP fixture, so the
      // injected fixture facts are now SUFFICIENT to answer this without a
      // tool call — the `tool_called: unity_api_search` check this task
      // previously had is removed. Contrast with `grounding-urp-shader-name`
      // just below, whose exact shader-path answer is deliberately NOT in
      // the contrast table and so keeps its `tool_called` check.
    ],
  },
  {
    id: 'grounding-urp-shader-name', family: 'grounding', fixture: 'urp-newinput', mode: 'ask',
    prompt: 'What shader should a new standard opaque material use in this project?',
    checks: [
      { type: 'answer_matches', pattern: 'Universal Render Pipeline/Lit' },
      // Only fail on quoted-shader-spec form (e.g. Shader.Find("Standard")),
      // not prose contrast like "the old Standard shader".
      { type: 'answer_not_matches', pattern: '\\"Standard\\"' },
      // KEPT (P2.1): the literal shader asset name "Universal Render
      // Pipeline/Lit" is deliberately NOT in `unity-contrast.ts`'s table —
      // that's an encyclopedia-shaped fact, not a high-frequency
      // anti-default, so this is the one case left where the model has to
      // actually ground itself via `unity_api_search` rather than read the
      // answer off the facts block.
      { type: 'tool_called', tool: 'unity_api_search' },
    ],
  },
  {
    id: 'grounding-urp-postfx', family: 'grounding', fixture: 'urp-newinput', mode: 'ask',
    prompt: 'How do I apply a full-screen post-processing image effect in this project?',
    checks: [
      { type: 'answer_matches', pattern: 'ScriptableRenderPass|Renderer Feature|RenderPipelineManager' },
      // `MonoBehaviour.OnRenderImage` is a Built-in render pipeline camera
      // callback; it is documented as not invoked at all when a Scriptable
      // Render Pipeline (URP/HDRP) is active, so recommending it here is
      // simply wrong, not just outdated style. Only fail on code-recommendation
      // form (method definition), not prose negation.
      { type: 'answer_not_matches', pattern: 'void\\s+OnRenderImage\\s*\\(' },
    ],
  },
  {
    id: 'grounding-builtin-postfx', family: 'grounding', fixture: 'builtin-legacy', mode: 'ask',
    prompt: 'How do I apply a full-screen post-processing image effect in this project?',
    checks: [
      // Inverse of `grounding-urp-postfx`: `OnRenderImage` is the correct,
      // classic Built-in-pipeline answer here.
      { type: 'answer_matches', pattern: 'OnRenderImage' },
      // Only fail on subclassing form, not prose mention of URP as an alternative.
      { type: 'answer_not_matches', pattern: ':\\s*ScriptableRenderPass\\b' },
    ],
  },
  {
    id: 'grounding-trap-shader', family: 'grounding', fixture: 'urp2022-legacyinput', mode: 'ask',
    prompt: 'What shader color property should I set from a script to tint a material in this project?',
    checks: [
      // Trap direction: legacy input might pull a model toward "old
      // everything", but the render pipeline is still URP, so the Lit
      // shader's color property (`_BaseColor`) is still correct here.
      { type: 'answer_matches', pattern: '_BaseColor' },
      { type: 'answer_not_matches', pattern: '"_Color"' },
      // P2.1 (deliberate removal, same rule as `grounding-urp-texture`
      // above): this fixture is URP, so `unity-contrast.ts`'s `urp-color`
      // row states `_BaseColor` explicitly in the injected facts block —
      // the fixture facts alone are now SUFFICIENT, so the `tool_called:
      // unity_api_search` check this task previously had is removed.
    ],
  },
  {
    id: 'grounding-trap-input', family: 'grounding', fixture: 'urp2022-legacyinput', mode: 'ask',
    prompt: 'Show me the idiomatic way to read horizontal movement input in this project.',
    checks: [
      // Trap inverted from `grounding-trap-shader`: URP might pull a model
      // toward "new everything", but `activeInputHandler: 0` makes legacy
      // `Input.GetAxis` the actually-correct answer for this project.
      { type: 'answer_matches', pattern: 'Input\\.GetAxis' },
      // Code-recommendation forms only; prose negation ("don't use InputAction
      // here — the package isn't installed") is a correct grounded answer.
      { type: 'answer_not_matches', pattern: 'using\\s+UnityEngine\\.InputSystem|new\\s+InputAction' },
    ],
  },
  {
    id: 'grounding-deprecated-www', family: 'grounding', fixture: 'builtin-legacy', mode: 'ask',
    prompt: 'What\'s the modern way to download text from a URL in a script?',
    checks: [
      { type: 'answer_matches', pattern: 'UnityWebRequest' },
      // WWW → UnityWebRequest since 2018.
      { type: 'answer_not_matches', pattern: 'new\\s+WWW\\(' },
    ],
  },
  {
    id: 'grounding-deprecated-loadlevel', family: 'grounding', fixture: 'urp-newinput', mode: 'ask',
    prompt: 'What\'s the modern way to load a scene by name from a script?',
    checks: [
      { type: 'answer_matches', pattern: 'SceneManager\\.LoadScene' },
      // Application.LoadLevel → SceneManager.LoadScene since 5.3.
      { type: 'answer_not_matches', pattern: 'Application\\.LoadLevel\\s*\\(' },
    ],
  },

  // ── grounding (UI stack — facts alone can't answer; needs project exploration) ──
  // `builtin-legacy-ugui` is `builtin-legacy` plus one added scene
  // (Assets/Scenes/SampleScene.unity) carrying a `--- !u!223` Canvas
  // GameObject — a uGUI project, same as `builtin-legacy`, but this time
  // provably so from an artifact in the project rather than by the absence of
  // UI Toolkit files. Nothing in the injected facts block says "uGUI" or
  // "UIDocument" (`detectFixtureInventory` only ever emits a UI Toolkit line
  // when `.uxml` files exist, and never emits an explicit "this project does
  // NOT use X" line for anything) — so a correct answer has to come from
  // reading the project (the scene, the package manifest — no
  // `com.unity.modules.uielements`-only signal either), not from reciting a
  // fact already in the prompt.
  {
    id: 'grounding-ui-stack', family: 'grounding', fixture: 'builtin-legacy-ugui', mode: 'ask',
    prompt: 'I need to add a new UI screen to this project — a simple menu with a couple of buttons. What should I use to build it?',
    checks: [
      { type: 'answer_matches', pattern: 'Canvas' },
      // The wrong answer for a Canvas/uGUI project: UI Toolkit's runtime
      // component. Recommending it here would build a screen nothing in the
      // scene can show.
      { type: 'answer_not_matches', pattern: 'UIDocument' },
    ],
  },

  // ── agentic (multi-step, safety-aware) ──────────────────────────────
  {
    id: 'agentic-fsa-rename', family: 'agentic', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'Rename the serialized field `speed` in Assets/Scripts/PlayerController.cs to `moveSpeed` WITHOUT losing the values designers set in the Inspector.',
    checks: [
      { type: 'file_contains', path: 'Assets/Scripts/PlayerController.cs', pattern: 'moveSpeed' },
      { type: 'file_contains', path: 'Assets/Scripts/PlayerController.cs', pattern: 'FormerlySerializedAs\\("speed"\\)' },
      { type: 'file_not_contains', path: 'Assets/Scripts/PlayerController.cs', pattern: '\\bfloat speed\\b' },
    ],
  },
  {
    id: 'agentic-nre-fix', family: 'agentic', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'PlayerController throws "NullReferenceException" in Start() at runtime. Find the root cause and fix it properly (not just a null check that hides the bug).',
    checks: [
      { type: 'file_contains', path: 'Assets/Scripts/PlayerController.cs', pattern: 'GetComponent<Rigidbody>|RequireComponent' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/PlayerController.cs' },
    ],
  },
  {
    id: 'agentic-update-perf', family: 'agentic', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'Assets/Scripts/Mover.cs has a per-frame performance problem. Find and fix it.',
    checks: [
      { type: 'file_not_contains', path: 'Assets/Scripts/Mover.cs', pattern: 'void\\s+(update|Update)\\(\\)[^}]*GetComponent' },
      { type: 'analyzer_clean', glob: 'Assets/Scripts/Mover.cs' },
    ],
  },
  {
    id: 'agentic-lifecycle-typo', family: 'agentic', fixture: 'builtin-legacy', mode: 'agent',
    prompt: 'The Mover script\'s movement code never runs in play mode. Investigate why and fix it.',
    checks: [
      { type: 'file_contains', path: 'Assets/Scripts/Mover.cs', pattern: 'void Update\\(\\)' },
      { type: 'file_not_contains', path: 'Assets/Scripts/Mover.cs', pattern: 'void update\\(\\)' },
    ],
  },

  // ── plan (plan mode: is the drafted document actually a plan?) ───────
  //
  // Added after a real report: asked for a character controller, the planner
  // replied with a preamble — "First, let me study the exact scene file
  // structure…" — and that was written to disk and presented as the plan with
  // an Execute button under it. Nothing caught it. `plan-quality.ts` now
  // rejects that shape client-side, but a document can pass every structural
  // rule and still be useless, which is what these grade: does the plan carry
  // the Unity specifics the request actually turns on?
  //
  // Scored on the final answer only. Planning is read-only in prod, so there
  // are no files to check — `answer_matches` against the drafted document is
  // the whole surface.
  {
    id: 'plan-character-controller', family: 'plan', fixture: 'urp-newinput', mode: 'plan',
    prompt:
      'Build a full character controller I can drive with WASD and jump with space. '
      + 'The player is just a capsule. There are stairs in the level and the player must '
      + 'go up and down them without getting stuck. Set up a basic scene so I can play right away.',
    checks: [
      // The reported failure, pinned directly: a plan, not a preamble.
      { type: 'answer_matches', pattern: '^\\s*#\\s+\\S' },
      // No `m` flag on purpose: `^` then anchors to the START OF THE ANSWER,
      // which is the thing being tested. (JS has no `\A`.)
      { type: 'answer_not_matches', pattern: '^\\s*(I\'m going to|I will|First, let me|Let me)' },
      // Structure: the five sections and the closing sentinel.
      { type: 'answer_matches', pattern: '^## Goal', flags: 'm' },
      { type: 'answer_matches', pattern: '^## Context', flags: 'm' },
      { type: 'answer_matches', pattern: '^## Todos', flags: 'm' },
      { type: 'answer_matches', pattern: '^## Guide', flags: 'm' },
      { type: 'answer_matches', pattern: '^## Risks', flags: 'm' },
      { type: 'answer_matches', pattern: 'STOP — review and edit before execution\\.' },
      // At least five todos, and a guide entry for the fifth — the cheap way
      // to catch a checklist with no detail behind it.
      { type: 'answer_matches', pattern: '(?:^\\s*[-*] \\[[ x]\\] T\\d+[\\s\\S]*?){5}', flags: 'm' },
      { type: 'answer_matches', pattern: '^### T5\\b', flags: 'm' },
      // Substance: the request turns on these and nothing in this repo taught
      // them before `prompts/unity-recipes.ts`.
      { type: 'answer_matches', pattern: 'CharacterController|Rigidbody' },
      { type: 'answer_matches', pattern: 'stepOffset|step offset' },
      { type: 'answer_matches', pattern: 'slopeLimit|slope limit' },
      // This fixture is a NEW Input System project, so legacy input is wrong
      // here — the same trap the grounding family exists for.
      { type: 'answer_not_matches', pattern: 'Input\\.GetAxis|Input\\.GetKey' },
      // The scene half: the agent cannot build a scene, so a good plan says
      // what the user must do in the Inspector rather than pretending.
      { type: 'answer_matches', pattern: 'Inspector' },
    ],
  },
  {
    id: 'plan-legacy-input-controller', family: 'plan', fixture: 'builtin-legacy', mode: 'plan',
    // Same request, opposite project. Guards the recipe against teaching one
    // input API: it must defer to the project facts, which say legacy here.
    prompt:
      'Add WASD movement and a space-bar jump to the player capsule, and make sure '
      + 'it can walk up the stairs in the scene.',
    checks: [
      { type: 'answer_matches', pattern: '^\\s*#\\s+\\S' },
      { type: 'answer_matches', pattern: '^## Todos', flags: 'm' },
      { type: 'answer_matches', pattern: '^## Guide', flags: 'm' },
      { type: 'answer_matches', pattern: 'STOP — review and edit before execution\\.' },
      { type: 'answer_matches', pattern: 'stepOffset|step offset' },
      { type: 'answer_not_matches', pattern: 'InputAction|PlayerInput|Keyboard\\.current' },
    ],
  },
];
