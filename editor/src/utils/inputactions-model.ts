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
  /**
   * Bindings as a TREE, not a flat list: a composite is one node holding its
   * parts. Unity stores `WASD` as a parent plus eight part rows, and rendering
   * those parts as eight peers of `<Gamepad>/leftStick` is both wrong and
   * unreadable -- it is one binding the user configured, not eight.
   */
  bindings: BindingNode[];
}

/** One binding as the user thinks of it: a control, or a composite of controls. */
export interface BindingNode {
  /** The composite parent, or the standalone binding itself. */
  binding: InputBinding;
  /** Composite parts, in declaration order. Empty for a standalone binding. */
  parts: InputBinding[];
  isComposite: boolean;
  /** What to show: the composite's name (`WASD`) or the control path. */
  label: string;
  /** Control schemes this node belongs to; empty means "every scheme". */
  schemes: string[];
  /** Device families touched, e.g. `['Keyboard']` or `['Gamepad']`. */
  devices: string[];
}

/**
 * `groups` is a semicolon-separated scheme list, and Unity frequently writes a
 * leading separator (`";Gamepad"`), so the empty segments have to go.
 */
export function parseSchemes(groups: string | undefined): string[] {
  if (!groups) return [];
  return groups.split(';').map((g) => g.trim()).filter(Boolean);
}

/**
 * The device family a control path targets: `<Gamepad>/leftStick` -> `Gamepad`.
 * Composite parents (`Dpad`, `2DVector`) name no device. A path beginning with
 * a wildcard is a usage that any device may satisfy, so it reports `Any`.
 */
export function deviceOfPath(path: string | undefined): string | null {
  if (!path) return null;
  const angle = /^<([^>]+)>/.exec(path);
  if (angle) return angle[1];
  if (path.startsWith('*')) return 'Any';
  return null;
}

function uniq(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v)))];
}

/** Group one action's bindings into composites-with-parts plus standalone controls. */
export function bindingNodes(map: InputActionMap, actionName: string): BindingNode[] {
  const rows = (map.bindings ?? []).filter((b) => b.action === actionName);
  const nodes: BindingNode[] = [];

  for (const row of rows) {
    if (row.isComposite) {
      nodes.push({
        binding: row,
        parts: [],
        isComposite: true,
        label: row.name || row.path || 'Composite',
        schemes: parseSchemes(row.groups),
        devices: [],
      });
      continue;
    }
    // A part belongs to the most recent composite. Unity always writes parts
    // immediately after their parent, so the last composite seen is the owner.
    const owner = row.isPartOfComposite ? nodes.filter((n) => n.isComposite).at(-1) : undefined;
    if (owner) {
      owner.parts.push(row);
      continue;
    }
    nodes.push({
      binding: row,
      parts: [],
      isComposite: false,
      label: row.path || row.name || '(binding)',
      schemes: parseSchemes(row.groups),
      devices: uniq([deviceOfPath(row.path)]),
    });
  }

  // A composite carries no groups of its own; its reach is its parts' reach.
  for (const node of nodes) {
    if (!node.isComposite) continue;
    node.schemes = uniq(node.parts.flatMap((p) => parseSchemes(p.groups)));
    node.devices = uniq(node.parts.map((p) => deviceOfPath(p.path)));
  }

  return nodes;
}

/** Every action across every map, flattened, each carrying its binding tree. */
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
        bindings: bindingNodes(map, action.name),
      });
    }
  }
  return out;
}

