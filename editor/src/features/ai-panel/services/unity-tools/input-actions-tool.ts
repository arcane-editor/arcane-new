/**
 * `unity_input_actions` — the project's real input contract, for the agent.
 *
 * Unity's New Input System couples the asset to code through **strings**.
 * `FindAction("Jmp")` compiles, ships, and silently never fires; so does
 * `ReadValue<float>()` on a `Vector2` action, right up until it throws at
 * runtime. Before this tool the agent had no way to see any of that: the only
 * route to a `.inputactions` file was `read`, which spends ~12k tokens on a
 * 41KB JSON blob to recover a handful of names. In practice it guessed.
 *
 * The snapshot comes from the analyzers' cache rather than a private scan, so
 * the agent and the Problems panel can never disagree about which actions
 * exist — the agent writes `FindAction("Player/Jump")`, and UNITY0401 is
 * validating against the same map.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { txt, cap } from './text-result';
import type { InputActionsIndex, KnownAction } from '../../../../utils/inputactions-index';
import type { ActionReference } from '../../../unity-input';

const schema = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Action to describe in full, "Jump" or "Player/Jump". Omit to list every action in the project.',
    }),
  ),
  map: Type.Optional(
    Type.String({ description: 'Restrict the listing to one action map, e.g. "Player".' }),
  ),
  refs: Type.Optional(
    Type.Boolean({
      description:
        'Also list the C# call sites: where the action is looked up, subscribed to, and the method that runs when it fires. Requires a project scan, so ask for it only when the answer depends on the code.',
    }),
  ),
});
type Params = Static<typeof schema>;

/**
 * Injectable data access.
 *
 * Both defaults reach their feature through a dynamic `import()` — the same
 * reason `graphify-tools.ts` does it for the graphify store. `unity-input`'s
 * barrel exports React components and `unity-analyzers`' pulls Monaco; a
 * static import would drag `stores/theme.ts` into Bun's DOM-less runtime,
 * where its module-scope `document` access kills the suite on import alone.
 */
export interface InputActionsToolDeps {
  loadIndex: (workspacePath: string) => Promise<InputActionsIndex | null>;
  findRefs: (
    workspacePath: string,
    actionNames: string[],
  ) => Promise<Map<string, ActionReference[]>>;
}

const defaultDeps: InputActionsToolDeps = {
  async loadIndex(workspacePath) {
    const { loadInputActions, getInputActionsIndex } = await import('../../../unity-analyzers');
    // Prime first: `execute` is async, so the tool never has to answer from
    // the cold null snapshot the synchronous analyzer rules must tolerate.
    await loadInputActions(workspacePath);
    return getInputActionsIndex();
  },
  async findRefs(workspacePath, actionNames) {
    const { buildActionReferenceIndex } = await import('../../../unity-input');
    const index = await buildActionReferenceIndex(workspacePath, actionNames);
    return index.byActionName;
  },
};

const LEGACY_TEXT =
  'This project runs the legacy Input Manager (Project Settings → Player → Active Input Handling), so it has no .inputactions assets. ' +
  'InputAction, PlayerInput and Keyboard.current are NOT available here — use Input.GetAxis / Input.GetKey / Input.GetMouseButton. ' +
  'To convert the project, call unity_plan_migration with kind "input-system".';

const NO_ASSETS_TEXT =
  'The New Input System is active, but this project has no .inputactions asset. ' +
  'Actions can still be declared in code (new InputAction(...)) or wired through a PlayerInput component. ' +
  'If the user wants a shared, rebindable set, create one in Unity (Assets → Create → Input Actions) rather than inventing action names here.';

