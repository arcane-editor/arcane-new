/**
 * Static completion data for HLSL (`.hlsl`, `.cginc`, `.compute`) and for the
 * inline HLSL/CG blocks inside `.shader` files.
 *
 * No language server backs HLSL here, so these lists are the sole source of
 * intrinsic / macro / type completions surfaced by `services/completions.ts`.
 */

import type { ShaderCompletion } from './shaderlab';

/** HLSL built-in intrinsic functions. */
export const HLSL_INTRINSICS: ShaderCompletion[] = [
  { label: 'abs', insertText: 'abs(${1:x})', snippet: true, detail: 'Absolute value' },
  { label: 'acos', insertText: 'acos(${1:x})', snippet: true, detail: 'Arccosine' },
  { label: 'all', insertText: 'all(${1:x})', snippet: true, detail: 'True if all components nonzero' },
  { label: 'any', insertText: 'any(${1:x})', snippet: true, detail: 'True if any component nonzero' },
  { label: 'asin', insertText: 'asin(${1:x})', snippet: true, detail: 'Arcsine' },
  { label: 'atan', insertText: 'atan(${1:x})', snippet: true, detail: 'Arctangent' },
  { label: 'atan2', insertText: 'atan2(${1:y}, ${2:x})', snippet: true, detail: 'Arctangent of y/x' },
  { label: 'ceil', insertText: 'ceil(${1:x})', snippet: true, detail: 'Round up' },
  { label: 'clamp', insertText: 'clamp(${1:x}, ${2:min}, ${3:max})', snippet: true, detail: 'Clamp to range' },
  { label: 'clip', insertText: 'clip(${1:x})', snippet: true, detail: 'Discard fragment if x < 0' },
  { label: 'cos', insertText: 'cos(${1:x})', snippet: true, detail: 'Cosine' },
  { label: 'cosh', insertText: 'cosh(${1:x})', snippet: true, detail: 'Hyperbolic cosine' },
  { label: 'cross', insertText: 'cross(${1:a}, ${2:b})', snippet: true, detail: 'Cross product (float3)' },
  { label: 'ddx', insertText: 'ddx(${1:x})', snippet: true, detail: 'Partial derivative wrt x' },
  { label: 'ddy', insertText: 'ddy(${1:x})', snippet: true, detail: 'Partial derivative wrt y' },
  { label: 'degrees', insertText: 'degrees(${1:radians})', snippet: true, detail: 'Radians to degrees' },
  { label: 'determinant', insertText: 'determinant(${1:m})', snippet: true, detail: 'Matrix determinant' },
  { label: 'distance', insertText: 'distance(${1:a}, ${2:b})', snippet: true, detail: 'Distance between points' },
  { label: 'dot', insertText: 'dot(${1:a}, ${2:b})', snippet: true, detail: 'Dot product' },
  { label: 'exp', insertText: 'exp(${1:x})', snippet: true, detail: 'Base-e exponential' },
  { label: 'exp2', insertText: 'exp2(${1:x})', snippet: true, detail: 'Base-2 exponential' },
  { label: 'floor', insertText: 'floor(${1:x})', snippet: true, detail: 'Round down' },
  { label: 'fmod', insertText: 'fmod(${1:x}, ${2:y})', snippet: true, detail: 'Floating-point remainder' },
  { label: 'frac', insertText: 'frac(${1:x})', snippet: true, detail: 'Fractional part' },
  { label: 'fwidth', insertText: 'fwidth(${1:x})', snippet: true, detail: 'abs(ddx)+abs(ddy)' },
  { label: 'length', insertText: 'length(${1:v})', snippet: true, detail: 'Vector length' },
  { label: 'lerp', insertText: 'lerp(${1:a}, ${2:b}, ${3:t})', snippet: true, detail: 'Linear interpolation' },
  { label: 'log', insertText: 'log(${1:x})', snippet: true, detail: 'Natural logarithm' },
  { label: 'log2', insertText: 'log2(${1:x})', snippet: true, detail: 'Base-2 logarithm' },
  { label: 'log10', insertText: 'log10(${1:x})', snippet: true, detail: 'Base-10 logarithm' },
  { label: 'mad', insertText: 'mad(${1:a}, ${2:b}, ${3:c})', snippet: true, detail: 'a*b+c (fused)' },
  { label: 'max', insertText: 'max(${1:a}, ${2:b})', snippet: true, detail: 'Component-wise maximum' },
  { label: 'min', insertText: 'min(${1:a}, ${2:b})', snippet: true, detail: 'Component-wise minimum' },
  { label: 'mul', insertText: 'mul(${1:a}, ${2:b})', snippet: true, detail: 'Matrix/vector multiply' },
  { label: 'normalize', insertText: 'normalize(${1:v})', snippet: true, detail: 'Unit vector' },
  { label: 'pow', insertText: 'pow(${1:x}, ${2:y})', snippet: true, detail: 'x raised to y' },
  { label: 'radians', insertText: 'radians(${1:degrees})', snippet: true, detail: 'Degrees to radians' },
  { label: 'rcp', insertText: 'rcp(${1:x})', snippet: true, detail: 'Reciprocal (1/x)' },
  { label: 'reflect', insertText: 'reflect(${1:i}, ${2:n})', snippet: true, detail: 'Reflection vector' },
  { label: 'refract', insertText: 'refract(${1:i}, ${2:n}, ${3:eta})', snippet: true, detail: 'Refraction vector' },
  { label: 'round', insertText: 'round(${1:x})', snippet: true, detail: 'Round to nearest' },
  { label: 'rsqrt', insertText: 'rsqrt(${1:x})', snippet: true, detail: 'Reciprocal square root' },
  { label: 'saturate', insertText: 'saturate(${1:x})', snippet: true, detail: 'Clamp to [0, 1]' },
  { label: 'sign', insertText: 'sign(${1:x})', snippet: true, detail: 'Sign of x (-1/0/1)' },
  { label: 'sin', insertText: 'sin(${1:x})', snippet: true, detail: 'Sine' },
  { label: 'sincos', insertText: 'sincos(${1:x}, ${2:s}, ${3:c})', snippet: true, detail: 'Sine and cosine at once' },
  { label: 'sinh', insertText: 'sinh(${1:x})', snippet: true, detail: 'Hyperbolic sine' },
  { label: 'smoothstep', insertText: 'smoothstep(${1:min}, ${2:max}, ${3:x})', snippet: true, detail: 'Hermite interpolation' },
  { label: 'sqrt', insertText: 'sqrt(${1:x})', snippet: true, detail: 'Square root' },
  { label: 'step', insertText: 'step(${1:edge}, ${2:x})', snippet: true, detail: '0 if x<edge else 1' },
  { label: 'tan', insertText: 'tan(${1:x})', snippet: true, detail: 'Tangent' },
  { label: 'tanh', insertText: 'tanh(${1:x})', snippet: true, detail: 'Hyperbolic tangent' },
  { label: 'transpose', insertText: 'transpose(${1:m})', snippet: true, detail: 'Matrix transpose' },
  { label: 'trunc', insertText: 'trunc(${1:x})', snippet: true, detail: 'Truncate toward zero' },
  { label: 'tex2D', insertText: 'tex2D(${1:sampler}, ${2:uv})', snippet: true, detail: 'Sample a 2D texture (CG)' },
  { label: 'tex2Dlod', insertText: 'tex2Dlod(${1:sampler}, ${2:uv})', snippet: true, detail: 'Sample 2D texture at LOD (CG)' },
  { label: 'tex2Dproj', insertText: 'tex2Dproj(${1:sampler}, ${2:uv})', snippet: true, detail: 'Projective 2D sample (CG)' },
  { label: 'texCUBE', insertText: 'texCUBE(${1:sampler}, ${2:dir})', snippet: true, detail: 'Sample a cubemap (CG)' },
];

