/**
 * Contrastive anti-default Unity facts table (Task P2.1).
 *
 * Phase-1 grounding baselines (24 tasks × 3 tiers, real recorded grounding —
 * see `tooling/unity-eval/README.md` "Baseline results") showed the surviving
 * failures are NOT missing knowledge — they're the model reverting to a
 * training-memory DEFAULT that is wrong for THIS project (`_Color` in a URP
 * project, `Input.GetAxis` under the new Input System, etc.). A generic fact
 * like "Render pipeline: URP" doesn't reliably beat that prior; explicitly
 * naming the wrong default AND the right answer in the same breath
 * ("`_BaseColor` is correct here; `_Color` is WRONG here") is the cheapest
 * known counter.
 *
 * This table is the SINGLE SOURCE for two consumers:
 *   1. `promptLine` — folded into the "Unity project facts" prompt block by
 *      both production (`unity-facts.ts`) and the eval
 *      (`tooling/unity-eval/fixture-facts.ts`), from the SAME detected
 *      render-pipeline/input-system values each already computes.
 *   2. `wrongTokens` / `correction` — feeds Task P2.2's answer-linter
 *      wrong-token patterns (code-block-only scoping happens there, not
 *      here — these patterns are deliberately just "does this token appear
 *      as a shader-property/API string", precise enough to avoid obvious
 *      false positives but not scoped to markdown code fences).
 *
 * PURE and Bun-safe: zero store/Monaco/Tauri imports. This file is imported
 * directly by the eval harness under plain Bun (see the header comment of
 * `tooling/unity-eval/checks.ts` for the precedent/hazard this avoids) as
 * well as by production's `unity-facts.ts`.
 */

/** Detected Unity render pipeline (mirrors `RenderPipeline` in `unity-facts.ts`). */
export type ContrastRenderPipeline = 'URP' | 'HDRP' | 'Built-in';

/**
 * Detected Unity input-system configuration. Values mirror the structured
 * shape `getUnityGroundingContext()` (`unity-facts.ts`) and
 * `buildFixtureGroundingContext()` (`tooling/unity-eval/fixture-facts.ts`)
 * already compute — both derive from `ProjectSettings.asset`'s
 * `activeInputHandler` (0/1/2 → Legacy/New/Both), not package presence.
 */
export type ContrastInputSystem = 'Legacy' | 'New' | 'Both';

/** Structural facts a contrast row keys its applicability on. `null` means "unknown/undetected". */
export interface ContrastFacts {
  renderPipeline: ContrastRenderPipeline | null;
  inputSystem: ContrastInputSystem | null;
}

/** A regex (as a string, compiled by consumers) plus optional flags. */
export interface WrongTokenPattern {
  pattern: string;
  flags?: string;
}

export interface ContrastRow {
  /** Unique, kebab-case, stable (P2.2 may key off it). */
  id: string;
  appliesWhen: (facts: ContrastFacts) => boolean;
  /** Rendered as one prompt bullet line (no leading "- "; `contrastFactLines` adds it). */
  promptLine: string;
  /**
   * Training-default token(s) that are WRONG under this row's facts —
   * single source for P2.2's answer-linter. Deliberately scoped to
   * shader-property-string / API-call usage, not bare identifiers, to keep
   * obvious false positives (prose mentions, unrelated identifiers) down.
   */
  wrongTokens: WrongTokenPattern[];
  /** Short human-readable remediation, meant to sit next to a flagged token. */
  correction: string;
}

