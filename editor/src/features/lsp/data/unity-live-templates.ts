/**
 * Unity live templates — the abbreviations Rider ships in its Unity plugin.
 *
 * `sfield` and `sprop` are the two every Unity developer types dozens of times
 * a day: a serialized private field, and a serialized private field with a
 * public read-only accessor. Typing either by hand is 3–5 lines of boilerplate
 * whose only interesting part is the type and the name.
 *
 * Bodies are Monaco snippet syntax — `${1:type}` are tab stops, `$0` is the
 * final caret. Kept as data (not code) for the same reason
 * `unity-lifecycle-snippets.ts` is: the list grows, the registration does not.
 */

export interface UnityLiveTemplate {
  /** The abbreviation the user types. */
  name: string;
  detail: string;
  documentation: string;
  body: string;
}

export const UNITY_LIVE_TEMPLATES: UnityLiveTemplate[] = [
  {
    name: 'sfield',
    detail: 'Serialized field',
    documentation:
      'A private field exposed to the Inspector. `[SerializeField]` on a private field is preferred over a public field: it serializes without widening the API.',
    body: '[SerializeField] private ${1:GameObject} ${2:field};$0',
  },
  {
    name: 'sprop',
    detail: 'Serialized field with a public accessor',
    documentation:
      'A serialized private backing field plus a read-only property, so the value is Inspector-editable but not externally writable.',
    body:
      '[SerializeField] private ${1:GameObject} ${2:field};\n' +
      'public ${1:GameObject} ${3:Field} => ${2:field};$0',
  },
  {
    name: 'srange',
    detail: 'Serialized field with a Range slider',
    documentation: 'A serialized numeric field constrained to a slider in the Inspector.',
    body: '[SerializeField, Range(${1:0f}, ${2:1f})] private float ${3:value};$0',
  },
  {
    name: 'reqcomp',
    detail: 'RequireComponent attribute',
    documentation:
      'Declares a component dependency so Unity adds it automatically and blocks its removal.',
    body: '[RequireComponent(typeof(${1:Rigidbody}))]$0',
  },
  {
    name: 'coroutine',
    detail: 'Coroutine method',
    documentation: 'An IEnumerator method suitable for StartCoroutine.',
    body:
      'private IEnumerator ${1:Routine}()\n{\n    yield return new WaitForSeconds(${2:1f});\n    $0\n}',
  },
  {
    name: 'createasset',
    detail: 'CreateAssetMenu ScriptableObject',
    documentation: 'Marks a ScriptableObject so it can be created from the Assets menu.',
    body: '[CreateAssetMenu(fileName = "${1:Data}", menuName = "${2:Game/Data}")]$0',
  },
];