/** HLSL scalar / vector / matrix types and texture-object types. */
export const HLSL_TYPES: ShaderCompletion[] = [
  { label: 'float', detail: '32-bit float' },
  { label: 'float2', detail: '2-component float vector' },
  { label: 'float3', detail: '3-component float vector' },
  { label: 'float4', detail: '4-component float vector' },
  { label: 'float2x2', detail: '2x2 float matrix' },
  { label: 'float3x3', detail: '3x3 float matrix' },
  { label: 'float4x4', detail: '4x4 float matrix' },
  { label: 'half', detail: '16-bit float' },
  { label: 'half2', detail: '2-component half vector' },
  { label: 'half3', detail: '3-component half vector' },
  { label: 'half4', detail: '4-component half vector' },
  { label: 'int', detail: '32-bit integer' },
  { label: 'int2', detail: '2-component int vector' },
  { label: 'int3', detail: '3-component int vector' },
  { label: 'int4', detail: '4-component int vector' },
  { label: 'uint', detail: '32-bit unsigned integer' },
  { label: 'bool', detail: 'Boolean' },
  { label: 'fixed', detail: 'Low-precision fixed (CG)' },
  { label: 'fixed4', detail: '4-component fixed vector (CG)' },
  { label: 'void', detail: 'No return value' },
  { label: 'Texture2D', detail: 'HLSL 2D texture object' },
  { label: 'TextureCube', detail: 'HLSL cubemap object' },
  { label: 'Texture2DArray', detail: 'HLSL 2D texture array object' },
  { label: 'SamplerState', detail: 'HLSL sampler state' },
  { label: 'StructuredBuffer', detail: 'Read-only structured buffer' },
  { label: 'RWStructuredBuffer', detail: 'Read/write structured buffer' },
];

