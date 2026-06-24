// ── Unity domain knowledge shared by the analyzer rules ──────────────────────
//
// The canonical message NAME set comes from the csharp feature's lifecycle DB
// (imported via its barrel by the rules that need it). This module adds the
// extra knowledge the DB does not carry: the expected PARAMETER TYPES for the
// messages that take parameters, the set of Unity base classes that receive
// messages, and the set of UnityEngine.Object-derived types used by the
// correctness rules. None of this needs csharp-ls.

/** Base classes whose subclasses receive Unity lifecycle messages. */
export const UNITY_MESSAGE_BASE_TYPES = new Set<string>([
  'MonoBehaviour',
  'ScriptableObject',
  'StateMachineBehaviour',
  'Editor',
  'EditorWindow',
  'PropertyDrawer',
  'ScriptableWizard',
  'AssetPostprocessor',
]);

/**
 * Expected parameter type lists for the Unity messages that take parameters.
 * Keyed by exact message name. Only the messages with a well-known signature
 * are listed — messages absent here are treated as "any/zero params" and are
 * never flagged for parameter mismatch. Where a message is overloaded we list
 * the canonical single signature Unity documents.
 */
export const MESSAGE_PARAM_TYPES: Record<string, string[]> = {
  // 3D physics
  OnCollisionEnter: ['Collision'],
  OnCollisionStay: ['Collision'],
  OnCollisionExit: ['Collision'],
  OnTriggerEnter: ['Collider'],
  OnTriggerStay: ['Collider'],
  OnTriggerExit: ['Collider'],
  OnControllerColliderHit: ['ControllerColliderHit'],
  OnParticleCollision: ['GameObject'],
  OnJointBreak: ['float'],

  // 2D physics
  OnCollisionEnter2D: ['Collision2D'],
  OnCollisionStay2D: ['Collision2D'],
  OnCollisionExit2D: ['Collision2D'],
  OnTriggerEnter2D: ['Collider2D'],
  OnTriggerStay2D: ['Collider2D'],
  OnTriggerExit2D: ['Collider2D'],

  // Rendering / app
  OnRenderImage: ['RenderTexture', 'RenderTexture'],
  OnApplicationPause: ['bool'],
  OnApplicationFocus: ['bool'],
  OnAnimatorIK: ['int'],

  // Audio
  OnAudioFilterRead: ['float[]', 'int'],
};

/** Messages that take ZERO parameters (used to flag accidental params). */
export const ZERO_PARAM_MESSAGES = new Set<string>([
  'Awake', 'Start', 'OnEnable', 'OnDisable', 'OnDestroy', 'Reset',
  'Update', 'LateUpdate', 'FixedUpdate', 'OnGUI', 'OnValidate',
  'OnBecameVisible', 'OnBecameInvisible', 'OnPreCull', 'OnPreRender',
  'OnPostRender', 'OnRenderObject', 'OnWillRenderObject',
  'OnDrawGizmos', 'OnDrawGizmosSelected', 'OnApplicationQuit',
  'OnAnimatorMove', 'OnMouseDown', 'OnMouseUp', 'OnMouseDrag',
  'OnMouseEnter', 'OnMouseExit', 'OnMouseOver', 'OnMouseUpAsButton',
  'OnServerInitialized', 'OnConnectedToServer',
]);

/** The Update-family messages performance rules scope themselves to. */
export const UPDATE_FAMILY = new Set<string>([
  'Update',
  'FixedUpdate',
  'LateUpdate',
  'OnGUI',
]);

/**
 * UnityEngine.Object-derived types whose `== null` is overloaded by Unity (so
 * `?.`/`??` bypass the "fake null" lifetime check). Conservative allow-list —
 * the null-propagation rule only fires when the receiver is declared as one of
 * these (or is a GetComponent result).
 */
export const UNITY_OBJECT_TYPES = new Set<string>([
  'GameObject', 'Transform', 'RectTransform', 'Component', 'Behaviour',
  'MonoBehaviour', 'ScriptableObject',
  'Rigidbody', 'Rigidbody2D', 'Collider', 'Collider2D', 'BoxCollider',
  'SphereCollider', 'CapsuleCollider', 'MeshCollider', 'CharacterController',
  'Renderer', 'MeshRenderer', 'SkinnedMeshRenderer', 'SpriteRenderer',
  'LineRenderer', 'TrailRenderer', 'MeshFilter',
  'Camera', 'Light', 'Animator', 'Animation', 'AudioSource', 'AudioListener',
  'Canvas', 'CanvasGroup', 'Material', 'Texture', 'Texture2D', 'Sprite',
  'Mesh', 'Shader', 'GameObject',
  'NavMeshAgent', 'ParticleSystem', 'Joint', 'ConfigurableJoint',
  'Image', 'RawImage', 'Text', 'Button', 'Toggle', 'Slider', 'ScrollRect',
]);

/**
 * Reference-type names that are common to `new` inside Update bodies. Used by
 * the allocation rule as a heuristic (struct/value types are NOT allocations).
 */
export const COMMON_REFERENCE_TYPES = new Set<string>([
  'List', 'Dictionary', 'HashSet', 'Queue', 'Stack', 'StringBuilder',
  'string', 'String', 'object', 'Object', 'Array', 'Texture2D', 'Material',
  'GameObject', 'Mesh', 'Exception',
]);

/** Value/struct types Unity CAN serialize — never flagged by serialization. */
export const UNITY_SERIALIZABLE_STRUCTS = new Set<string>([
  'Vector2', 'Vector3', 'Vector4', 'Vector2Int', 'Vector3Int',
  'Quaternion', 'Color', 'Color32', 'Rect', 'RectInt', 'Bounds', 'BoundsInt',
  'Matrix4x4', 'LayerMask', 'AnimationCurve', 'Gradient',
  'int', 'float', 'double', 'bool', 'long', 'short', 'byte', 'char',
  'string', 'uint', 'ulong', 'ushort', 'sbyte', 'decimal',
]);

/**
 * Strip generic args and array/nullable suffixes from a type token, returning
 * the bare type name (`List<int>[]` → `List`, `Collider?` → `Collider`).
 */
export function bareTypeName(type: string): string {
  let t = type.trim();
  const angle = t.indexOf('<');
  if (angle >= 0) t = t.slice(0, angle);
  t = t.replace(/\[\s*\]/g, '').replace(/\?+$/, '').trim();
  // Keep only the leaf of a dotted name (UnityEngine.Vector3 → Vector3).
  const parts = t.split('.');
  return parts[parts.length - 1] ?? t;
}
