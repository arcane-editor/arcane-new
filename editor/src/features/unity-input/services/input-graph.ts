// The input graph: one model joining the `.inputactions` asset to the C# that
// reads it, plus the three pivots the panel renders.
//
// **Why this exists at all.** Unity's Input Actions window owns the left half of
// the chain (device -> scheme -> binding -> action). Your C# owns the right
// half. Nothing draws the line between them, because doing so needs the asset,
// the scene graph and a code index in one process. That join is the product;
// the statuses below are a property of it rather than the point of it.
//
// Pure and store-free, so it runs under Bun's DOM-less test runtime. It lives in
// the feature rather than `utils/` because it consumes `ActionReference`, and
// `utils -> features` is the forbidden import direction.

import type {
  BindingConflict,
  BindingNode,
  ResolvedAction,
} from '../../../utils/inputactions-model';
import { BEHAVIOUR_KINDS, type ActionReference } from './action-refs';

export type ActionStatus =
  /** At least one C# site reads it. */
  | 'wired'
  /** No C# site reads it, and nothing is suppressing that conclusion. */
  | 'unread'
  /** Another action in the same map claims its control; it silently never fires. */
  | 'never-fires'
  /** No control is bound at all, so it cannot fire however it is read. */
  | 'no-bindings'
  /** Something we cannot see could be reading it. NOT a claim either way. */
  | 'unknown';

/**
 * Reasons an action with no visible C# reference might still be in use.
 *
 * These exist because `unread` is the only status that accuses the user of dead
 * code, so it has to be the hardest one to reach. Each suppressor here is a
 * real Unity pattern that leaves no trace in the places we look.
 */
export interface Suppressors {
  /** A scene or prefab references this asset, so an InputActionReference field may be wired in the Inspector. */
  assetReferencedByScene: boolean;
  /** The project declares `InputActionReference` fields anywhere. */
  usesInputActionReference: boolean;
}

export const NO_SUPPRESSORS: Suppressors = {
  assetReferencedByScene: false,
  usesInputActionReference: false,
};

export interface ActionNode {
  mapName: string;
  name: string;
  qualifiedName: string;
  action: ResolvedAction;
  /** Every C# site that reaches this action, in source order. */
  refs: ActionReference[];
  /** The subset that answers "what runs when it fires?". */
  behaviours: ActionReference[];
  status: ActionStatus;
  /** Populated for `never-fires`: the action that wins the contested control. */
  starvedBy: string | null;
  /** Leaf controls bound, composites counted by their parts. */
  controlCount: number;
}

export interface MapNode {
  name: string;
  actions: ActionNode[];
}

export interface WrapperInfo {
  className: string;
  path: string | null;
}

export interface InputGraph {
  asset: string;
  wrapper: WrapperInfo | null;
  maps: MapNode[];
  schemes: string[];
  suppressors: Suppressors;
  /** False until the project-wide C# walk has finished. */
  scanned: boolean;
}

/** Leaf controls on an action: a composite contributes its parts, not itself. */
export function controlCountOf(bindings: readonly BindingNode[]): number {
  return bindings.reduce((n, b) => n + (b.isComposite ? b.parts.length : 1), 0);
}

/**
 * Decide what to say about one action.
 *
 * Order matters and is deliberate:
 *   - `no-bindings` first, because it is asset-local truth: however the action
 *     is read, nothing can trigger it.
 *   - `never-fires` next, and ABOVE `wired`: an action that is read in code but
 *     starved by a conflict still never fires, and that is the more useful fact.
 *   - `unknown` before `unread`, always. Reporting dead code we are not sure
 *     about is the one failure that would make the panel untrustworthy, which
 *     is the whole reason the current one reads as noise.
 */
export function deriveActionStatus(input: {
  controlCount: number;
  starved: boolean;
  refCount: number;
  suppressors: Suppressors;
  scanned: boolean;
}): ActionStatus {
  if (input.controlCount === 0) return 'no-bindings';
  if (input.starved) return 'never-fires';
  if (input.refCount > 0) return 'wired';
  // The walk has not finished, so "no references" means "not looked yet".
  if (!input.scanned) return 'unknown';
  if (input.suppressors.assetReferencedByScene) return 'unknown';
  if (input.suppressors.usesInputActionReference) return 'unknown';
  return 'unread';
}

/** Human-readable reason for a status, for the row and the tooltip. */
export function explainStatus(node: ActionNode, suppressors: Suppressors): string {
  switch (node.status) {
    case 'no-bindings':
      return 'No control is bound, so this action can never fire.';
    case 'never-fires':
      return node.starvedBy
        ? `Never fires — ${node.starvedBy} claims the same control in this map.`
        : 'Never fires — another action claims the same control in this map.';
    case 'wired':
      return `Read from ${node.refs.length} site${node.refs.length === 1 ? '' : 's'} in C#.`;
    case 'unread':
      return 'Nothing in the project reads this action.';
    case 'unknown':
      if (suppressors.assetReferencedByScene || suppressors.usesInputActionReference) {
        return 'No C# reads this by name, but the asset is referenced from a scene or prefab — it may be wired through an InputActionReference in the Inspector.';
      }
      return 'Still scanning the project.';
  }
}