const ROWS: ContrastRow[] = [
  {
    id: 'urp-color',
    appliesWhen: (facts) => facts.renderPipeline === 'URP',
    promptLine:
      'Shader color property is `_BaseColor` (texture: `_BaseMap`). `_Color`/`_MainTex` are WRONG in this project (Built-in names).',
    wrongTokens: [
      { pattern: 'SetColor\\(\\s*"_Color"' },
      { pattern: '"_Color"' },
      { pattern: 'SetTexture\\(\\s*"_MainTex"' },
      { pattern: '"_MainTex"' },
    ],
    correction: 'Use `_BaseColor` (SetColor) / `_BaseMap` (SetTexture) — the URP Lit shader property names.',
  },
  {
    id: 'builtin-color',
    appliesWhen: (facts) => facts.renderPipeline === 'Built-in',
    promptLine:
      '`_Color`/`_MainTex` are correct here; `_BaseColor`/`_BaseMap` are URP names and WRONG here.',
    wrongTokens: [
      { pattern: 'SetColor\\(\\s*"_BaseColor"' },
      { pattern: '"_BaseColor"' },
      { pattern: 'SetTexture\\(\\s*"_BaseMap"' },
      { pattern: '"_BaseMap"' },
    ],
    correction: 'Use `_Color` (SetColor) / `_MainTex` (SetTexture) — the Built-in shader property names.',
  },
  {
    id: 'urp-postfx',
    appliesWhen: (facts) => facts.renderPipeline === 'URP',
    promptLine:
      'Full-screen effects: `OnRenderImage` does NOT run under URP — use a ScriptableRenderPass / Renderer Feature.',
    wrongTokens: [{ pattern: 'void\\s+OnRenderImage\\s*\\(' }],
    correction: 'Use a ScriptableRenderPass / Renderer Feature instead of `OnRenderImage` under URP.',
  },
  {
    id: 'builtin-postfx',
    appliesWhen: (facts) => facts.renderPipeline === 'Built-in',
    promptLine:
      'Full-screen effects: `OnRenderImage` is the classic approach here; `ScriptableRenderPass` is URP-only and does not apply to this project.',
    wrongTokens: [{ pattern: ':\\s*ScriptableRenderPass\\b' }],
    correction: 'Use `OnRenderImage` (a MonoBehaviour camera callback) instead of ScriptableRenderPass under the Built-in pipeline.',
  },
  {
    id: 'input-new',
    appliesWhen: (facts) => facts.inputSystem === 'New',
    promptLine:
      'New Input System is active: `Input.GetAxis/GetKey/GetButton/GetMouseButton` are WRONG here — use InputAction/PlayerInput.',
    wrongTokens: [
      {
        pattern:
          'Input\\.(GetAxis|GetAxisRaw|GetKey|GetKeyDown|GetKeyUp|GetButton|GetButtonDown|GetButtonUp|GetMouseButton)',
      },
    ],
    correction: 'Use InputAction / PlayerInput (new Input System) instead of `Input.GetAxis`/`GetKey`/`GetButton`.',
  },
  {
    id: 'input-legacy',
    appliesWhen: (facts) => facts.inputSystem === 'Legacy',
    promptLine:
      'Legacy Input Manager is active: do NOT use `UnityEngine.InputSystem`/InputAction (package not enabled) — `Input.GetAxis` etc. are correct here.',
    wrongTokens: [
      { pattern: 'using\\s+UnityEngine\\.InputSystem' },
      { pattern: '\\bInputAction\\b' },
      { pattern: '\\bPlayerInput\\b' },
    ],
    correction: 'Use `Input.GetAxis`/`GetKey`/`GetButton` (legacy Input Manager) instead of UnityEngine.InputSystem/InputAction/PlayerInput.',
  },
  // input 'Both' intentionally has no row: either API is valid, so there is
  // no wrong default to warn against.

  // Version-independent deprecations — always on, regardless of pipeline/input.
  {
    id: 'deprecated-www',
    appliesWhen: () => true,
    promptLine: '`WWW` is deprecated — use `UnityWebRequest` for networking/file loads instead.',
    wrongTokens: [{ pattern: 'new\\s+WWW\\s*\\(' }],
    correction: 'Use `UnityWebRequest` instead of `WWW`.',
  },
  {
    id: 'deprecated-loadlevel',
    appliesWhen: () => true,
    promptLine: '`Application.LoadLevel` is deprecated — use `SceneManager.LoadScene` instead.',
    wrongTokens: [{ pattern: 'Application\\.LoadLevel\\s*\\(' }],
    correction: 'Use `SceneManager.LoadScene` instead of `Application.LoadLevel`.',
  },
];

/** The contrast rows applicable to the given facts, in table order. */
export function contrastRows(facts: ContrastFacts): ContrastRow[] {
  return ROWS.filter((row) => row.appliesWhen(facts));
}

/**
 * The prompt lines for the given facts, each already bullet-prefixed
 * ("- ...") so callers can splice them directly into a facts block.
 */
export function contrastFactLines(facts: ContrastFacts): string[] {
  return contrastRows(facts).map((row) => `- ${row.promptLine}`);
}