/** HLSL control-flow / declaration keywords. */
export const HLSL_KEYWORDS: ShaderCompletion[] = [
  { label: 'if', detail: 'Conditional' },
  { label: 'else', detail: 'Else branch' },
  { label: 'for', insertText: 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++)\n{\n\t$0\n}', snippet: true, detail: 'For loop' },
  { label: 'while', detail: 'While loop' },
  { label: 'return', detail: 'Return statement' },
  { label: 'discard', detail: 'Discard fragment' },
  { label: 'struct', insertText: 'struct ${1:Name}\n{\n\t$0\n};', snippet: true, detail: 'Struct declaration' },
  { label: 'cbuffer', insertText: 'cbuffer ${1:Name}\n{\n\t$0\n};', snippet: true, detail: 'Constant buffer' },
  { label: 'inout', detail: 'In/out parameter' },
  { label: 'uniform', detail: 'Uniform parameter' },
  { label: 'const', detail: 'Constant qualifier' },
];

/**
 * Unity ShaderLibrary macros (URP/HDRP `com.unity.render-pipelines.core`) and
 * legacy `UnityCG.cginc` macros / built-in values commonly hand-typed.
 */
export const HLSL_UNITY_MACROS: ShaderCompletion[] = [
  { label: 'TEXTURE2D', insertText: 'TEXTURE2D(${1:_MainTex});', snippet: true, detail: 'Declare a 2D texture (SRP)' },
  { label: 'TEXTURE2D_ARRAY', insertText: 'TEXTURE2D_ARRAY(${1:tex});', snippet: true, detail: 'Declare a 2D texture array (SRP)' },
  { label: 'TEXTURECUBE', insertText: 'TEXTURECUBE(${1:tex});', snippet: true, detail: 'Declare a cubemap (SRP)' },
  { label: 'SAMPLER', insertText: 'SAMPLER(${1:sampler_MainTex});', snippet: true, detail: 'Declare a sampler (SRP)' },
  { label: 'SAMPLE_TEXTURE2D', insertText: 'SAMPLE_TEXTURE2D(${1:_MainTex}, ${2:sampler_MainTex}, ${3:uv})', snippet: true, detail: 'Sample a 2D texture (SRP)' },
  { label: 'SAMPLE_TEXTURE2D_LOD', insertText: 'SAMPLE_TEXTURE2D_LOD(${1:tex}, ${2:samp}, ${3:uv}, ${4:lod})', snippet: true, detail: 'Sample a 2D texture at LOD (SRP)' },
  { label: 'SAMPLE_TEXTURECUBE', insertText: 'SAMPLE_TEXTURECUBE(${1:tex}, ${2:samp}, ${3:dir})', snippet: true, detail: 'Sample a cubemap (SRP)' },
  { label: 'CBUFFER_START', insertText: 'CBUFFER_START(${1:UnityPerMaterial})', snippet: true, detail: 'Begin a constant buffer (SRP)' },
  { label: 'CBUFFER_END', detail: 'End a constant buffer (SRP)' },
  { label: 'TRANSFORM_TEX', insertText: 'TRANSFORM_TEX(${1:uv}, ${2:_MainTex})', snippet: true, detail: 'Apply tiling/offset to UVs' },
  { label: 'UNITY_MATRIX_MVP', detail: 'Model-view-projection matrix' },
  { label: 'UNITY_MATRIX_M', detail: 'Model (object-to-world) matrix' },
  { label: 'UNITY_MATRIX_V', detail: 'View matrix' },
  { label: 'UNITY_MATRIX_P', detail: 'Projection matrix' },
  { label: 'UNITY_MATRIX_VP', detail: 'View-projection matrix' },
  { label: 'UNITY_PI', detail: 'Constant π (3.14159265359)' },
  { label: 'UNITY_TWO_PI', detail: 'Constant 2π' },
  { label: 'UNITY_HALF_PI', detail: 'Constant π/2' },
  { label: 'UNITY_VERTEX_INPUT_INSTANCE_ID', detail: 'Instance ID field in a vertex input struct' },
  { label: 'UNITY_VERTEX_OUTPUT_STEREO', detail: 'Stereo eye index in a v2f struct' },
  { label: 'UNITY_SETUP_INSTANCE_ID', insertText: 'UNITY_SETUP_INSTANCE_ID(${1:input});', snippet: true, detail: 'Set up GPU instancing for the vertex input' },
  { label: 'UNITY_TRANSFER_INSTANCE_ID', insertText: 'UNITY_TRANSFER_INSTANCE_ID(${1:input}, ${2:output});', snippet: true, detail: 'Copy instance ID to vertex output' },
  { label: 'UNITY_INITIALIZE_OUTPUT', insertText: 'UNITY_INITIALIZE_OUTPUT(${1:Type}, ${2:output});', snippet: true, detail: 'Zero-initialize an output struct' },
  { label: 'UnityObjectToClipPos', insertText: 'UnityObjectToClipPos(${1:v.vertex})', snippet: true, detail: 'Transform object position to clip space (UnityCG)' },
  { label: 'UnityObjectToWorldNormal', insertText: 'UnityObjectToWorldNormal(${1:v.normal})', snippet: true, detail: 'Transform object normal to world space (UnityCG)' },
  { label: 'TransformObjectToHClip', insertText: 'TransformObjectToHClip(${1:positionOS})', snippet: true, detail: 'Object to clip space (URP SpaceTransforms)' },
  { label: 'TransformObjectToWorld', insertText: 'TransformObjectToWorld(${1:positionOS})', snippet: true, detail: 'Object to world space (URP SpaceTransforms)' },
  { label: 'TransformObjectToWorldNormal', insertText: 'TransformObjectToWorldNormal(${1:normalOS})', snippet: true, detail: 'Object to world normal (URP SpaceTransforms)' },
];

/**
 * Common `#include` targets offered when the user is typing inside an
 * `#include "..."` string. Mix of legacy `.cginc` and SRP package paths.
 */
export const HLSL_COMMON_INCLUDES: ShaderCompletion[] = [
  { label: 'UnityCG.cginc', detail: 'Core built-in pipeline helpers' },
  { label: 'Lighting.cginc', detail: 'Built-in lighting models' },
  { label: 'AutoLight.cginc', detail: 'Shadow / attenuation macros' },
  { label: 'UnityShaderVariables.cginc', detail: 'Built-in global shader variables' },
  { label: 'UnityStandardBRDF.cginc', detail: 'Standard BRDF helpers' },
  {
    label: 'Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl',
    detail: 'URP core include',
  },
  {
    label: 'Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl',
    detail: 'URP lighting include',
  },
  {
    label: 'Packages/com.unity.render-pipelines.core/ShaderLibrary/Common.hlsl',
    detail: 'SRP core common include',
  },
  {
    label: 'Packages/com.unity.render-pipelines.core/ShaderLibrary/SpaceTransforms.hlsl',
    detail: 'SRP space-transform helpers',
  },
];