export interface GraphInput {
  asset: string;
  actions: readonly ResolvedAction[];
  conflicts: readonly BindingConflict[];
  schemes: readonly string[];
  /** Unqualified action name -> the C# sites that reach it. */
  refs: ReadonlyMap<string, readonly ActionReference[]>;
  suppressors?: Suppressors;
  scanned: boolean;
  wrapper?: WrapperInfo | null;
}

/** Assemble the graph. Pure: same input, same output, no I/O. */
export function buildInputGraph(input: GraphInput): InputGraph {
  const suppressors = input.suppressors ?? NO_SUPPRESSORS;

  /** Qualified name -> the action that beats it on a shared control. */
  const starvedBy = new Map<string, string>();
  for (const conflict of input.conflicts) {
    for (const loser of conflict.starved) {
      if (!starvedBy.has(loser)) starvedBy.set(loser, conflict.winner);
    }
  }

  const byMap = new Map<string, ActionNode[]>();
  for (const action of input.actions) {
    const refs = [...(input.refs.get(action.name) ?? [])];
    const controlCount = controlCountOf(action.bindings);
    const node: ActionNode = {
      mapName: action.mapName,
      name: action.name,
      qualifiedName: action.qualifiedName,
      action,
      refs,
      behaviours: refs.filter((r) => BEHAVIOUR_KINDS.includes(r.kind)),
      starvedBy: starvedBy.get(action.qualifiedName) ?? null,
      controlCount,
      status: deriveActionStatus({
        controlCount,
        starved: starvedBy.has(action.qualifiedName),
        refCount: refs.length,
        suppressors,
        scanned: input.scanned,
      }),
    };
    const list = byMap.get(action.mapName);
    if (list) list.push(node);
    else byMap.set(action.mapName, [node]);
  }

  return {
    asset: input.asset,
    wrapper: input.wrapper ?? null,
    // Insertion order, which is the asset's own map order because
    // `input.actions` arrives in declaration order.
    maps: [...byMap.entries()].map(([name, actions]) => ({ name, actions })),
    schemes: [...input.schemes],
    suppressors,
    scanned: input.scanned,
  };
}

// ── Pivots ───────────────────────────────────────────────────────────────────

export interface ControlRow {
  /** The control path, e.g. `<Keyboard>/space`. */
  path: string;
  device: string | null;
  /** Every action this control triggers, across every map. */
  actions: ActionNode[];
}

/**
 * "What does Space actually do in this game?"
 *
 * Answerable nowhere today: Unity's window is organised by action, so finding
 * every action a control drives means reading the whole asset by eye.
 */
export function byControl(graph: InputGraph): ControlRow[] {
  const rows = new Map<string, ControlRow>();
  for (const map of graph.maps) {
    for (const action of map.actions) {
      for (const node of action.action.bindings) {
        const controls = node.isComposite ? node.parts : [node.binding];
        for (const control of controls) {
          if (!control.path) continue;
          let row = rows.get(control.path);
          if (!row) {
            rows.set(control.path, (row = {
              path: control.path,
              device: node.devices[0] ?? null,
              actions: [],
            }));
          }
          if (!row.actions.includes(action)) row.actions.push(action);
        }
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export interface CoverageCell {
  scheme: string;
  bound: boolean;
}

export interface CoverageRow {
  action: ActionNode;
  cells: CoverageCell[];
  /** True when at least one scheme has no binding — the hole worth seeing. */
  hasHole: boolean;
}

/**
 * Actions x control schemes, holes highlighted.
 *
 * This is how "Cancel has no gamepad binding" gets found in the editor instead
 * of during console certification. A binding with NO scheme belongs to every
 * scheme, which is Unity's rule and the easy thing to get backwards.
 */
export function coverageMatrix(graph: InputGraph): CoverageRow[] {
  const schemes = graph.schemes;
  const rows: CoverageRow[] = [];
  for (const map of graph.maps) {
    for (const action of map.actions) {
      const covered = new Set<string>();
      let hasSchemeless = false;
      for (const node of action.action.bindings) {
        if (node.schemes.length === 0) hasSchemeless = true;
        for (const scheme of node.schemes) covered.add(scheme);
      }
      const cells = schemes.map((scheme) => ({
        scheme,
        bound: hasSchemeless || covered.has(scheme),
      }));
      rows.push({ action, cells, hasHole: cells.some((c) => !c.bound) });
    }
  }
  return rows;
}

/** Counts for the header strip. */
export function graphSummary(graph: InputGraph): Record<ActionStatus, number> & { total: number } {
  const out = {
    wired: 0, unread: 0, 'never-fires': 0, 'no-bindings': 0, unknown: 0, total: 0,
  } as Record<ActionStatus, number> & { total: number };
  for (const map of graph.maps) {
    for (const action of map.actions) {
      out[action.status]++;
      out.total++;
    }
  }
  return out;
}