/** Every control scheme name declared by the asset, in declaration order. */
export function listControlSchemes(doc: InputActionsDocument): string[] {
  return (doc.controlSchemes ?? []).map((c) => c.name).filter(Boolean);
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
/**
 * A fresh Unity-style GUID for an action or binding id.
 *
 * Unity matches actions and bindings by `id`, not by name — a rename keeps
 * every reference alive precisely because the id does not change. So a NEW
 * action or binding needs a genuinely new id: reusing one silently merges two
 * things Unity believes are the same, and colliding with an existing one is
 * worse than a malformed file because nothing rejects it.
 *
 * `crypto.randomUUID` where available (browser, Bun, Node 19+), falling back to
 * `getRandomValues`. Unity writes the plain 8-4-4-4-12 form, so that is what we
 * write; it never sees the braces the C# `Guid` type prints.
 */
export function newInputId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // RFC 4122 version 4, variant 10xx — the shape Unity's own serializer emits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface AddActionInput {
  mapName: string;
  actionName: string;
  /** `Button` (default), `Value` or `PassThrough`. */
  type?: string;
  /** Must agree with what `ReadValue<T>()` will ask for. */
  expectedControlType?: string;
  /** Control paths to bind, e.g. `['<Keyboard>/space', '<Gamepad>/buttonSouth']`. */
  bindings?: readonly string[];
  /** Control scheme names for those bindings; omitted means every scheme. */
  groups?: readonly string[];
}

export interface MutationResult {
  parsed: ParsedInputActions;
  /** Null on success; a human-readable reason the document was left untouched. */
  error: string | null;
}

/**
 * Add an action to an existing map, with optional bindings.
 *
 * Refuses rather than guesses in the two ambiguous cases: an unknown map (the
 * caller meant a map that exists, or meant to create one — we cannot tell) and
 * a duplicate name (Unity permits it and then resolves `FindAction` to
 * whichever came first, which is never what anyone wants).
 */
export function addAction(
  parsed: ParsedInputActions,
  input: AddActionInput,
): MutationResult {
  if (!parsed.doc) return { parsed, error: 'the asset does not parse' };

  const doc = cloneDoc(parsed.doc);
  const map = (doc.maps ?? []).find((m) => m.name === input.mapName);
  if (!map) {
    const known = (doc.maps ?? []).map((m) => m.name).join(', ') || '(none)';
    return { parsed, error: `no action map named "${input.mapName}". Maps: ${known}` };
  }
  if ((map.actions ?? []).some((a) => a.name === input.actionName)) {
    return {
      parsed,
      error: `"${input.mapName}/${input.actionName}" already exists — Unity allows the duplicate and then resolves lookups to the first one`,
    };
  }

  const action: InputAction = {
    name: input.actionName,
    type: input.type ?? 'Button',
    id: newInputId(),
    expectedControlType: input.expectedControlType ?? '',
    processors: '',
    interactions: '',
    initialStateCheck: false,
  };
  map.actions = [...(map.actions ?? []), action];

  const groups = (input.groups ?? []).join(';');
  for (const path of input.bindings ?? []) {
    map.bindings = [...(map.bindings ?? []), makeBinding(path, input.actionName, groups)];
  }
  return { parsed: { ...parsed, doc }, error: null };
}

/** Bind one more control to an action that already exists. */
export function addBinding(
  parsed: ParsedInputActions,
  input: { mapName: string; actionName: string; path: string; groups?: readonly string[] },
): MutationResult {
  if (!parsed.doc) return { parsed, error: 'the asset does not parse' };

  const doc = cloneDoc(parsed.doc);
  const map = (doc.maps ?? []).find((m) => m.name === input.mapName);
  if (!map) {
    const known = (doc.maps ?? []).map((m) => m.name).join(', ') || '(none)';
    return { parsed, error: `no action map named "${input.mapName}". Maps: ${known}` };
  }
  if (!(map.actions ?? []).some((a) => a.name === input.actionName)) {
    const known = (map.actions ?? []).map((a) => a.name).join(', ') || '(none)';
    return {
      parsed,
      error: `no action named "${input.actionName}" in map "${input.mapName}". Actions: ${known}`,
    };
  }

  map.bindings = [
    ...(map.bindings ?? []),
    makeBinding(input.path, input.actionName, (input.groups ?? []).join(';')),
  ];
  return { parsed: { ...parsed, doc }, error: null };
}

/**
 * One standalone binding, with every field Unity writes.
 *
 * The empty strings are not noise: Unity's own serializer emits them, and a
 * binding missing them reads as a smaller diff here and a larger one the next
 * time Unity saves the asset.
 */
function makeBinding(path: string, action: string, groups: string): InputBinding {
  return {
    name: '',
    id: newInputId(),
    path,
    interactions: '',
    processors: '',
    groups,
    action,
    isComposite: false,
    isPartOfComposite: false,
  };
}

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
