/**
 * The ScriptableObject and UI Toolkit halves of the Unity facts block, and the
 * rule that decides how much of any subsystem to spend prompt on.
 *
 * **Why this is adaptive rather than always-on.** The facts block is frozen per
 * conversation (`frozen-context.ts`) and therefore re-sent on every turn of it,
 * so anything here is paid for repeatedly. Naming every ScriptableObject type,
 * every UXML element and every action in one block would be the largest thing
 * in the prompt for a project of any size, and most of it would be irrelevant
 * to the conversation being had.
 *
 * So the block has two layers:
 *
 *   - a **one-line inventory** of every subsystem the project uses, always,
 *     because the model has to know a subsystem EXISTS before it can think to
 *     ask about it; and
 *   - **detail** only for the subsystem(s) the conversation opens on.
 *
 * Selection happens once, at freeze time, which is what keeps it compatible
 * with prefix caching: the prompt still never changes mid-conversation. When
 * the conversation later moves to a subsystem it did not open on, the tools
 * (`unity_scriptable_objects`, `unity_ui_toolkit`, `unity_input_actions`) are
 * the route, which is why the static prompt names them unconditionally.
 *
 * Pure and store-free, so it is directly testable under Bun — the same split,
 * and the same reason, as `input-facts.ts` next door.
 */

export type Subsystem = 'scriptableObjects' | 'uiToolkit' | 'input';

/** Character budget for names in the detail blocks, mirroring input's. */
export const SUBSYSTEM_NAME_BUDGET = 700;

// ── Selection ────────────────────────────────────────────────────────────────

/** Extension → the subsystem that file unambiguously belongs to. */
function subsystemForExtension(path: string): Subsystem | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.uxml') || lower.endsWith('.uss')) return 'uiToolkit';
  if (lower.endsWith('.asset')) return 'scriptableObjects';
  if (lower.endsWith('.inputactions')) return 'input';
  return null;
}

/**
 * Signals in C# source. Cheap substring tests, not parsing: this runs inside
 * the synchronous prompt builder, and a false positive costs one extra fact
 * line while a false negative costs a tool call.
 */
const CS_SIGNALS: Array<{ subsystem: Subsystem; needles: readonly string[] }> = [
  {
    subsystem: 'scriptableObjects',
    needles: [': ScriptableObject', ':ScriptableObject', 'CreateAssetMenu', 'ScriptableObject.CreateInstance'],
  },
  {
    subsystem: 'uiToolkit',
    needles: ['UnityEngine.UIElements', 'VisualElement', 'UIDocument', 'rootVisualElement', '.Q<', '.Q('],
  },
  {
    subsystem: 'input',
    needles: ['UnityEngine.InputSystem', 'InputAction', 'PlayerInput', 'Keyboard.current', 'Gamepad.current'],
  },
];

export interface SelectInput {
  /** The file the conversation opens on, or null. */
  activeFilePath: string | null;
  /** That file's already-open buffer. Never a fresh read — this is synchronous. */
  activeFileText: string | null;
  /** Which subsystems the project actually uses; absent ones are never selected. */
  present: Readonly<Record<Subsystem, boolean>>;
}

/**
 * Which subsystems this conversation should carry detail for.
 *
 * A file whose extension names a subsystem selects exactly that one. A `.cs`
 * file selects every subsystem it shows a signal for — a MonoBehaviour that
 * drives a UI Document from an input action is a real and common shape, and
 * picking one of the three would be arbitrary. Anything else selects none, and
 * the inventory line carries the conversation.
 */
export function selectSubsystems(input: SelectInput): Subsystem[] {
  const keep = (list: Subsystem[]) => list.filter((s) => input.present[s]);

  if (!input.activeFilePath) return [];

  const byExtension = subsystemForExtension(input.activeFilePath);
  if (byExtension) return keep([byExtension]);

  if (!input.activeFilePath.toLowerCase().endsWith('.cs') || !input.activeFileText) return [];

  const text = input.activeFileText;
  return keep(
    CS_SIGNALS.filter((s) => s.needles.some((n) => text.includes(n))).map((s) => s.subsystem),
  );
}

// ── Inventory ────────────────────────────────────────────────────────────────

