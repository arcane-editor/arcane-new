/**
 * Static completion data for ShaderLab (`.shader`) files.
 *
 * These are plain keyword/structure suggestions surfaced by the Monaco
 * completion provider in `services/completions.ts`. ShaderLab has no
 * language server, so this is the sole source of structural completions.
 */

export interface ShaderCompletion {
  /** Text shown in the completion list and inserted (unless `insertText`). */
  label: string;
  /** Snippet body (TextMate `${1:..}` placeholders). Falls back to `label`. */
  insertText?: string;
  /** Whether `insertText` is a snippet (has placeholders / tab stops). */
  snippet?: boolean;
  /** Short right-hand description shown in the completion list. */
  detail?: string;
  /** Markdown documentation shown in the details fly-out. */
  documentation?: string;
}

/**
 * Top-level + block structure keywords. Snippet bodies scaffold the common
 * shape so users get a usable block, not just the bare keyword.
 */
export const SHADERLAB_STRUCTURE: ShaderCompletion[] = [
  {
    label: 'Shader',
    insertText: 'Shader "${1:Custom/NewShader}"\n{\n\t$0\n}',
    snippet: true,
    detail: 'Shader block',
    documentation: 'Top-level shader declaration with a menu path name.',
  },
  {
    label: 'Properties',
    insertText: 'Properties\n{\n\t$0\n}',
    snippet: true,
    detail: 'Properties block',
    documentation: 'Material properties exposed in the Inspector.',
  },
  {
    label: 'SubShader',
    insertText: 'SubShader\n{\n\t$0\n}',
    snippet: true,
    detail: 'SubShader block',
    documentation: 'A set of passes for a given hardware tier / pipeline.',
  },
  {
    label: 'Pass',
    insertText: 'Pass\n{\n\t$0\n}',
    snippet: true,
    detail: 'Pass block',
    documentation: 'A single rendering pass.',
  },
  {
    label: 'Tags',
    insertText: 'Tags { "${1:RenderType}" = "${2:Opaque}" }',
    snippet: true,
    detail: 'Tags block',
    documentation: 'Key/value tags that tell Unity how/when to render.',
  },
  {
    label: 'LOD',
    insertText: 'LOD ${1:100}',
    snippet: true,
    detail: 'Level of detail',
    documentation: 'SubShader LOD value used by shader LOD culling.',
  },
  {
    label: 'Fallback',
    insertText: 'Fallback "${1:Diffuse}"',
    snippet: true,
    detail: 'Fallback shader',
    documentation: 'Shader to fall back to when no SubShader is supported.',
  },
  {
    label: 'CustomEditor',
    insertText: 'CustomEditor "${1:MyShaderGUI}"',
    snippet: true,
    detail: 'Custom material editor',
    documentation: 'Name of a ShaderGUI class used to draw the material Inspector.',
  },
  {
    label: 'Cull',
    insertText: 'Cull ${1|Back,Front,Off|}',
    snippet: true,
    detail: 'Face culling',
    documentation: 'Which polygon faces to cull. `Back` (default), `Front`, or `Off`.',
  },
  {
    label: 'ZWrite',
    insertText: 'ZWrite ${1|On,Off|}',
    snippet: true,
    detail: 'Depth write',
    documentation: 'Whether this pass writes to the depth buffer.',
  },
  {
    label: 'ZTest',
    insertText: 'ZTest ${1|LEqual,Less,Greater,GEqual,Equal,NotEqual,Always|}',
    snippet: true,
    detail: 'Depth test',
    documentation: 'Depth comparison function used for this pass.',
  },
  {
    label: 'Blend',
    insertText: 'Blend ${1|SrcAlpha,One,Zero,OneMinusSrcAlpha|} ${2|OneMinusSrcAlpha,One,Zero|}',
    snippet: true,
    detail: 'Blend mode',
    documentation: 'Source/destination blend factors for transparency.',
  },
  {
    label: 'ColorMask',
    insertText: 'ColorMask ${1:RGBA}',
    snippet: true,
    detail: 'Color write mask',
  },
  {
    label: 'Offset',
    insertText: 'Offset ${1:0}, ${2:0}',
    snippet: true,
    detail: 'Depth offset',
  },
  {
    label: 'Stencil',
    insertText: 'Stencil\n{\n\tRef ${1:0}\n\tComp ${2:Always}\n\tPass ${3:Keep}\n}',
    snippet: true,
    detail: 'Stencil block',
  },
  {
    label: 'CGPROGRAM',
    insertText: 'CGPROGRAM\n$0\nENDCG',
    snippet: true,
    detail: 'CG program block',
    documentation: 'Inline CG/HLSL shader code block (legacy built-in pipeline).',
  },
  {
    label: 'ENDCG',
    detail: 'End CG program block',
  },
  {
    label: 'HLSLPROGRAM',
    insertText: 'HLSLPROGRAM\n$0\nENDHLSL',
    snippet: true,
    detail: 'HLSL program block',
    documentation: 'Inline HLSL shader code block (SRP / URP / HDRP).',
  },
  {
    label: 'ENDHLSL',
    detail: 'End HLSL program block',
  },
  {
    label: 'CGINCLUDE',
    insertText: 'CGINCLUDE\n$0\nENDCG',
    snippet: true,
    detail: 'Shared CG include block',
  },
  {
    label: 'HLSLINCLUDE',
    insertText: 'HLSLINCLUDE\n$0\nENDHLSL',
    snippet: true,
    detail: 'Shared HLSL include block',
  },
];

