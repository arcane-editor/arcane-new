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
      { type: 'answer_not_matches', pattern: '_BaseColor' },
    ],
  },
  {
    id: 'grounding-input-read', family: 'grounding', fixture: 'urp-newinput', mode: 'ask',
    prompt: 'Show me the idiomatic way to read WASD movement input in this project.',
    checks: [
      { type: 'answer_matches', pattern: 'InputAction|InputSystem|InputValue' },
      { type: 'answer_not_matches', pattern: 'Input\\.GetAxis' },
    ],
  },
  {
    id: 'grounding-legacy-input', family: 'grounding', fixture: 'builtin-legacy', mode: 'ask',
    prompt: 'Show me the idiomatic way to read WASD movement input in this project.',
    checks: [
      { type: 'answer_matches', pattern: 'Input\\.GetAxis' },
      { type: 'answer_not_matches', pattern: 'UnityEngine\\.InputSystem' },
    ],
  },

  // ── grounding (exact property/shader-name — facts alone can't answer) ──
  // `fixture-facts.ts`'s injected block only ever states version/pipeline/
  // input-system wording (see `buildFixtureFacts`) — it never names a
  // specific shader property or shader path string. So for the three tasks
  // below, where the "correct" answer *is* an exact identifier, the model
  // has to actually ground itself via `unity_api_search` rather than infer
  // it from the facts block; hence `tool_called`. The other new grounding
  // tasks turn on a directional/API-choice fact the model can reasonably
  // know already (or that the facts block states almost verbatim, e.g.
  // "Input Manager (legacy)"), so they don't get a `tool_called` check.
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
      { type: 'tool_called', tool: 'unity_api_search' },
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
      { type: 'tool_called', tool: 'unity_api_search' },
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
      { type: 'answer_not_matches', pattern: 'UnityEngine\\.InputSystem|InputAction' },
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
];
