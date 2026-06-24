// C# script template generators for Unity projects.
//
// Each generator is a pure function `(className, namespace?) => string` that
// produces the full file contents. CRITICAL invariant: the generated type name
// always equals `className`, which the caller derives from the target file
// stem — Unity requires a MonoBehaviour's class name to match its file name, so
// a script created from these templates compiles with zero edits.
//
// Indentation is 4 spaces (C#/Unity convention). When a namespace is supplied
// the body is wrapped one level deeper; with no namespace it sits at column 0.

/** Distinct template kinds the New Script modal can produce. */
export type ScriptTemplateKind =
  | 'monobehaviour'
  | 'scriptableobject'
  | 'editor'
  | 'editorWindow'
  | 'propertyDrawer'
  | 'class'
  | 'interface'
  | 'struct'
  | 'testEditMode'
  | 'testPlayMode';

export interface ScriptTemplateMeta {
  kind: ScriptTemplateKind;
  /** Human label shown in the modal's kind picker. */
  label: string;
  /** One-line description for the picker. */
  description: string;
  /**
   * True when the template needs a target type name (the `T` in
   * `[CustomEditor(typeof(T))]` / `[CustomPropertyDrawer(typeof(T))]`).
   */
  needsTargetType?: boolean;
  /** True for Editor-only templates (CustomEditor / EditorWindow / Drawer). */
  editorOnly?: boolean;
}

/** Ordered metadata for every template kind (drives the modal picker). */
export const SCRIPT_TEMPLATES: ScriptTemplateMeta[] = [
  {
    kind: 'monobehaviour',
    label: 'MonoBehaviour',
    description: 'Component script with Awake/Start/Update stubs',
  },
  {
    kind: 'scriptableobject',
    label: 'ScriptableObject',
    description: 'Data asset with [CreateAssetMenu]',
  },
  {
    kind: 'class',
    label: 'Class',
    description: 'Plain C# class',
  },
  {
    kind: 'interface',
    label: 'Interface',
    description: 'C# interface',
  },
  {
    kind: 'struct',
    label: 'Struct',
    description: 'C# value type',
  },
  {
    kind: 'editor',
    label: 'Custom Editor',
    description: 'Editor inspector for a target type',
    needsTargetType: true,
    editorOnly: true,
  },
  {
    kind: 'editorWindow',
    label: 'Editor Window',
    description: 'EditorWindow with a [MenuItem] entry',
    editorOnly: true,
  },
  {
    kind: 'propertyDrawer',
    label: 'Property Drawer',
    description: 'PropertyDrawer for a target type',
    needsTargetType: true,
    editorOnly: true,
  },
  {
    kind: 'testEditMode',
    label: 'Test (Edit Mode)',
    description: 'NUnit [Test] fixture',
  },
  {
    kind: 'testPlayMode',
    label: 'Test (Play Mode)',
    description: '[UnityTest] coroutine fixture',
  },
];

const INDENT = '    ';

/**
 * Wrap a body in a `namespace { … }` block (4-space indent) when `namespace`
 * is a non-empty string, otherwise return the body unchanged. `bodyLines` are
 * expected to be unindented relative to the namespace; we indent each non-empty
 * line by one level when wrapping.
 */
function wrap(namespace: string | undefined, bodyLines: string[]): string {
  const ns = namespace?.trim();
  if (!ns) {
    return bodyLines.join('\n') + '\n';
  }
  const indented = bodyLines.map((line) => (line.length > 0 ? INDENT + line : line));
  return [`namespace ${ns}`, '{', ...indented, '}', ''].join('\n');
}

function monoBehaviour(className: string, namespace?: string): string {
  return wrap(namespace, [
    'using UnityEngine;',
    '',
    `public class ${className} : MonoBehaviour`,
    '{',
    `${INDENT}private void Awake()`,
    `${INDENT}{`,
    `${INDENT}}`,
    '',
    `${INDENT}private void Start()`,
    `${INDENT}{`,
    `${INDENT}}`,
    '',
    `${INDENT}private void Update()`,
    `${INDENT}{`,
    `${INDENT}}`,
    '}',
  ]);
}

function scriptableObject(className: string, namespace?: string): string {
  return wrap(namespace, [
    'using UnityEngine;',
    '',
    `[CreateAssetMenu(fileName = "${className}", menuName = "ScriptableObjects/${className}")]`,
    `public class ${className} : ScriptableObject`,
    '{',
    `${INDENT}`,
    '}',
  ]);
}

function plainClass(className: string, namespace?: string): string {
  return wrap(namespace, [
    `public class ${className}`,
    '{',
    `${INDENT}`,
    '}',
  ]);
}

function interfaceTemplate(className: string, namespace?: string): string {
  return wrap(namespace, [
    `public interface ${className}`,
    '{',
    `${INDENT}`,
    '}',
  ]);
}

function structTemplate(className: string, namespace?: string): string {
  return wrap(namespace, [
    `public struct ${className}`,
    '{',
    `${INDENT}`,
    '}',
  ]);
}