/**
 * `#pragma` directives valid inside CG/HLSL program blocks within a Pass.
 * Surfaced when the user has typed `#pragma `.
 */
export const SHADERLAB_PRAGMAS: ShaderCompletion[] = [
  { label: 'vertex', insertText: 'vertex ${1:vert}', snippet: true, detail: 'Vertex shader entry' },
  { label: 'fragment', insertText: 'fragment ${1:frag}', snippet: true, detail: 'Fragment shader entry' },
  { label: 'geometry', insertText: 'geometry ${1:geom}', snippet: true, detail: 'Geometry shader entry' },
  { label: 'target', insertText: 'target ${1:3.0}', snippet: true, detail: 'Shader model target' },
  { label: 'multi_compile', insertText: 'multi_compile ${1:_ KEYWORD}', snippet: true, detail: 'Compile variants' },
  { label: 'multi_compile_local', insertText: 'multi_compile_local ${1:_ KEYWORD}', snippet: true, detail: 'Local compile variants' },
  { label: 'multi_compile_fog', detail: 'Fog variants' },
  { label: 'multi_compile_instancing', detail: 'GPU instancing variants' },
  { label: 'shader_feature', insertText: 'shader_feature ${1:_ KEYWORD}', snippet: true, detail: 'Material-stripped variants' },
  { label: 'shader_feature_local', insertText: 'shader_feature_local ${1:_ KEYWORD}', snippet: true, detail: 'Local material-stripped variants' },
  { label: 'require', insertText: 'require ${1:geometry}', snippet: true, detail: 'Required GPU feature' },
];

/**
 * Common Tag *keys* offered inside a `Tags { ... }` block. Each scaffolds the
 * `"Key" = "Value"` pair with the value as a placeholder.
 */
export const SHADERLAB_TAG_KEYS: ShaderCompletion[] = [
  {
    label: 'RenderType',
    insertText: '"RenderType" = "${1|Opaque,Transparent,TransparentCutout,Background,Overlay|}"',
    snippet: true,
    detail: 'Render type tag',
  },
  {
    label: 'Queue',
    insertText: '"Queue" = "${1|Geometry,AlphaTest,Transparent,Overlay,Background|}"',
    snippet: true,
    detail: 'Render queue tag',
  },
  {
    label: 'RenderPipeline',
    insertText: '"RenderPipeline" = "${1|UniversalPipeline,HDRenderPipeline,UniversalGBuffer|}"',
    snippet: true,
    detail: 'SRP render pipeline tag',
  },
  {
    label: 'LightMode',
    insertText: '"LightMode" = "${1|UniversalForward,ShadowCaster,DepthOnly,SRPDefaultUnlit,ForwardBase,ForwardAdd|}"',
    snippet: true,
    detail: 'Pass light mode tag',
  },
  {
    label: 'IgnoreProjector',
    insertText: '"IgnoreProjector" = "${1|True,False|}"',
    snippet: true,
    detail: 'Ignore projectors tag',
  },
  {
    label: 'DisableBatching',
    insertText: '"DisableBatching" = "${1|True,False,LODFading|}"',
    snippet: true,
    detail: 'Disable batching tag',
  },
  {
    label: 'PreviewType',
    insertText: '"PreviewType" = "${1|Sphere,Plane,Skybox|}"',
    snippet: true,
    detail: 'Inspector preview type tag',
  },
];

/**
 * Bare Tag value strings, offered when the user is typing inside the value
 * side of a tag (after `=` / inside a quote). Grouped here so the provider
 * can surface plausible values regardless of which key precedes them.
 */
export const SHADERLAB_TAG_VALUES: ShaderCompletion[] = [
  { label: 'Opaque', detail: 'RenderType / Queue value' },
  { label: 'Transparent', detail: 'RenderType / Queue value' },
  { label: 'TransparentCutout', detail: 'RenderType value' },
  { label: 'Geometry', detail: 'Queue value' },
  { label: 'AlphaTest', detail: 'Queue value' },
  { label: 'Overlay', detail: 'Queue value' },
  { label: 'Background', detail: 'Queue value' },
  { label: 'UniversalPipeline', detail: 'RenderPipeline value' },
  { label: 'HDRenderPipeline', detail: 'RenderPipeline value' },
  { label: 'UniversalForward', detail: 'LightMode value' },
  { label: 'ShadowCaster', detail: 'LightMode value' },
  { label: 'DepthOnly', detail: 'LightMode value' },
];
