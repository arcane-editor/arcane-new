import { describe, it, expect } from 'bun:test';
import {
  buildInputGraph,
  deriveActionStatus,
  byControl,
  coverageMatrix,
  graphSummary,
  controlCountOf,
  NO_SUPPRESSORS,
  type Suppressors,
} from './input-graph';
import type { ActionReference } from './action-refs';
import type { BindingNode, ResolvedAction } from '../../../utils/inputactions-model';

// ── fixtures ─────────────────────────────────────────────────────────────────

function control(path: string, schemes: string[] = []): BindingNode {
  return {
    binding: { id: path, path, action: '', groups: schemes.join(';') },
    parts: [],
    isComposite: false,
    label: path,
    schemes,
    devices: [/^<([^>]+)>/.exec(path)?.[1] ?? 'Any'],
  };
}

function composite(label: string, parts: string[], schemes: string[] = []): BindingNode {
  return {
    binding: { id: label, path: '', action: '', isComposite: true },
    parts: parts.map((p) => ({ id: p, path: p, action: '', isPartOfComposite: true })),
    isComposite: true,
    label,
    schemes,
    devices: ['Keyboard'],
  };
}

function action(
  mapName: string,
  name: string,
  bindings: BindingNode[] = [control('<Keyboard>/space')],
): ResolvedAction {
  return {
    mapName,
    name,
    qualifiedName: `${mapName}/${name}`,
    id: `${mapName}-${name}`,
    type: 'Button',
    bindings,
  };
}

function ref(actionName: string, kind: ActionReference['kind'] = 'wrapper'): ActionReference {
  return {
    filePath: '/p/X.cs', line: 1, column: 1, kind, actionName,
    qualifiedName: null, snippet: '',
  };
}

const SUPPRESSED: Suppressors = {
  assetReferencedByScene: true,
  usesInputActionReference: false,
};

// ── status ───────────────────────────────────────────────────────────────────

describe('deriveActionStatus', () => {
  const base = {
    controlCount: 1, starved: false, refCount: 0,
    suppressors: NO_SUPPRESSORS, scanned: true,
  };

  it('reports no-bindings first — it is asset-local truth', () => {
    // However the action is read, nothing can trigger it.
    expect(deriveActionStatus({ ...base, controlCount: 0, refCount: 5 })).toBe('no-bindings');
  });

  it('ranks never-fires ABOVE wired', () => {
    // An action read from code but starved by a conflict still never fires, and
    // that is the more useful fact to lead with.
    expect(deriveActionStatus({ ...base, starved: true, refCount: 3 })).toBe('never-fires');
  });

  it('reports wired when anything reads it', () => {
    expect(deriveActionStatus({ ...base, refCount: 1 })).toBe('wired');
  });

  it('says unknown, not unread, while the C# walk is still running', () => {
    expect(deriveActionStatus({ ...base, scanned: false })).toBe('unknown');
  });

  it('says unknown when a scene or prefab references the asset', () => {
    // An InputActionReference field wired in the Inspector leaves no trace in
    // any C# pattern we look for, so we must not call the action dead.
    expect(deriveActionStatus({ ...base, suppressors: SUPPRESSED })).toBe('unknown');
  });

  it('says unknown when the project uses InputActionReference anywhere', () => {
    expect(deriveActionStatus({
      ...base,
      suppressors: { assetReferencedByScene: false, usesInputActionReference: true },
    })).toBe('unknown');
  });

  it('only reaches unread when every suppressor is clear', () => {
    expect(deriveActionStatus(base)).toBe('unread');
  });
});

describe('controlCountOf', () => {
  it('counts a composite by its parts, not as one', () => {
    expect(controlCountOf([composite('WASD', ['w', 'a', 's', 'd'])])).toBe(4);
  });

  it('counts a standalone binding as one', () => {
    expect(controlCountOf([control('<Keyboard>/space')])).toBe(1);
  });

  it('treats a composite with no parts as no controls', () => {
    expect(controlCountOf([composite('WASD', [])])).toBe(0);
  });
});

// ── assembly ─────────────────────────────────────────────────────────────────