function customEditor(className: string, namespace: string | undefined, targetType: string): string {
  const target = targetType.trim() || 'MonoBehaviour';
  return wrap(namespace, [
    'using UnityEditor;',
    '',
    `[CustomEditor(typeof(${target}))]`,
    `public class ${className} : Editor`,
    '{',
    `${INDENT}public override void OnInspectorGUI()`,
    `${INDENT}{`,
    `${INDENT}${INDENT}DrawDefaultInspector();`,
    `${INDENT}}`,
    '}',
  ]);
}

function editorWindow(className: string, namespace?: string): string {
  return wrap(namespace, [
    'using UnityEditor;',
    'using UnityEngine;',
    '',
    `public class ${className} : EditorWindow`,
    '{',
    `${INDENT}[MenuItem("Window/${className}")]`,
    `${INDENT}public static void ShowWindow()`,
    `${INDENT}{`,
    `${INDENT}${INDENT}GetWindow<${className}>("${className}");`,
    `${INDENT}}`,
    '',
    `${INDENT}private void OnGUI()`,
    `${INDENT}{`,
    `${INDENT}}`,
    '}',
  ]);
}

function propertyDrawer(className: string, namespace: string | undefined, targetType: string): string {
  const target = targetType.trim() || 'PropertyAttribute';
  return wrap(namespace, [
    'using UnityEditor;',
    'using UnityEngine;',
    '',
    `[CustomPropertyDrawer(typeof(${target}))]`,
    `public class ${className} : PropertyDrawer`,
    '{',
    `${INDENT}public override void OnGUI(Rect position, SerializedProperty property, GUIContent label)`,
    `${INDENT}{`,
    `${INDENT}${INDENT}EditorGUI.PropertyField(position, property, label, true);`,
    `${INDENT}}`,
    '}',
  ]);
}

function testEditMode(className: string, namespace?: string): string {
  return wrap(namespace, [
    'using NUnit.Framework;',
    '',
    `public class ${className}`,
    '{',
    `${INDENT}[Test]`,
    `${INDENT}public void ${className}_SimplePasses()`,
    `${INDENT}{`,
    `${INDENT}${INDENT}Assert.Pass();`,
    `${INDENT}}`,
    '}',
  ]);
}

function testPlayMode(className: string, namespace?: string): string {
  return wrap(namespace, [
    'using System.Collections;',
    'using NUnit.Framework;',
    'using UnityEngine;',
    'using UnityEngine.TestTools;',
    '',
    `public class ${className}`,
    '{',
    `${INDENT}[UnityTest]`,
    `${INDENT}public IEnumerator ${className}_WithEnumeratorPasses()`,
    `${INDENT}{`,
    `${INDENT}${INDENT}yield return null;`,
    `${INDENT}}`,
    '}',
  ]);
}

export interface TemplateOptions {
  /** Required for `editor` and `propertyDrawer` kinds. */
  targetType?: string;
}

/**
 * Generate file contents for `kind`. The produced type is named `className`
 * (must equal the file stem). `namespace` wraps the body when non-empty.
 */
export function renderTemplate(
  kind: ScriptTemplateKind,
  className: string,
  namespace?: string,
  options?: TemplateOptions,
): string {
  switch (kind) {
    case 'monobehaviour':
      return monoBehaviour(className, namespace);
    case 'scriptableobject':
      return scriptableObject(className, namespace);
    case 'class':
      return plainClass(className, namespace);
    case 'interface':
      return interfaceTemplate(className, namespace);
    case 'struct':
      return structTemplate(className, namespace);
    case 'editor':
      return customEditor(className, namespace, options?.targetType ?? '');
    case 'editorWindow':
      return editorWindow(className, namespace);
    case 'propertyDrawer':
      return propertyDrawer(className, namespace, options?.targetType ?? '');
    case 'testEditMode':
      return testEditMode(className, namespace);
    case 'testPlayMode':
      return testPlayMode(className, namespace);
    default: {
      // Exhaustiveness guard — a new kind without a branch is a compile error.
      const _never: never = kind;
      return _never;
    }
  }
}

const CSHARP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// C# reserved keywords that can't be used as a bare type name.
const CSHARP_KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
  'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate',
  'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false',
  'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit',
  'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace',
  'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private',
  'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed',
  'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked',
  'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
]);

/**
 * Validate a proposed type/file name. Returns an error string, or null when the
 * name is a legal C# identifier (and thus a legal Unity script file stem).
 */
export function validateClassName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Name is required';
  if (!CSHARP_IDENTIFIER.test(trimmed)) {
    return 'Must be a valid C# identifier (letters, digits, underscore; no leading digit)';
  }
  if (CSHARP_KEYWORDS.has(trimmed)) return `"${trimmed}" is a reserved C# keyword`;
  return null;
}

/**
 * Best-effort PascalCase suggestion from arbitrary text — splits on
 * non-alphanumerics and camelCase boundaries, upper-cases each word's first
 * letter, then prefixes an underscore if the result starts with a digit.
 */
export function suggestPascalCase(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let result = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  if (result && /^[0-9]/.test(result)) result = '_' + result;
  return result;
}
