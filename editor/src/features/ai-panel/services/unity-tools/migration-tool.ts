import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { txt } from './shared';
import { getUnityGroundingContext } from '../prompts/unity-facts';
import { unityDeprecatedApis } from './api-client';

// unity_plan_migration — produces a concrete, deterministic substitution map for
// a Unity conversion, which the agent then applies file-by-file (each write
// verified by the compile gate). Migrations are the worst case for API
// hallucination, so the heavy lifting is deterministic data, not model guessing.

const schema = Type.Object({
  kind: Type.Union(
    [Type.Literal('builtin-to-urp'), Type.Literal('input-system'), Type.Literal('version-upgrade')],
    {
      description:
        'Which conversion to plan: "builtin-to-urp" (Built-in render pipeline → URP), ' +
        '"input-system" (legacy Input Manager → new Input System), or "version-upgrade" ' +
        '(replace APIs deprecated in this Unity version).',
    },
  ),
});

// Built-in → URP shader-property + shader renames (stable, well-known).
const URP_SHADER_PROPS: Array<[string, string]> = [
  ['_Color', '_BaseColor'],
  ['_MainTex', '_BaseMap'],
  ['_Glossiness / _Smoothness', '_Smoothness'],
  ['_SpecColor', '_SpecColor (URP Lit: use metallic/smoothness workflow)'],
  ['_EmissionColor', '_EmissionColor (enable keyword "_EMISSION")'],
];

const URP_GUIDANCE = [
  'Shaders: "Standard" → "Universal Render Pipeline/Lit"; "Unlit/Texture" → "Universal Render Pipeline/Unlit".',
  'material.SetColor("_Color", c) → material.SetColor("_BaseColor", c); SetTexture("_MainTex", t) → "_BaseMap".',
  'Camera.main.Render() / custom OnRenderImage post effects → URP ScriptableRendererFeature / RenderPipelineManager hooks.',
  'Graphics.Blit in image effects → Blitter.BlitCameraTexture inside a ScriptableRenderPass.',
  'GrabPass / direct fixed-function shaders are unsupported — use a Renderer Feature or _CameraOpaqueTexture.',
];

const INPUT_MAP: Array<[string, string]> = [
  ['Input.GetAxis("Horizontal"/"Vertical")', 'InputAction (Value/Vector2) — action.ReadValue<Vector2>() / <float>()'],
  ['Input.GetAxisRaw(...)', 'InputAction value with no smoothing (processor) — action.ReadValue<float>()'],
  ['Input.GetKeyDown(KeyCode.X)', 'Keyboard.current.xKey.wasPressedThisFrame  (or an action: action.WasPressedThisFrame())'],
  ['Input.GetKey(KeyCode.X)', 'Keyboard.current.xKey.isPressed  (or action.IsPressed())'],
  ['Input.GetMouseButtonDown(0)', 'Mouse.current.leftButton.wasPressedThisFrame'],
  ['Input.mousePosition', 'Mouse.current.position.ReadValue()'],
  ['Input.GetButtonDown("Jump")', 'jumpAction.WasPressedThisFrame()'],
  ['Input.touchCount / Input.GetTouch(i)', 'Touchscreen.current / EnhancedTouch.Touch.activeTouches'],
];

const INPUT_GUIDANCE = [
  'Add an Input Actions asset (.inputactions) or use PlayerInput; reference actions via InputActionReference or generated C# class.',
  'Enable actions in OnEnable and disable in OnDisable; read in Update via ReadValue / WasPressedThisFrame.',
  'using UnityEngine.InputSystem; (and UnityEngine.InputSystem.EnhancedTouch for touch).',
  'Ensure Project Settings → Player → Active Input Handling is "Input System Package" (or "Both" during migration).',
];

function table(rows: Array<[string, string]>): string {
  return rows.map(([a, b]) => `  • ${a}  →  ${b}`).join('\n');
}

export function createUnityMigrationTool(): AgentTool {
  return {
    name: 'unity_plan_migration',
    label: 'unity plan migration',
    description:
      'Plan a Unity conversion (Built-in→URP, legacy Input→Input System, or version-deprecation upgrade). ' +
      'Returns a concrete substitution map to apply file-by-file. Call this FIRST when asked to migrate/convert.',
    parameters: schema,
    async execute(_id, params) {
      const { kind } = params as Static<typeof schema>;
      const ctx = getUnityGroundingContext();
      const versionNote = `Project Unity version: ${ctx.unityVersion ?? 'unknown'}; render pipeline: ${ctx.renderPipeline ?? 'unknown'}; input system: ${ctx.inputSystem ?? 'unknown'}.`;

      if (kind === 'builtin-to-urp') {
        return txt(
          `# Migration plan: Built-in → URP\n${versionNote}\n\n` +
            `Shader property renames (update material.Set*/GetColor/Texture calls and custom shaders):\n` +
            `${table(URP_SHADER_PROPS)}\n\nGuidance:\n- ${URP_GUIDANCE.join('\n- ')}\n\n` +
            processFooter(),
        );
      }

      if (kind === 'input-system') {
        return txt(
          `# Migration plan: legacy Input Manager → Input System\n${versionNote}\n\n` +
            `API substitutions:\n${table(INPUT_MAP)}\n\nGuidance:\n- ${INPUT_GUIDANCE.join('\n- ')}\n\n` +
            processFooter(),
        );
      }

      // version-upgrade — enumerate deprecated APIs from the version-accurate index.
      const deprecated = await unityDeprecatedApis(400);
      if (deprecated.length === 0) {
        return txt(
          `# Migration plan: version deprecation upgrade\n${versionNote}\n\n` +
            `No deprecated-API list available for this version (index may not be ingested yet, or you're signed out). ` +
            `Use unity_api_search to confirm replacements, and rely on the compile gate's warnings.\n\n` +
            processFooter(),
        );
      }
      const lines = deprecated
        .slice(0, 60)
        .map(
          (d) =>
            `  • ${d.namespace ? d.namespace + '.' : ''}${d.type}.${d.member}` +
            (d.obsoleteMessage ? ` — ${d.obsoleteMessage}` : ' — deprecated'),
        )
        .join('\n');
      return txt(
        `# Migration plan: version deprecation upgrade\n${versionNote}\n\n` +
          `Deprecated APIs to replace (top ${Math.min(60, deprecated.length)} of ${deprecated.length}):\n${lines}\n\n` +
          processFooter(),
      );
    },
  };
}

function processFooter(): string {
  return [
    'How to apply:',
    '1. Find affected files first (list/read or grep for the old APIs/strings).',
    '2. Convert ONE file at a time with edit; after each, the compile gate recompiles and reports errors.',
    '3. Use unity_api_search ("Type.Member") to confirm exact signatures before substituting.',
    '4. Never reintroduce a deprecated API or a Built-in-only construct for the target pipeline/input system.',
  ].join('\n');
}
