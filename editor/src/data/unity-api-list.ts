/**
 * Unity API list — name + Unity Scripting Reference URL + category.
 *
 * This is the source for the @-mention popover's "Unity Docs" section.
 * No documentation bodies are shipped — only the API names and links to
 * docs.unity3d.com. The AI is expected to know these APIs from training;
 * the URL is preserved for the user to click through.
 *
 * Seeded by mapping the existing UNITY_API_NAMES (LSP fallback completions)
 * with URL patterns derived from kind:
 *   - type:     ScriptReference/<Name>.html
 *   - method:   ScriptReference/<Owner>.<Name>.html
 *   - property: ScriptReference/<Owner>-<Name>.html
 *
 * A handful of entries don't follow the pattern (attributes etc.) and are
 * overridden in URL_OVERRIDES below.
 */

import { UNITY_API_NAMES, type UnityApiName } from './unity-api-names';

export interface UnityApiEntry {
  /** Display name in the popover (e.g. "Rigidbody.AddForce", "Transform"). */
  name: string;
  /** Full URL to the Unity Scripting Reference page. */
  url: string;
  /** Coarse category for grouping (e.g. "Physics", "Math", "Lifecycle"). */
  category: string;
}

const SCRIPT_REF = 'https://docs.unity3d.com/ScriptReference';

/** Hand-overrides where the auto-generated URL pattern doesn't apply. */
const URL_OVERRIDES: Record<string, string> = {
  SerializeField: `${SCRIPT_REF}/SerializeField.html`,
  HideInInspector: `${SCRIPT_REF}/HideInInspector.html`,
  Range: `${SCRIPT_REF}/RangeAttribute.html`,
  Header: `${SCRIPT_REF}/HeaderAttribute.html`,
  Tooltip: `${SCRIPT_REF}/TooltipAttribute.html`,
  KeyCode: `${SCRIPT_REF}/KeyCode.html`,
};

/** Map an LSP entry's `detail` (which holds the owner type or namespace) to a
 *  human-readable category for grouping in the popover. */
function categoryFor(entry: UnityApiName): string {
  const owner = entry.detail ?? '';

  // Lifecycle method names get a dedicated category
  const LIFECYCLE = new Set([
    'Awake',
    'Start',
    'Update',
    'FixedUpdate',
    'LateUpdate',
    'OnEnable',
    'OnDisable',
    'OnDestroy',
    'OnCollisionEnter',
    'OnCollisionExit',
    'OnCollisionStay',
    'OnTriggerEnter',
    'OnTriggerExit',
    'OnTriggerStay',
    'OnMouseDown',
    'OnMouseUp',
  ]);
  if (LIFECYCLE.has(entry.name)) return 'Lifecycle';

  if (owner === 'UnityEngine.SceneManagement') return 'Scenes';
  if (owner.startsWith('UnityEngine')) {
    // Type entries: classify by name
    const PHYSICS = new Set([
      'Rigidbody',
      'Rigidbody2D',
      'Collider',
      'Collider2D',
      'BoxCollider',
      'SphereCollider',
      'CapsuleCollider',
      'MeshCollider',
      'CharacterController',
      'Physics',
      'Physics2D',
      'Ray',
      'RaycastHit',
      'Bounds',
    ]);
    const MATH = new Set([
      'Vector2',
      'Vector3',
      'Vector4',
      'Quaternion',
      'Matrix4x4',
      'Color',
      'Color32',
      'Rect',
      'Mathf',
      'Random',
    ]);
    const RENDERING = new Set([
      'Camera',
      'Light',
      'Material',
      'Shader',
      'Texture',
      'Texture2D',
      'Sprite',
      'SpriteRenderer',
      'MeshRenderer',
      'MeshFilter',
    ]);
    const AUDIO = new Set(['AudioSource', 'AudioClip', 'AudioListener']);
    const ANIMATION = new Set(['Animator', 'Animation']);
    const COROUTINE = new Set([
      'Coroutine',
      'WaitForSeconds',
      'WaitForEndOfFrame',
      'WaitForFixedUpdate',
    ]);
    const CORE = new Set([
      'MonoBehaviour',
      'ScriptableObject',
      'GameObject',
      'Transform',
      'RectTransform',
      'Component',
    ]);
    const INPUT = new Set(['Input', 'KeyCode']);
    const SYSTEM = new Set([
      'Time',
      'Application',
      'Resources',
      'PlayerPrefs',
      'Screen',
      'Cursor',
      'Debug',
      'LayerMask',
    ]);
    const ATTRIBUTES = new Set([
      'SerializeField',
      'HideInInspector',
      'Range',
      'Header',
      'Tooltip',
    ]);

    if (CORE.has(entry.name)) return 'Core';
    if (PHYSICS.has(entry.name)) return 'Physics';
    if (MATH.has(entry.name)) return 'Math';
    if (RENDERING.has(entry.name)) return 'Rendering';
    if (AUDIO.has(entry.name)) return 'Audio';
    if (ANIMATION.has(entry.name)) return 'Animation';
    if (COROUTINE.has(entry.name)) return 'Coroutines';
    if (INPUT.has(entry.name)) return 'Input';
    if (SYSTEM.has(entry.name)) return 'System';
    if (ATTRIBUTES.has(entry.name)) return 'Attributes';
  }

  // Member entries: classify by owner type
  switch (owner) {
    case 'Transform':
    case 'Component':
    case 'GameObject':
    case 'Object':
    case 'Behaviour':
      return 'Core';
    case 'MonoBehaviour':
      return 'Lifecycle';
    case 'Time':
      return 'System';
    case 'Input':
      return 'Input';
    case 'Mathf':
    case 'Quaternion':
      return 'Math';
    case 'Debug':
      return 'System';
    default:
      return 'Other';
  }
}