export interface SubsystemInventory {
  scriptableObjects: { types: number; assets: number } | null;
  uiToolkit: { documents: number; stylesheets: number } | null;
  input: { assets: number; maps: number } | null;
}

export function presenceOf(inv: SubsystemInventory): Record<Subsystem, boolean> {
  return {
    scriptableObjects: inv.scriptableObjects !== null && inv.scriptableObjects.types > 0,
    uiToolkit: inv.uiToolkit !== null && inv.uiToolkit.documents > 0,
    input: inv.input !== null && inv.input.assets > 0,
  };
}

/**
 * One line naming every subsystem the project uses, with counts.
 *
 * Always emitted when anything is present. Its job is not to be sufficient —
 * it is to stop the model assuming a project has no ScriptableObjects because
 * the prompt happened not to mention any.
 */
export function subsystemInventoryLine(inv: SubsystemInventory): string | null {
  const parts: string[] = [];
  if (inv.scriptableObjects && inv.scriptableObjects.types > 0) {
    const { types, assets } = inv.scriptableObjects;
    parts.push(`ScriptableObjects (${types} type${types === 1 ? '' : 's'}, ${assets} asset${assets === 1 ? '' : 's'})`);
  }
  if (inv.uiToolkit && inv.uiToolkit.documents > 0) {
    const { documents, stylesheets } = inv.uiToolkit;
    parts.push(`UI Toolkit (${documents} .uxml, ${stylesheets} .uss)`);
  }
  if (inv.input && inv.input.assets > 0) {
    const { assets, maps } = inv.input;
    parts.push(`Input System (${assets} .inputactions, ${maps} map${maps === 1 ? '' : 's'})`);
  }
  if (parts.length === 0) return null;
  return `- Unity subsystems in use: ${parts.join(' · ')}`;
}

// ── Detail ───────────────────────────────────────────────────────────────────

/** Join names until the budget runs out, then say how many were dropped. */
function budgeted(names: readonly string[], budget = SUBSYSTEM_NAME_BUDGET): string {
  const shown: string[] = [];
  let used = 0;
  for (const name of names) {
    if (used + name.length > budget) break;
    used += name.length + 2;
    shown.push(name);
  }
  const more = names.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? `, …${more} more` : ''}`;
}

export interface ScriptableObjectFacts {
  /** Class names that have at least one asset, most-instanced first. */
  typeNames: string[];
}

export interface UiToolkitFacts {
  /** Workspace-relative `.uxml` paths. */
  documents: string[];
  /** Every `name` any document declares — what `Q<T>()` resolves against. */
  elementNames: string[];
}

/**
 * The ScriptableObject detail block.
 *
 * The warning is the point. Renaming a serialized field is a routine-looking
 * edit whose blast radius is invisible from the file being edited, and it is
 * the one Unity mistake that destroys data with no diagnostic anywhere.
 */
export function scriptableObjectFactLines(facts: ScriptableObjectFacts): string[] {
  if (facts.typeNames.length === 0) return [];
  return [
    `- ScriptableObject types with assets (${facts.typeNames.length}): ${budgeted(facts.typeNames)}`,
    '  Renaming or removing a serialized field on any of these silently reverts every tuned value in ' +
      'every asset to its default — no compiler error, no warning. Add [FormerlySerializedAs("oldName")] ' +
      'in the same edit, and call unity_scriptable_objects for the fields and current values.',
  ];
}

/**
 * The UI Toolkit detail block.
 *
 * Element names first, for the same reason input action names come first: they
 * are what stops a guessed string literal.
 */
export function uiToolkitFactLines(facts: UiToolkitFacts): string[] {
  if (facts.documents.length === 0) return [];
  const lines = [`- UI Toolkit documents (${facts.documents.length}): ${budgeted(facts.documents)}`];
  if (facts.elementNames.length > 0) {
    lines.push(`    Named elements (${facts.elementNames.length}): ${budgeted(facts.elementNames)}`);
    lines.push(
      '  Use these exact names in Q<T>() — a name no document declares compiles, returns null, and ' +
        'throws only when that screen first opens. Call unity_ui_toolkit for the element tree and USS classes.',
    );
  } else {
    lines.push(
      '    No element in any document has a `name`, so nothing is reachable from C# by name yet.',
    );
  }
  return lines;
}
