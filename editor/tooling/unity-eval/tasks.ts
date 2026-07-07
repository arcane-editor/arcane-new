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