describe('buildInputGraph', () => {
  const actions = [
    action('Player', 'Jump'),
    action('Player', 'Fire', [control('<Mouse>/leftButton')]),
    action('UI', 'Submit'),
  ];

  const graph = buildInputGraph({
    asset: 'Assets/Controls.inputactions',
    actions,
    conflicts: [],
    schemes: ['Keyboard&Mouse', 'Gamepad'],
    refs: new Map([['Jump', [ref('Jump')]]]),
    scanned: true,
  });

  it('groups by map, in asset order', () => {
    expect(graph.maps.map((m) => m.name)).toEqual(['Player', 'UI']);
    expect(graph.maps[0].actions.map((a) => a.name)).toEqual(['Jump', 'Fire']);
  });

  it('attaches the C# sites to the right action', () => {
    expect(graph.maps[0].actions[0].refs).toHaveLength(1);
    expect(graph.maps[0].actions[1].refs).toEqual([]);
  });

  it('derives a status per action', () => {
    expect(graph.maps[0].actions[0].status).toBe('wired');
    expect(graph.maps[0].actions[1].status).toBe('unread');
  });

  it('separates behaviours from plain reads', () => {
    const withHandler = buildInputGraph({
      asset: 'a', actions: [action('Player', 'Jump')], conflicts: [], schemes: [],
      refs: new Map([['Jump', [ref('Jump', 'wrapper'), ref('Jump', 'handler')]]]),
      scanned: true,
    });
    const node = withHandler.maps[0].actions[0];
    expect(node.refs).toHaveLength(2);
    expect(node.behaviours.map((r) => r.kind)).toEqual(['handler']);
  });

  it('records who starves a conflicted action', () => {
    const conflicted = buildInputGraph({
      asset: 'a', actions, conflicts: [{
        mapName: 'Player', path: '<Keyboard>/space',
        actions: ['Player/Jump', 'Player/Fire'],
        winner: 'Player/Jump', starved: ['Player/Fire'], bindingIds: [],
      }], schemes: [], refs: new Map(), scanned: true,
    });
    const fire = conflicted.maps[0].actions[1];
    expect(fire.status).toBe('never-fires');
    expect(fire.starvedBy).toBe('Player/Jump');
  });
});

describe('graphSummary', () => {
  it('counts every action by status', () => {
    const graph = buildInputGraph({
      asset: 'a',
      actions: [action('P', 'A'), action('P', 'B'), action('P', 'C', [])],
      conflicts: [], schemes: [],
      refs: new Map([['A', [ref('A')]]]),
      scanned: true,
    });
    const s = graphSummary(graph);
    expect(s.total).toBe(3);
    expect(s.wired).toBe(1);
    expect(s.unread).toBe(1);
    expect(s['no-bindings']).toBe(1);
  });
});

// ── pivots ───────────────────────────────────────────────────────────────────

describe('byControl — "what does Space actually do?"', () => {
  const graph = buildInputGraph({
    asset: 'a',
    actions: [
      action('Player', 'Jump', [control('<Keyboard>/space')]),
      action('UI', 'Submit', [control('<Keyboard>/space')]),
      action('Player', 'Move', [composite('WASD', ['<Keyboard>/w', '<Keyboard>/a'])]),
    ],
    conflicts: [], schemes: [], refs: new Map(), scanned: true,
  });

  it('collects every action a control drives, across maps', () => {
    const space = byControl(graph).find((r) => r.path === '<Keyboard>/space')!;
    expect(space.actions.map((a) => a.qualifiedName)).toEqual(['Player/Jump', 'UI/Submit']);
  });

  it('expands a composite into its parts, since those are the real controls', () => {
    const paths = byControl(graph).map((r) => r.path);
    expect(paths).toContain('<Keyboard>/w');
    expect(paths).toContain('<Keyboard>/a');
    // The composite parent binds no control of its own.
    expect(paths).not.toContain('');
  });

  it('reports the device family', () => {
    expect(byControl(graph).find((r) => r.path === '<Keyboard>/space')!.device).toBe('Keyboard');
  });
});

describe('coverageMatrix — the console-cert hole', () => {
  const graph = buildInputGraph({
    asset: 'a',
    actions: [
      action('Player', 'Jump', [
        control('<Keyboard>/space', ['Keyboard&Mouse']),
        control('<Gamepad>/buttonSouth', ['Gamepad']),
      ]),
      action('UI', 'Cancel', [control('<Keyboard>/escape', ['Keyboard&Mouse'])]),
      action('Player', 'Pause', [control('<Keyboard>/p')]),
    ],
    conflicts: [], schemes: ['Keyboard&Mouse', 'Gamepad'], refs: new Map(), scanned: true,
  });

  it('marks an action bound in every scheme as covered', () => {
    const jump = coverageMatrix(graph).find((r) => r.action.name === 'Jump')!;
    expect(jump.cells.every((c) => c.bound)).toBe(true);
    expect(jump.hasHole).toBe(false);
  });

  it('finds the gamepad hole', () => {
    const cancel = coverageMatrix(graph).find((r) => r.action.name === 'Cancel')!;
    expect(cancel.hasHole).toBe(true);
    expect(cancel.cells.find((c) => c.scheme === 'Gamepad')!.bound).toBe(false);
  });

  it('treats a binding with NO scheme as belonging to every scheme', () => {
    // Unity's rule, and the easy one to get backwards — a schemeless binding is
    // universal, not orphaned.
    const pause = coverageMatrix(graph).find((r) => r.action.name === 'Pause')!;
    expect(pause.cells.every((c) => c.bound)).toBe(true);
    expect(pause.hasHole).toBe(false);
  });
});