/** Workspace-relative path, for output a human can match to the file tree. */
function rel(path: string, workspacePath: string): string {
  const prefix = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** `Value  Vector2  <Keyboard>/space, <Gamepad>/buttonSouth` */
function actionLine(a: KnownAction): string {
  const type = a.actionType ?? '?';
  const control = a.expectedControlType ?? 'any';
  const bindings = a.bindings.length > 0 ? a.bindings.join(', ') : '(no bindings)';
  const schemes = a.schemes.length > 0 ? `  [${a.schemes.join(', ')}]` : '';
  const starved = a.starved ? '  ⚠ STARVED — another action claims its control, this one never fires' : '';
  return `  ${a.name}  —  ${type}, reads as ${control}\n      ${bindings}${schemes}${starved}`;
}

function conflictLines(index: InputActionsIndex): string[] {
  if (index.conflicts.length === 0) return [];
  const out = ['', 'Binding conflicts (declaration order decides; the starved action never fires):'];
  for (const c of index.conflicts.slice(0, 20)) {
    out.push(`  ${c.path} — ${c.winner} wins, starved: ${c.starved.join(', ')}`);
  }
  return out;
}

/** Every action, grouped by map. */
function inventory(index: InputActionsIndex, workspacePath: string, map?: string): string {
  const actions = [...index.byQualifiedName.values()].filter(
    (a) => !map || a.mapName.toLowerCase() === map.toLowerCase(),
  );
  if (actions.length === 0) {
    return map
      ? `No action map named "${map}". Maps in this project: ${[...index.mapNames].join(', ')}.`
      : NO_ASSETS_TEXT;
  }

  const schemes = [...new Set(actions.flatMap((a) => a.schemes))];
  const out = [
    `Input system: ${index.inputSystem}`,
    `Assets: ${index.assetPaths.map((p) => rel(p, workspacePath)).join(', ')}`,
  ];
  if (schemes.length > 0) out.push(`Control schemes: ${schemes.join(', ')}`);

  const byMap = new Map<string, KnownAction[]>();
  for (const a of actions) {
    const list = byMap.get(a.mapName);
    if (list) list.push(a);
    else byMap.set(a.mapName, [a]);
  }
  for (const [mapName, list] of byMap) {
    out.push('', `${mapName} (${list.length} action${list.length === 1 ? '' : 's'})`);
    for (const a of list) out.push(actionLine(a));
  }
  out.push(...conflictLines(index));
  out.push(
    '',
    'Reference an action by its exact qualified name, e.g. FindAction("Player/Jump"). Names are case-sensitive.',
  );
  return out.join('\n');
}

/** Resolve `Jump` or `Player/Jump` to every matching definition. */
function resolve(index: InputActionsIndex, action: string): KnownAction[] {
  const exact = index.byQualifiedName.get(action);
  if (exact) return [exact];
  const byName = index.byName.get(action);
  if (byName) return byName;
  // Case-insensitive last resort, so a near-miss gets corrected rather than
  // reported as missing — the model then writes the canonical spelling.
  const lower = action.toLowerCase();
  return [...index.byQualifiedName.values()].filter(
    (a) => a.name.toLowerCase() === lower || a.qualifiedName.toLowerCase() === lower,
  );
}

function refLine(r: ActionReference, workspacePath: string): string {
  const where = `${rel(r.filePath, workspacePath)}:${r.line}`;
  const kind =
    r.kind === 'handler'
      ? `runs when it fires — ${r.handler ?? 'handler'}()`
      : r.kind === 'subscription'
        ? `subscribes ${r.handler ?? '?'} on ${r.phase ?? '?'}`
        : r.kind;
  return `  ${where}  [${kind}]\n      ${r.snippet}`;
}

async function detail(
  index: InputActionsIndex,
  action: string,
  wantRefs: boolean,
  workspacePath: string,
  deps: InputActionsToolDeps,
): Promise<string> {
  const matches = resolve(index, action);
  if (matches.length === 0) {
    const all = [...index.byQualifiedName.keys()];
    return (
      `No action named "${action}" in any .inputactions asset. ` +
      `Do NOT invent it — a wrong name compiles and then silently never fires. ` +
      `Actions in this project: ${all.join(', ')}.`
    );
  }

  const out: string[] = [];
  for (const a of matches) {
    out.push(a.qualifiedName);
    out.push(`  type: ${a.actionType ?? 'unspecified'}`);
    out.push(`  reads as: ${a.expectedControlType ?? 'unspecified'} — ReadValue<T> must match this`);
    out.push(`  asset: ${rel(a.assetPath, workspacePath)}`);
    out.push(`  bindings:`);
    if (a.bindings.length === 0) out.push('    (none — this action has no controls bound)');
    for (const b of a.bindings) out.push(`    ${b}`);
    if (a.schemes.length > 0) out.push(`  schemes: ${a.schemes.join(', ')}`);
    if (a.starved) {
      const c = index.conflicts.find((x) => x.starved.includes(a.qualifiedName));
      out.push(
        `  ⚠ STARVED: ${c?.winner ?? 'another action'} claims ${c?.path ?? 'the same control'} first, so this action never fires at runtime.`,
      );
    }
  }

  if (wantRefs) {
    const names = [...new Set(matches.map((a) => a.name))];
    const refs = await deps.findRefs(workspacePath, names);
    const hits = names.flatMap((n) => refs.get(n) ?? []);
    out.push('');
    if (hits.length === 0) {
      out.push(
        'No C# references. Nothing in the project looks this action up — it is defined in the asset but unused.',
      );
    } else {
      out.push(`C# references (${hits.length}):`);
      for (const r of hits.slice(0, 40)) out.push(refLine(r, workspacePath));
    }
  }

  return out.join('\n');
}

export function createUnityInputActionsTool(
  workspacePath: string,
  deps: InputActionsToolDeps = defaultDeps,
): AgentTool {
  return {
    name: 'unity_input_actions',
    label: 'unity input actions',
    description:
      "Read the project's Unity Input System actions (.inputactions): every action map, action, its control type and bindings, the control schemes, and binding conflicts. " +
      'Call this BEFORE writing any input code or referencing an action by name — a wrong action name compiles and then silently never fires at runtime. ' +
      'Pass refs:true to also get the C# call sites, including the method that runs when the action fires. ' +
      'Far cheaper than reading the .inputactions JSON, and it says which input system the project actually uses.',
    parameters: schema,
    async execute(_id, params) {
      const { action, map, refs = false } = params as Params;

      // Gated here, not at registration: `project-context.inputSystem` resolves
      // asynchronously, so conditioning the tool set on it would change the
      // provider's cached prompt prefix mid-conversation (graphify-tools.ts §1).
      let index: InputActionsIndex | null;
      try {
        index = await deps.loadIndex(workspacePath);
      } catch {
        return txt(
          'Could not read the project\'s .inputactions assets. Fall back to the read tool on the asset path.',
        );
      }

      if (!index) {
        return txt(
          'No input snapshot for this workspace yet. Retry once, or use read/list on the .inputactions asset.',
        );
      }
      if (index.inputSystem === 'Legacy') return txt(LEGACY_TEXT);
      if (index.assetCount === 0) return txt(NO_ASSETS_TEXT);

      const body = action
        ? await detail(index, action, refs, workspacePath, deps)
        : inventory(index, workspacePath, map);
      return txt(cap(body));
    },
  };
}
