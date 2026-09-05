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
 *
 * Three things the panel learned and this tool did not, until now:
 *
 *   1. **The wrapper.** With `generateWrapperCode: 1` in the asset's `.meta`,
 *      the project's idiom is `controls.Player.Jump.performed += OnJump`, not
 *      `FindAction("Jump")`. Writing the string form into such a project is
 *      not wrong so much as foreign, and it throws away the compile-time
 *      safety the wrapper exists to provide.
 *   2. **Wrapper references.** `buildActionReferenceIndex` only sees
 *      `controls.Player.Jump` when it is handed a `WrapperCatalog`. Without
 *      one, every action in a wrapper project reports zero references — so
 *      `refs: true` used to tell the agent, confidently, that live actions
 *      were unused.
 *   3. **Device coverage.** "Cancel has no gamepad binding" is a console
 *      certification failure that is trivially visible from the asset and
 *      invisible from any single action.
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
  coverage: Type.Optional(
    Type.Boolean({
      description:
        'Show the actions × control-schemes matrix, so a scheme with no binding (e.g. an action reachable on keyboard but not on gamepad) is visible before it fails certification.',
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
    actions: Array<{ name: string; mapName: string }>,
  ) => Promise<ActionRefsResult>;
  /** Wrapper settings + Inspector-wiring suppressor, read from the `.meta`. */
  loadAssetContext: (assetPath: string, workspacePath: string) => Promise<AssetContext>;
  /** Actions × control schemes for one asset, straight from its own bindings. */
  coverage: (assetPath: string) => Promise<CoverageResult | null>;
}

export interface ActionRefsResult {
  byActionName: Map<string, ActionReference[]>;
  /** True when any scanned file mentions `InputActionReference`. */
  usesInputActionReference: boolean;
}

export interface AssetContext {
  wrapper: { className: string; path: string | null } | null;
  assetReferencedByScene: boolean;
}

export interface CoverageResult {
  schemes: string[];
  rows: Array<{ qualifiedName: string; bound: string[]; missing: string[] }>;
}

const defaultDeps: InputActionsToolDeps = {
  async loadIndex(workspacePath) {
    const { loadInputActions, getInputActionsIndex } = await import('../../../unity-analyzers');
    // Prime first: `execute` is async, so the tool never has to answer from
    // the cold null snapshot the synchronous analyzer rules must tolerate.
    await loadInputActions(workspacePath);
    return getInputActionsIndex();
  },
  async findRefs(workspacePath, actions) {
    const { buildActionReferenceIndex, buildWrapperCatalog } = await import('../../../unity-input');
    // The catalog is what makes `controls.Player.Jump` visible. Omitting it is
    // not a smaller answer, it is a wrong one: in a project with
    // `generateWrapperCode: 1` every action reports zero references.
    const index = await buildActionReferenceIndex(
      workspacePath,
      actions.map((a) => a.name),
      buildWrapperCatalog(actions),
    );
    return {
      byActionName: index.byActionName,
      usesInputActionReference: index.usesInputActionReference,
    };
  },
  async loadAssetContext(assetPath, workspacePath) {
    const { loadInputAssetContext } = await import('../../../unity-input');
    const ctx = await loadInputAssetContext(assetPath, workspacePath);
    return { wrapper: ctx.wrapper, assetReferencedByScene: ctx.assetReferencedByScene };
  },
  async coverage(assetPath) {
    const { invoke } = await import('@tauri-apps/api/core');
    const [{ parseInputActions, listActions, listControlSchemes }, { buildInputGraph, coverageMatrix }] =
      await Promise.all([
        import('../../../../utils/inputactions-model'),
        import('../../../unity-input'),
      ]);
    const text = await invoke<string>('read_file', { path: assetPath });
    const parsed = parseInputActions(text);
    if (!parsed.doc) return null;
    // Reuse `coverageMatrix` rather than deriving coverage from the index's
    // flattened `schemes`: a binding with NO scheme belongs to EVERY scheme,
    // which is Unity's rule and the easy thing to get backwards.
    const graph = buildInputGraph({
      asset: assetPath,
      actions: listActions(parsed.doc),
      conflicts: [],
      schemes: listControlSchemes(parsed.doc),
      refs: new Map(),
      scanned: false,
    });
    return {
      schemes: graph.schemes,
      rows: coverageMatrix(graph).map((r) => ({
        qualifiedName: r.action.qualifiedName,
        bound: r.cells.filter((c) => c.bound).map((c) => c.scheme),
        missing: r.cells.filter((c) => !c.bound).map((c) => c.scheme),
      })),
    };
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

/**
 * Unity's `CSharpCodeHelpers.MakeIdentifier`, via the same implementation the
 * reference scanner uses. `"Move Camera"` becomes `MoveCamera`, so a naive
 * concatenation would print a property that does not exist.
 */
function makeIdent(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '').replace(/^[0-9]/, (d) => `_${d}`);
}

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

/**
 * How the project's code is expected to reach an action.
 *
 * Stated first because it decides what the agent should WRITE. In a wrapper
 * project the string APIs still compile, so nothing would ever correct a model
 * that reaches for `FindAction` out of habit.
 */
function wrapperLines(contexts: Map<string, AssetContext>, workspacePath: string): string[] {
  const out: string[] = [];
  for (const [assetPath, ctx] of contexts) {
    if (!ctx.wrapper) continue;
    out.push(
      `Generated wrapper for ${rel(assetPath, workspacePath)}: class ${ctx.wrapper.className}` +
        (ctx.wrapper.path ? ` (${ctx.wrapper.path})` : ''),
    );
    out.push(
      `  This project's idiom is \`${ctx.wrapper.className} controls = new(); controls.<Map>.<Action>.performed += OnX;\`` +
        ' — compile-checked property access, not string lookup. Prefer it over FindAction here.',
    );
  }
  return out;
}

/** Every action, grouped by map. */
function inventory(
  index: InputActionsIndex,
  workspacePath: string,
  contexts: Map<string, AssetContext>,
  map?: string,
): string {
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
  const wrappers = wrapperLines(contexts, workspacePath);
  if (wrappers.length > 0) out.push('', ...wrappers);

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
    'Pass refs:true for the C# that reads each action, or coverage:true for the actions × control-schemes matrix.',
  );
  return out.join('\n');
}

/** The actions × control-schemes matrix, holes first. */
function coverageReport(result: CoverageResult, assetPath: string, workspacePath: string): string {
  if (result.schemes.length === 0) {
    return `${rel(assetPath, workspacePath)} declares no control schemes, so every binding is reachable on every device. Nothing to cover.`;
  }
  const holes = result.rows.filter((r) => r.missing.length > 0);
  const out = [
    `Control-scheme coverage for ${rel(assetPath, workspacePath)}`,
    `Schemes: ${result.schemes.join(', ')}`,
  ];
  if (holes.length === 0) {
    out.push('', 'Every action is bound in every control scheme.');
    return out.join('\n');
  }
  out.push('', `${holes.length} action(s) with no binding in at least one scheme:`);
  for (const r of holes) {
    out.push(`  ${r.qualifiedName} — missing: ${r.missing.join(', ')}${r.bound.length > 0 ? `  (has: ${r.bound.join(', ')})` : '  (no scheme at all)'}`);
  }
  out.push(
    '',
    'A player on a missing scheme simply cannot trigger that action. Nothing warns about it in Unity, ' +
      'and on console it surfaces as a certification failure rather than a bug report.',
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
  contexts: Map<string, AssetContext>,
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
    const wrapper = contexts.get(a.assetPath)?.wrapper;
    if (wrapper) {
      out.push(
        `  wrapper access: ${wrapper.className}.${makeIdent(a.mapName)}.${makeIdent(a.name)}` +
          ' — prefer this over FindAction in this project; it is compile-checked.',
      );
    }
    if (a.starved) {
      const c = index.conflicts.find((x) => x.starved.includes(a.qualifiedName));
      out.push(
        `  ⚠ STARVED: ${c?.winner ?? 'another action'} claims ${c?.path ?? 'the same control'} first, so this action never fires at runtime.`,
      );
    }
  }

  if (wantRefs) {
    // Every action in the project, so the wrapper catalog is complete — the
    // catalog maps sanitised C# identifiers back to asset names, and a partial
    // one would miss exactly the sites this scan exists to find.
    const all = [...index.byQualifiedName.values()].map((a) => ({ name: a.name, mapName: a.mapName }));
    const names = [...new Set(matches.map((a) => a.name))];
    const result = await deps.findRefs(workspacePath, all);
    const hits = names.flatMap((n) => result.byActionName.get(n) ?? []);
    out.push('');
    if (hits.length > 0) {
      out.push(`C# references (${hits.length}):`);
      for (const r of hits.slice(0, 40)) out.push(refLine(r, workspacePath));
    } else {
      // "Nothing reads this" is the one claim that can be confidently wrong,
      // so it is only made when nothing could be hiding a reader. An
      // InputActionReference wired in the Inspector leaves no trace in C# at
      // all — see `input-graph.ts`'s `Suppressors`.
      const suppressed =
        result.usesInputActionReference ||
        matches.some((a) => contexts.get(a.assetPath)?.assetReferencedByScene);
      out.push(
        suppressed
          ? 'No C# reads this action by name. The project wires InputActionReference fields in the ' +
              'Inspector (or a scene/prefab references this asset), so it may still be in use — treat ' +
              'this as unknown, not unused, and do not delete it on this evidence.'
          : 'No C# references. Nothing in the project looks this action up — it is defined in the ' +
              'asset but unread.',
      );
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
      'Pass refs:true to also get the C# call sites, including the method that runs when the action fires, ' +
      'and coverage:true for the actions × control-schemes matrix (an action with no gamepad binding is invisible otherwise). ' +
      'Reports the generated wrapper class when the asset has one, because that changes how the action should be reached from code. ' +
      'Far cheaper than reading the .inputactions JSON, and it says which input system the project actually uses.',
    parameters: schema,
    async execute(_id, params) {
      const { action, map, refs = false, coverage = false } = params as Params;

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

      // Cheap (a `.meta` read plus a guid lookup per asset), and it changes
      // what the agent should write, so it is loaded on every path rather than
      // being hidden behind a flag.
      const contexts = new Map<string, AssetContext>();
      await Promise.all(
        index.assetPaths.map(async (assetPath) => {
          const ctx = await deps
            .loadAssetContext(assetPath, workspacePath)
            .catch(() => null);
          if (ctx) contexts.set(assetPath, ctx);
        }),
      );

      if (coverage) {
        const reports: string[] = [];
        for (const assetPath of index.assetPaths) {
          const result = await deps.coverage(assetPath).catch(() => null);
          reports.push(
            result
              ? coverageReport(result, assetPath, workspacePath)
              : `Could not read control schemes from ${rel(assetPath, workspacePath)}.`,
          );
        }
        return txt(cap(reports.join('\n\n')));
      }

      const body = action
        ? await detail(index, action, refs, workspacePath, contexts, deps)
        : inventory(index, workspacePath, contexts, map);
      return txt(cap(body));
    },
  };
}
