import type { languages } from 'monaco-editor';

export const hlslLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.hlsl',

  keywords: [
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'break', 'continue', 'return', 'discard', 'clip',
    'struct', 'cbuffer', 'tbuffer', 'ConstantBuffer',
    'typedef', 'static', 'const', 'inline', 'extern',
    'in', 'out', 'inout', 'uniform',
    'void', 'true', 'false',
    'register', 'packoffset',
  ],

  types: [
    'bool', 'int', 'uint', 'dword', 'half', 'float', 'double', 'fixed',
    'bool2', 'bool3', 'bool4',
    'int2', 'int3', 'int4',
    'uint2', 'uint3', 'uint4',
    'half2', 'half3', 'half4',
    'float2', 'float3', 'float4',
    'double2', 'double3', 'double4',
    'float2x2', 'float3x3', 'float4x4',
    'float3x4', 'float4x3',
    'half2x2', 'half3x3', 'half4x4',
    'int2x2', 'int3x3', 'int4x4',
    'min16float', 'min16float2', 'min16float3', 'min16float4',
    'min16int', 'min16int2', 'min16int3', 'min16int4',
    'min16uint', 'min16uint2', 'min16uint3', 'min16uint4',
    'sampler', 'sampler2D', 'sampler3D', 'samplerCUBE',
    'SamplerState', 'SamplerComparisonState',
    'Texture2D', 'Texture2DArray', 'Texture3D', 'TextureCube', 'TextureCubeArray',
    'Texture2DMS', 'RWTexture2D', 'RWTexture3D',
    'Buffer', 'StructuredBuffer', 'RWStructuredBuffer',
    'ByteAddressBuffer', 'RWByteAddressBuffer',
    'AppendStructuredBuffer', 'ConsumeStructuredBuffer',
  ],

  intrinsics: [
    'abs', 'acos', 'all', 'any', 'asin', 'atan', 'atan2',
    'ceil', 'clamp', 'clip', 'cos', 'cosh', 'cross',
    'ddx', 'ddy', 'ddx_coarse', 'ddx_fine', 'ddy_coarse', 'ddy_fine',
    'degrees', 'determinant', 'distance', 'dot',
    'exp', 'exp2',
    'faceforward', 'floor', 'fmod', 'frac', 'frexp',
    'fwidth',
    'isfinite', 'isinf', 'isnan',
    'ldexp', 'length', 'lerp', 'lit', 'log', 'log10', 'log2',
    'mad', 'max', 'min', 'modf', 'mul',
    'normalize',
    'pow',
    'radians', 'rcp', 'reflect', 'refract', 'reversebits', 'round', 'rsqrt',
    'saturate', 'sign', 'sin', 'sincos', 'sinh', 'smoothstep', 'sqrt', 'step',
    'tan', 'tanh', 'tex2D', 'tex2Dlod', 'tex2Dproj', 'tex2Dbias',
    'tex3D', 'texCUBE', 'texCUBElod',
    'transpose', 'trunc',
    'UnityObjectToClipPos', 'UnityObjectToWorldNormal', 'UnityWorldSpaceViewDir',
    'UnityWorldSpaceLightDir', 'TRANSFORM_TEX',
  ],

  semantics: [
    'SV_POSITION', 'SV_Position', 'SV_Target', 'SV_Target0', 'SV_Target1',
    'SV_Target2', 'SV_Target3', 'SV_Target4', 'SV_Target5', 'SV_Target6', 'SV_Target7',
    'SV_Depth', 'SV_VertexID', 'SV_InstanceID', 'SV_PrimitiveID',
    'SV_IsFrontFace', 'SV_SampleIndex', 'SV_Coverage',
    'SV_DispatchThreadID', 'SV_GroupID', 'SV_GroupIndex', 'SV_GroupThreadID',
    'POSITION', 'NORMAL', 'TANGENT', 'BINORMAL', 'COLOR', 'COLOR0', 'COLOR1',
    'TEXCOORD0', 'TEXCOORD1', 'TEXCOORD2', 'TEXCOORD3',
    'TEXCOORD4', 'TEXCOORD5', 'TEXCOORD6', 'TEXCOORD7',
    'VFACE', 'VPOS',
  ],

  operators: [
    '=', '>', '<', '!', '~', '?', ':',
    '==', '<=', '>=', '!=', '&&', '||', '++', '--',
    '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>',
    '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '<<=', '>>=',
  ],

  tokenizer: {
    root: [
      // Comments
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],

      // Preprocessor
      [/#\s*(include|pragma|define|undef|if|ifdef|ifndef|else|elif|endif|error|warning|line)\b/, 'keyword.directive', '@preprocessor'],

      // Strings (for #include)
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string', '@string'],
      [/<[^>]+>/, 'string'],

      // Numbers
      [/\d*\.\d+([eE][-+]?\d+)?[fFhH]?/, 'number.float'],
      [/0[xX][0-9a-fA-F]+[uU]?/, 'number.hex'],
      [/\d+[uU]?/, 'number'],

      // Semantics (must come before identifiers)
      [/\b(SV_\w+|POSITION|NORMAL|TANGENT|BINORMAL|COLOR[01]?|TEXCOORD[0-7]|VFACE|VPOS)\b/, 'type.semantic'],

      // Types
      [/\b(bool|int|uint|dword|half|float|double|fixed|sampler\w*|SamplerState|SamplerComparisonState|Texture\w+|RWTexture\w+|Buffer|StructuredBuffer|RWStructuredBuffer|ByteAddressBuffer|RWByteAddressBuffer|AppendStructuredBuffer|ConsumeStructuredBuffer|ConstantBuffer)\b/, 'type'],
      [/\b(bool|int|uint|half|float|double|min16float|min16int|min16uint)[234]?\b/, 'type'],
      [/\b(float|half|int|uint|bool)[234]x[234]\b/, 'type'],

      // Keywords
      [/\b(if|else|for|while|do|switch|case|default|break|continue|return|discard|struct|cbuffer|tbuffer|typedef|static|const|inline|extern|in|out|inout|uniform|void|true|false|register|packoffset)\b/, 'keyword'],

      // Intrinsic functions
      [/\b(abs|acos|all|any|asin|atan2?|ceil|clamp|clip|cosh?|cross|ddx\w*|ddy\w*|degrees|determinant|distance|dot|exp2?|faceforward|floor|fmod|frac|frexp|fwidth|isfinite|isinf|isnan|ldexp|length|lerp|lit|log\d*|mad|max|min|modf|mul|normalize|pow|radians|rcp|reflect|refract|reversebits|round|rsqrt|saturate|sign|sincos|sinh?|smoothstep|sqrt|step|tanh?|tex2D\w*|tex3D|texCUBE\w*|transpose|trunc)\b/, 'support.function'],

      // Unity helper functions
      [/\b(UnityObjectToClipPos|UnityObjectToWorldNormal|UnityWorldSpaceViewDir|UnityWorldSpaceLightDir|TRANSFORM_TEX|UNITY_\w+)\b/, 'support.function'],

      // Operators
      [/[+\-*/&|^~!<>=?:%]+/, 'operator'],

      // Delimiters
      [/[{}()[\]]/, 'delimiter'],
      [/[;,.]/, 'delimiter'],

      // Identifiers
      [/[a-zA-Z_]\w*/, 'identifier'],
    ],

    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],

    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],

    preprocessor: [
      [/\\$/, 'keyword.directive'],
      [/$/, '', '@pop'],
      [/\b(vertex|fragment|geometry|hull|domain|surface|target|multi_compile\w*|shader_feature\w*|require|instancing_options|enable_d3d11_debug_symbols)\b/, 'keyword.directive'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/<[^>]+>/, 'string'],
      [/\S+/, 'identifier'],
    ],
  },
};

export const hlslLanguageConfig: languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/'],
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};
