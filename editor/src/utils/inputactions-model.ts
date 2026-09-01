/**
 * Parse, inspect and edit Unity `.inputactions` assets.
 *
 * PURE — no Tauri, no stores, no Monaco. Everything here is a function of its
 * arguments so the analyzer rules, the editor UI and the tests can all share
 * one implementation.
 *
 * Lives in `utils/` rather than in `features/unity-input/` because BOTH that
 * feature and `features/unity-analyzers/` need it, and a shared folder is
 * importable by anyone (editor/CLAUDE.md). Reaching it through the unity-input
 * barrel instead would drag that barrel's React components into the analyzer
 * rules and their tests, where Bun's DOM-less runtime crashes on
 * `stores/theme.ts`'s module-scope `document` access -- and it keeps the two
 * features independent rather than mutually imported, the failure mode
 * editor/CLAUDE.md records as having broken app startup before.
 *
 * ## The round-trip contract
 *
 * `serializeInputActions(parseInputActions(text)) === text` for any file Unity
 * wrote. That is not a nicety: `.inputactions` is checked into git next to
 * scenes and prefabs, and an editor that reformats the whole asset on every
 * save turns a one-binding change into an unreviewable diff and a guaranteed
 * merge conflict. So the parser records the file's own indent width and
 * trailing-newline habit and the serializer replays them, and every field the
 * document carries — including ones this model has no opinion about — survives
 * via index signatures rather than being dropped on the floor.
 *
 * A malformed file yields `{ doc: null, error }` rather than throwing, because
 * the caller is usually a viewer rendering whatever the user just typed.
 */

// ── Document shape ───────────────────────────────────────────────────────────
// Index signatures are deliberate: Unity adds fields between versions, and an
// unknown field must round-trip untouched rather than be silently discarded.

export interface InputBinding {
  id: string;
  path: string;
  action: string;
  name?: string;
  interactions?: string;
  processors?: string;
  groups?: string;
  /** A composite PARENT (e.g. `2DVector`). Holds no control of its own. */
  isComposite?: boolean;
  /** A composite PART (e.g. the `up` of a WASD vector). Does hold a control. */
  isPartOfComposite?: boolean;
  [key: string]: unknown;
}

export interface InputAction {
  name: string;
  id: string;
  type?: string;
  expectedControlType?: string;
  interactions?: string;
  processors?: string;
  initialStateCheck?: boolean;
  [key: string]: unknown;
}

export interface InputActionMap {
  name: string;
  id: string;
  actions: InputAction[];
  bindings: InputBinding[];
  [key: string]: unknown;
}

export interface ControlScheme {
  name: string;
  bindingGroup?: string;
  devices?: Array<{ devicePath?: string; isOptional?: boolean; isOR?: boolean }>;
  [key: string]: unknown;
}

export interface InputActionsDocument {
  name?: string;
  maps: InputActionMap[];
  controlSchemes?: ControlScheme[];
  [key: string]: unknown;
}

/** How the file was formatted on disk, so a save can reproduce it exactly. */
export interface InputActionsFormat {
  indent: number;
  trailingNewline: boolean;
}

export interface ParsedInputActions {
  doc: InputActionsDocument | null;
  error: string | null;
  format: InputActionsFormat;
}

const DEFAULT_FORMAT: InputActionsFormat = { indent: 4, trailingNewline: true };

// ── Parse / serialize ────────────────────────────────────────────────────────

/** Width of the first indented line — the file's own convention, not ours. */
function detectIndent(text: string): number {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return DEFAULT_FORMAT.indent;
  return match[1].startsWith('\t') ? match[1].length : match[1].length;
}

export function parseInputActions(text: string): ParsedInputActions {
  const format: InputActionsFormat = {
    indent: detectIndent(text),
    trailingNewline: text.endsWith('\n'),
  };
  try {
    const doc = JSON.parse(text) as InputActionsDocument;
    // Unity always writes `maps`, but a hand-edited or truncated file may not;
    // normalising here keeps every consumer from re-checking.
    if (!Array.isArray(doc.maps)) doc.maps = [];
    return { doc, error: null, format };
  } catch (e) {
    return { doc: null, error: e instanceof Error ? e.message : String(e), format };
  }
}