function urlFor(entry: UnityApiName): string {
  if (URL_OVERRIDES[entry.name]) return URL_OVERRIDES[entry.name];

  if (entry.kind === 'type') {
    return `${SCRIPT_REF}/${entry.name}.html`;
  }

  const owner = entry.detail ?? '';
  if (!owner || owner.startsWith('UnityEngine')) {
    // Member with no owner type — fall back to its own page
    return `${SCRIPT_REF}/${entry.name}.html`;
  }

  if (entry.kind === 'property') {
    return `${SCRIPT_REF}/${owner}-${entry.name}.html`;
  }
  return `${SCRIPT_REF}/${owner}.${entry.name}.html`;
}

function displayName(entry: UnityApiName): string {
  if (entry.kind === 'type') return entry.name;
  const owner = entry.detail ?? '';
  if (!owner || owner.startsWith('UnityEngine')) return entry.name;
  return `${owner}.${entry.name}`;
}

export const UNITY_API_LIST: UnityApiEntry[] = UNITY_API_NAMES.map((entry) => ({
  name: displayName(entry),
  url: urlFor(entry),
  category: categoryFor(entry),
}));

/** Stable order: Core types first, then alphabetical within category. */
const CATEGORY_ORDER = [
  'Core',
  'Lifecycle',
  'Physics',
  'Math',
  'Rendering',
  'Animation',
  'Audio',
  'Input',
  'Coroutines',
  'Scenes',
  'System',
  'Attributes',
  'Other',
];

UNITY_API_LIST.sort((a, b) => {
  const ai = CATEGORY_ORDER.indexOf(a.category);
  const bi = CATEGORY_ORDER.indexOf(b.category);
  if (ai !== bi) return ai - bi;
  return a.name.localeCompare(b.name);
});

/** Top entries shown by default when the popover opens with empty query. */
export const UNITY_API_DEFAULTS: UnityApiEntry[] = [
  'MonoBehaviour',
  'GameObject',
  'Transform',
  'Vector3',
  'Rigidbody.AddForce',
  'Input.GetAxis',
  'Time.deltaTime',
  'Coroutine',
]
  .map((name) => UNITY_API_LIST.find((e) => e.name === name))
  .filter((e): e is UnityApiEntry => e !== undefined);
