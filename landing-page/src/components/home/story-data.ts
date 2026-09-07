/**
 * Content for the landing page's animated chapters.
 *
 * Kept out of the components because it is copy, not markup: every string here
 * is a claim about the product, and they should be readable and editable in one
 * place rather than buried in three hundred lines of JSX. Nothing in this file
 * is decorative — the analyzer ids, the Unity version, the tool names and the
 * check list are all things the app actually emits.
 */

/** Colours, as the syntax layer paints them. Mirrors `landing.css`. */
export const C = {
  text: '#e8e6e1',
  dim: '#b4b8c0',
  mute: '#8a8f98',
  faint: '#6f747d',
  ghost: '#4a515c',
  blue: '#7cb7ff',
  green: '#6fe3a5',
  gold: '#f5c26b',
  red: '#ff6f6f',
  violet: '#c792ea',
} as const;

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** Progress of `p` through the window [a, b], clamped to 0..1. */
export const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a), 0, 1);
/** Cubic ease-out. Everything on this page decelerates; nothing accelerates. */
export const eo = (x: number) => 1 - Math.pow(1 - x, 3);

/* ── Hero editor ─────────────────────────────────────────────────────────── */

export type CodeSpan = [text: string, color: string];
export interface CodeLine {
  tag: string;
  spans: CodeSpan[];
}

const KW = C.violet, TY = C.blue, ID = C.dim, FN = C.gold;

/** The visible body of PlayerController.cs, above the line being typed. */
export const HERO_CODE: CodeLine[] = [
  { tag: '', spans: [['using ', KW], ['UnityEngine', ID], [';', ID]] },
  { tag: '', spans: [['using ', KW], ['UnityEngine.InputSystem', ID], [';', ID]] },
  { tag: '', spans: [] },
  { tag: '', spans: [['public class ', KW], ['PlayerController', TY], [' : MonoBehaviour', ID]] },
  { tag: '', spans: [['{', ID]] },
  { tag: '', spans: [['    [', ID], ['SerializeField', TY], ['] float speed = 5.5f;', ID]] },
  { tag: '', spans: [['    ', ID], ['Rigidbody', TY], [' rb;', ID]] },
  { tag: '', spans: [] },
  { tag: 'lifecycle', spans: [['    void ', KW], ['Awake', FN], ['()', ID]] },
  { tag: '', spans: [['    {', ID]] },
  { tag: '', spans: [['        rb = ', ID], ['GetComponent', FN], ['<Rigidbody>();', ID]] },
  { tag: '', spans: [['    }', ID]] },
  { tag: '', spans: [] },
  { tag: 'lifecycle', spans: [['    void ', KW], ['Update', FN], ['()', ID]] },
  { tag: '', spans: [['    {', ID]] },
  { tag: '', spans: [['        var move = ', ID], ['moveAction', ID], ['.ReadValue<Vector2>();', ID]] },
];

/** What the developer types, and what the quick fix replaces it with. */
export const TYPED_LINE = 'GetComponent<Rigidbody>().AddForce(move);';
export const FIXED_LINE = 'rb.AddForce(move);';

/* ── 01 · Setup ──────────────────────────────────────────────────────────── */

export const SETUP: Array<[title: string, sub: string]> = [
  ['Download UnityIDE', 'Windows .exe · macOS .dmg · free'],
  ['Add the Unity package', 'Package Manager → Add package from tarball'],
  ['Open your project', 'Language server, analyzers and debugger are already there'],
];

/* ── 03 · ScriptableObjects ──────────────────────────────────────────────── */

export const DRIFT: Array<[asset: string, damage: number]> = [
  ['Sword.asset', 45],
  ['Bow.asset', 30],
  ['Staff.asset', 60],
];

/* ── 04 · Hierarchy ──────────────────────────────────────────────────────── */

export interface TreeNode {
  name: string;
  comps: string[];
  indent: number;
}

export const TREE: TreeNode[] = [
  { name: 'Player', comps: ['Transform', 'Rigidbody'], indent: 0 },
  { name: 'Model', comps: ['MeshRenderer'], indent: 22 },
  { name: 'Camera Rig', comps: ['Transform'], indent: 22 },
  { name: 'Main Camera', comps: ['Camera'], indent: 44 },
  { name: 'Weapon Socket', comps: ['Transform'], indent: 22 },
  { name: 'Pistol', comps: ['WeaponBehaviour'], indent: 44 },
];