export function serializeInputActions(parsed: ParsedInputActions): string {
  if (!parsed.doc) return '';
  const body = JSON.stringify(parsed.doc, null, parsed.format.indent);
  return parsed.format.trailingNewline ? `${body}\n` : body;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The name C# addresses an action by: `FindAction("Player/Jump")`. */
export function qualifiedActionName(mapName: string, actionName: string): string {
  return `${mapName}/${actionName}`;
}

export interface ResolvedAction {
  mapName: string;
  name: string;
  /** `Map/Action` — the form that appears in C# string literals. */
  qualifiedName: string;
  id: string;
  type?: string;
  expectedControlType?: string;
  interactions?: string;
  processors?: string;
  /** Real controls only; composite parents are excluded. */
  bindings: InputBinding[];
}

/** Every action across every map, flattened, each carrying its bindings. */
export function listActions(doc: InputActionsDocument): ResolvedAction[] {
  const out: ResolvedAction[] = [];
  for (const map of doc.maps ?? []) {
    for (const action of map.actions ?? []) {
      out.push({
        mapName: map.name,
        name: action.name,
        qualifiedName: qualifiedActionName(map.name, action.name),
        id: action.id,
        type: action.type,
        expectedControlType: action.expectedControlType,
        interactions: action.interactions,
        processors: action.processors,
        bindings: (map.bindings ?? []).filter(
          (b) => b.action === action.name && !b.isComposite,
        ),
      });
    }
  }
  return out;
}

export interface BindingConflict {
  mapName: string;
  path: string;
  /** Qualified action names, in the order their bindings are declared. */
  actions: string[];
  /** The action that actually receives the input. */
  winner: string;
  /** The actions that silently never fire. */
  starved: string[];
  bindingIds: string[];
}

/**
 * Two actions in the SAME map bound to the same control — the failure this
 * whole feature exists to surface, because Unity reports nothing and the
 * losing action simply never fires.
 *
 * Scoped per map on purpose: maps are enabled independently, so the same
 * control appearing in `Player` and `UI` is the normal way to build a pause
 * menu, not a bug. Composite PARENTS are skipped (`2DVector` is a grouping
 * node, not a control); composite PARTS are not, because `<Keyboard>/w` bound
 * twice really is a conflict.
 */
export function findBindingConflicts(doc: InputActionsDocument): BindingConflict[] {
  const conflicts: BindingConflict[] = [];

  for (const map of doc.maps ?? []) {
    const byPath = new Map<string, InputBinding[]>();
    for (const binding of map.bindings ?? []) {
      if (binding.isComposite) continue;
      if (!binding.path) continue;
      const list = byPath.get(binding.path);
      if (list) list.push(binding);
      else byPath.set(binding.path, [binding]);
    }

    for (const [path, bindings] of byPath) {
      // Distinct actions, in binding-declaration order — that order is what
      // decides which one wins at runtime.
      const actions: string[] = [];
      for (const b of bindings) {
        const qualified = qualifiedActionName(map.name, b.action);
        if (!actions.includes(qualified)) actions.push(qualified);
      }
      if (actions.length < 2) continue;

      conflicts.push({
        mapName: map.name,
        path,
        actions,
        winner: actions[0],
        starved: actions.slice(1),
        bindingIds: bindings.map((b) => b.id),
      });
    }
  }

  return conflicts;
}

// ── Editing ──────────────────────────────────────────────────────────────────

/** Structural clone that preserves key insertion order, which the round-trip needs. */
function cloneDoc(doc: InputActionsDocument): InputActionsDocument {
  return JSON.parse(JSON.stringify(doc)) as InputActionsDocument;
}

/**
 * Point one binding at a different control, leaving every other byte alone.
 *
 * Addressed by binding id rather than by index or path: the id is the stable
 * handle Unity itself uses, and preserving it is what stops prefabs and saved
 * rebinding overrides from losing their reference. An unknown id is a no-op,
 * not an error — the caller is often reacting to a stale UI row.
 */
export function setBindingPath(
  parsed: ParsedInputActions,
  bindingId: string,
  path: string,
): ParsedInputActions {
  if (!parsed.doc) return parsed;
  const doc = cloneDoc(parsed.doc);
  for (const map of doc.maps ?? []) {
    for (const binding of map.bindings ?? []) {
      if (binding.id === bindingId) {
        binding.path = path;
        return { ...parsed, doc };
      }
    }
  }
  return { ...parsed, doc };
}
