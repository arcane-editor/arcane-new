import type { languages } from 'monaco-editor';

export const shaderlabLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.shaderlab',

  keywords: [
    'Shader', 'SubShader', 'Pass', 'Properties', 'Tags', 'Fallback',
    'CustomEditor', 'Category', 'UsePass', 'GrabPass', 'PackageRequirements',
    'Stencil', 'Name',
  ],

  renderStateKeywords: [
    'Blend', 'BlendOp', 'ZWrite', 'ZTest', 'ZClip', 'Cull', 'ColorMask',
    'Offset', 'AlphaToMask', 'Conservative',
  ],

  propertyTypes: [
    'Color', 'Vector', 'Float', 'Range', 'Int', 'Integer',
    '2D', '3D', 'Cube', 'CubeArray', '2DArray',
  ],

  blockMarkers: [
    'CGPROGRAM', 'ENDCG', 'CGINCLUDE',
    'HLSLPROGRAM', 'ENDHLSL', 'HLSLINCLUDE',
    'GLSLPROGRAM', 'ENDGLSL', 'GLSLINCLUDE',
  ],

  builtinValues: [
    'On', 'Off', 'True', 'False',
    'Back', 'Front',
    'Less', 'Greater', 'LEqual', 'GEqual', 'Equal', 'NotEqual', 'Always', 'Never',
    'One', 'Zero', 'SrcColor', 'SrcAlpha', 'DstColor', 'DstAlpha',
    'OneMinusSrcColor', 'OneMinusSrcAlpha', 'OneMinusDstColor', 'OneMinusDstAlpha',
    'Add', 'Sub', 'RevSub', 'Min', 'Max',
  ],

  pragmaKeywords: [
    'vertex', 'fragment', 'geometry', 'hull', 'domain', 'surface',
    'target', 'multi_compile', 'shader_feature', 'require',
    'multi_compile_local', 'shader_feature_local',
    'multi_compile_fog', 'multi_compile_instancing',
    'instancing_options', 'enable_d3d11_debug_symbols',
  ],

  tokenizer: {
    root: [
      // Block markers (CGPROGRAM, ENDCG, etc.)
      [/\b(CGPROGRAM|HLSLPROGRAM|GLSLPROGRAM|CGINCLUDE|HLSLINCLUDE|GLSLINCLUDE)\b/, 'keyword.block'],
      [/\b(ENDCG|ENDHLSL|ENDGLSL)\b/, 'keyword.block'],

      // Comments
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],

      // Strings
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string', '@string'],

      // Numbers
      [/\d*\.\d+([eE][-+]?\d+)?/, 'number.float'],
      [/\d+/, 'number'],

      // Pragma
      [/#pragma\b/, 'keyword.directive', '@pragma'],
      [/#include\b/, 'keyword.directive'],

      // Render state keywords
      [/\b(Blend|BlendOp|ZWrite|ZTest|ZClip|Cull|ColorMask|Offset|AlphaToMask|Conservative|Stencil)\b/, 'keyword.renderstate'],

      // Keywords
      [/\b(Shader|SubShader|Pass|Properties|Tags|Fallback|CustomEditor|Category|UsePass|GrabPass|PackageRequirements|Name)\b/, 'keyword'],

      // Property types (in brackets context)
      [/\b(Color|Vector|Float|Range|Int|Integer|2D|3D|Cube|CubeArray|2DArray)\b/, 'type'],

      // Built-in values
      [/\b(On|Off|True|False|Back|Front|Less|Greater|LEqual|GEqual|Equal|NotEqual|Always|Never|One|Zero|SrcColor|SrcAlpha|DstColor|DstAlpha|OneMinusSrcColor|OneMinusSrcAlpha|OneMinusDstColor|OneMinusDstAlpha|Add|Sub|RevSub|Min|Max)\b/, 'constant'],

      // Tags string values
      [/\[/, 'delimiter.bracket'],
      [/\]/, 'delimiter.bracket'],
      [/[{}()]/, 'delimiter'],
      [/=/, 'operator'],

      // Identifiers
      [/_\w+/, 'variable.property'],
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

    pragma: [
      [/\b(vertex|fragment|geometry|hull|domain|surface|target|multi_compile|shader_feature|require|multi_compile_local|shader_feature_local|multi_compile_fog|multi_compile_instancing|instancing_options|enable_d3d11_debug_symbols)\b/, 'keyword.directive'],
      [/$/, '', '@pop'],
      [/\S+/, 'identifier'],
    ],
  },
};

export const shaderlabLanguageConfig: languages.LanguageConfiguration = {
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
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
};