/** The same prefab, as Unity serialises it. Truncated at the point the reader
 *  has already got the idea. */
export const YAML = `--- !u!1 &6438273645192837465
GameObject:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_Component:
  - component: {fileID: 6438273645192837466}
  - component: {fileID: 6438273645192837467}
  m_Layer: 0
  m_Name: Player
  m_TagString: Player
  m_IsActive: 1
--- !u!4 &6438273645192837466
Transform:
  m_GameObject: {fileID: 6438273645192837465}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 1, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children:
  - {fileID: 8812094471029384756}
  - {fileID: 1120384756019283746}
  m_Father: {fileID: 0}
--- !u!54 &6438273645192837467
Rigidbody:
  m_GameObject: {fileID: 6438273645192837465}
  serializedVersion: 4
  m_Mass: 1
  m_Drag: 0
  m_UseGravity: 1`.split('\n');

/* ── 05 · AI copilot ─────────────────────────────────────────────────────── */

export const TOOLS = [
  'get_scene_hierarchy',
  'unity_set_property Enemy.LootTable',
  'unity_run_tests',
];

/** The last row is the point of the whole panel: a check that did not run is
 *  reported as not run, never folded into the passing count. */
export const CHECKS: Array<[name: string, detail: string, status: string, color: string]> = [
  ['compile', 'Unity 6000.3 — 0 errors', 'passed', C.green],
  ['analyzers', '31 Unity rules — 0 findings', 'passed', C.green],
  ['GUID integrity', '14 references intact', 'passed', C.green],
  ['ScriptableObjects', 'no drift against the class', 'passed', C.green],
  ['input', 'every action name resolves', 'passed', C.green],
  ['tests', '3 / 3 passed', 'passed', C.green],
  // The status column already says "not verified"; repeating it in the detail
  // only pushed the row into an ellipsis.
  ['Unity console', 'Editor not running', 'not verified', C.mute],
];

/* ── Horizontal band ─────────────────────────────────────────────────────── */

export const LOGS: Array<[level: string, color: string, msg: string, src: string]> = [
  ['LOG', C.mute, 'Player spawned at (0, 1, 0)', 'PlayerController.cs:18'],
  ['LOG', C.mute, 'Loaded 3 input maps, 11 actions', 'InputBootstrap.cs:9'],
  ['WARN', C.gold, 'NavMesh not baked for SampleScene', 'EnemySpawner.cs:41'],
  ['ERR', C.red, 'NullReferenceException', 'EnemyAI.cs:34'],
];

export const INPUTS: Array<[map: string, action: string, binding: string, conflict: boolean]> = [
  ['Player', 'Move', 'WASD · Left Stick', false],
  ['Player', 'Jump', '<Keyboard>/space · Button South', true],
  ['UI', 'Navigate', 'Arrows · D-Pad', false],
  ['UI', 'Submit', '<Keyboard>/space · Button South', true],
];

/** A frame's worth of profiler samples. Shaped, not random, so the spike lands
 *  in the same place every render and the caption can point at it. */
export const BARS = Array.from({ length: 28 }, (_, i) => {
  const v = 30 + Math.abs(Math.sin(i * 1.7) * 35) + (i % 7 === 3 ? 30 : 0);
  return { h: Math.min(100, v), color: v > 80 ? C.red : v > 60 ? C.gold : '#2f5a8f' };
});

export const AGENTS: Array<{
  name: string;
  sub: string;
  glyph: string;
  color: string;
  badge: string;
  badgeBorder: string;
  badgeColor: string;
}> = [
  {
    name: 'Claude Code',
    sub: 'Anthropic · Pro / Max subscription',
    glyph: 'C',
    color: C.gold,
    badge: 'Supported',
    badgeBorder: '#1f3a2c',
    badgeColor: C.green,
  },
  {
    name: 'Codex',
    sub: 'OpenAI · ChatGPT subscription',
    glyph: 'X',
    color: C.mute,
    badge: 'Coming soon',
    badgeBorder: '#2a2f37',
    badgeColor: C.mute,
  },
  {
    name: 'Any ACP agent',
    sub: 'Agent Client Protocol',
    glyph: '⋯',
    color: C.blue,
    badge: 'Supported',
    badgeBorder: '#1f3a2c',
    badgeColor: C.green,
  },
];
