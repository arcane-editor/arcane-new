// `scene-mutate-tools.ts` takes `gated()`, `bridgeRpc` and the checkpoints
// store through an injected `SceneMutateDeps` — all three transitively reach
// `document` and none can be imported under Bun (Global Constraint 4). These
// tests exercise the tools through fake deps, the same seam
// `read-tools.test.ts` uses for `ConsoleToolDeps`.

import { describe, it, expect } from 'bun:test';
import {
  createUnitySceneMutateTools,
  toSerializedValue,
  formatPropertyValue,
  type SceneMutateDeps,
} from './scene-mutate-tools';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import type {
  AttachUiDocumentParams,
  AttachUiDocumentResult,
  SetSerializedPropertyParams,
  SetSerializedPropertyResult,
} from '../../../unity-bridge';

function textOf(res: AgentToolResult): string {
  return res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

function attachReply(over: Partial<AttachUiDocumentResult> = {}): AttachUiDocumentResult {
  return {
    ok: true,
    gameObject: { path: 'UI/HUD', instanceId: 11, created: true },
    uiDocument: { instanceId: 12, created: true },
    panelSettings: {
      path: 'Assets/UI/PanelSettings.asset',
      guid: 'aaaa',
      created: true,
      themeCreated: true,
      themePath: 'Assets/UI Toolkit/UnityThemes/UnityDefaultRuntimeTheme.tss',
      confidence: 'created',
    },
    visualTreeAsset: { path: 'Assets/UI/HUD.uxml', guid: 'bbbb' },
    scene: { path: 'Assets/Scenes/Main.unity', dirty: true },
    undoGroup: 'UnityIDE: Attach UIDocument',
    ...over,
  };
}

function setReply(over: Partial<SetSerializedPropertyResult> = {}): SetSerializedPropertyResult {
  return {
    ok: true,
    target: { path: 'Player', instanceId: 21, type: 'PlayerController', isAsset: false },
    property: 'speed',
    propertyType: 'Float',
    previous: 5,
    applied: 7,
    sceneDirty: true,
    undoGroup: 'UnityIDE: Set speed',
    ...over,
  };
}

interface Harness {
  attach: AgentTool;
  setProperty: AgentTool;
  /** Approval verbs, in call order — what the user is actually shown. */
  verbs: string[];
  attachCalls: AttachUiDocumentParams[];
  setCalls: SetSerializedPropertyParams[];
  recorded: string[];
}

function harness(over: Partial<SceneMutateDeps> = {}): Harness {
  const verbs: string[] = [];
  const attachCalls: AttachUiDocumentParams[] = [];
  const setCalls: SetSerializedPropertyParams[] = [];
  const recorded: string[] = [];
  const base: SceneMutateDeps = {
    gated: async (_id, _name, verb, _signal, action) => {
      verbs.push(verb);
      return action();
    },
    attachUiDocument: async (p) => {
      attachCalls.push(p);
      return attachReply();
    },
    setSerializedProperty: async (p) => {
      setCalls.push(p);
      return setReply();
    },
    recordUncheckpointedChange: async (c) => {
      recorded.push(c);
    },
  };
  const [attach, setProperty] = createUnitySceneMutateTools({ ...base, ...over });
  return { attach, setProperty, verbs, attachCalls, setCalls, recorded };
}

const ATTACH_ARGS = { gameObject: 'UI/HUD', uxmlPath: 'Assets/UI/HUD.uxml' };
const SET_ARGS = { gameObject: 'Player', component: 'PlayerController', property: 'speed', value: '7' };

const NOT_SAVED_NOTE =
  'The scene is modified but not saved — save it in Unity (Ctrl/Cmd+S). ' +
  "Undo is available in Unity's Edit menu.";

const CREATED_THEME_PATH = 'Assets/UI Toolkit/UnityThemes/UnityDefaultRuntimeTheme.tss';

describe('scene-mutate tools — registration', () => {
  it('registers exactly the two scene-write tools', () => {
    const h = harness();
    expect([h.attach.name, h.setProperty.name]).toEqual([
      'unity_attach_ui_document',
      'unity_set_property',
    ]);
  });
});

describe('unity_attach_ui_document', () => {
  it('asks for approval with the human-readable verb', async () => {
    const h = harness();
    await h.attach.execute('c1', ATTACH_ARGS, undefined);
    expect(h.verbs).toEqual(['attach a UIDocument (HUD.uxml) to "UI/HUD"']);
  });

  it('does nothing at all when the user rejects the approval', async () => {
    let verb = '';
    const h = harness({
      // The real `gated()` never invokes `action` on a reject — the tool must
      // therefore do ALL its work inside it, RPC and checkpoint record alike.
      gated: async (_id, _name, v) => {
        verb = v;
        return { content: [{ type: 'text', text: `User rejected the Unity action (${v}).` }] };
      },
    });

    const res = await h.attach.execute('c1', ATTACH_ARGS, undefined);

    expect(textOf(res)).toBe('User rejected the Unity action (attach a UIDocument (HUD.uxml) to "UI/HUD").');
    expect(verb).toBe('attach a UIDocument (HUD.uxml) to "UI/HUD"');
    expect(h.attachCalls).toEqual([]);
    expect(h.recorded).toEqual([]);
  });

  it("passes the caller's PanelSettings path and sorting order straight through", async () => {
    const h = harness();
    await h.attach.execute(
      'c1',
      { ...ATTACH_ARGS, panelSettingsPath: 'Assets/UI/Other.asset', sortingOrder: 3 },
      undefined,
    );
    expect(h.attachCalls[0]).toEqual({
      target: { path: 'UI/HUD' },
      uxmlPath: 'Assets/UI/HUD.uxml',
      panelSettingsPath: 'Assets/UI/Other.asset',
      sortingOrder: 3,
    });
  });

  it('omits the optional params it was not given, so Unity applies its own defaults', async () => {
    const h = harness();
    await h.attach.execute('c1', ATTACH_ARGS, undefined);
    expect(h.attachCalls[0]).toEqual({ target: { path: 'UI/HUD' }, uxmlPath: 'Assets/UI/HUD.uxml' });
  });

  it("passes a Unity refusal through verbatim and records no change", async () => {
    const h = harness({
      attachUiDocument: async () => ({
        ok: false,
        reason: 'This project has 2 PanelSettings assets — pass panelSettingsPath to say which one to use: a, b.',
      }),
    });

    const res = await h.attach.execute('c1', ATTACH_ARGS, undefined);

    expect(textOf(res)).toBe(
      'This project has 2 PanelSettings assets — pass panelSettingsPath to say which one to use: a, b.',
    );
    expect(h.recorded).toEqual([]);
  });

  it('names the PanelSettings it created and says Undo will not take the created assets back', async () => {
    const h = harness();
    const text = textOf(await h.attach.execute('c1', ATTACH_ARGS, undefined));

    expect(text).toContain('Attached a UIDocument to "UI/HUD" (created it), showing Assets/UI/HUD.uxml.');
    expect(text).toContain('Created the PanelSettings Assets/UI/PanelSettings.asset.');
    expect(text).toContain('a default runtime theme was created for it');
    expect(text).toContain('The scene is modified but not saved — save it in Unity (Ctrl/Cmd+S).');
    // Ctrl+Z does not delete a created asset, so the bare "Undo is available"
    // promise would be one the Edit menu does not keep.
    expect(text).toContain(
      "Undo (Unity's Edit menu) reverses the scene changes but not the created assets at " +
        `Assets/UI/PanelSettings.asset and ${CREATED_THEME_PATH} — delete those by hand if you undo.`,
    );
    expect(text).not.toContain("Undo is available in Unity's Edit menu.");
  });

  it('ends with the plain not-saved note when it created nothing', async () => {
    const h = harness({
      attachUiDocument: async () =>
        attachReply({
          panelSettings: {
            path: 'Assets/UI/PanelSettings.asset',
            guid: 'aaaa',
            created: false,
            themeCreated: false,
            themePath: 'Assets/UI Toolkit/UnityThemes/Existing.tss',
            confidence: 'given',
          },
        }),
    });
    const text = textOf(await h.attach.execute('c1', ATTACH_ARGS, undefined));
    expect(text.endsWith(NOT_SAVED_NOTE)).toBe(true);
  });

  it('says when it reused the project\'s only PanelSettings rather than choosing one', async () => {
    const h = harness({
      attachUiDocument: async () =>
        attachReply({
          gameObject: { path: 'UI/HUD', instanceId: 11, created: false },
          uiDocument: { instanceId: 12, created: false },
          panelSettings: {
            path: 'Assets/UI/PanelSettings.asset',
            guid: 'aaaa',
            created: false,
            themeCreated: false,
            themePath: 'Assets/UI Toolkit/UnityThemes/Existing.tss',
            confidence: 'only',
          },
        }),
    });

    const text = textOf(await h.attach.execute('c1', ATTACH_ARGS, undefined));

    expect(text).toContain("Used Assets/UI/PanelSettings.asset, this project's only PanelSettings.");
    expect(text).toContain('it already had one, so it was reused');
    expect(text).not.toContain('(created it)');
    expect(text).not.toContain('default runtime theme');
  });

  it('records the change as uncheckpointed on success, since the IDE cannot restore a scene edit', async () => {
    const h = harness();
    await h.attach.execute('c1', ATTACH_ARGS, undefined);
    expect(h.recorded).toEqual(['unity: attach a UIDocument (HUD.uxml) to "UI/HUD"']);
  });

  it('treats an RPC timeout as "may have landed" — records the change and says the outcome is unknown', async () => {
    // Unity does not cancel a handler when the wait expires: it finishes, and
    // its scene write lands, after the reply already said "timed out". A plain
    // failure here would leave the checkpoint row claiming restorable over a
    // modified scene, and would invite a retry that attaches a SECOND UIDocument.
    const h = harness({
      attachUiDocument: async () => {
        throw new Error("Unity RPC 'attachUiDocument' timed out");
      },
    });

    const text = textOf(await h.attach.execute('c1', ATTACH_ARGS, undefined));

    expect(text).toContain('did not get an answer from Unity (timeout or disconnect)');
    expect(text).toContain('MAY have landed');
    expect(text).toContain('get_game_object("UI/HUD")');
    expect(h.recorded).toEqual(['unity: attach UIDocument (may have landed)']);
  });

  it('reads the C# handler-timeout message as indeterminate too, not as a failure', async () => {
    const h = harness({
      attachUiDocument: async () => {
        throw new Error(
          "Unity RPC 'attachUiDocument' error: Main-thread RPC handler timed out after 25000ms (editor idle for 4000ms)",
        );
      },
    });
    await h.attach.execute('c1', ATTACH_ARGS, undefined);
    expect(h.recorded).toEqual(['unity: attach UIDocument (may have landed)']);
  });

  it('labels an old bridge package instead of surfacing "Unknown method", and records nothing', async () => {
    const h = harness({
      attachUiDocument: async () => {
        throw new Error("Unity RPC 'attachUiDocument' error: Unknown method: attachUiDocument");
      },
    });

    const text = textOf(await h.attach.execute('c1', ATTACH_ARGS, undefined));

    expect(text).toContain('predates protocol 4');
    expect(text).toContain('update the package in Unity');
    expect(text).not.toContain('Unknown method');
    expect(h.recorded).toEqual([]);
  });

  // R10. This test used to PIN the opposite behaviour ("lets any other RPC
  // failure through … unrecorded") with this exact message as its example.
  // `unity_ipc.rs` returns it whenever a disconnect drains the pending map —
  // the domain-reload case, in which Unity keeps running the handler and the
  // scene write lands on the far side of the reload. Reporting that as a plain
  // failure left the checkpoint row claiming the turn was restorable over a
  // scene that really had changed, and invited a retry that attaches a SECOND
  // UIDocument. It is indeterminate, exactly like a timeout.
  it('treats a mid-RPC disconnect as "may have landed" too — records the change and says the outcome is unknown', async () => {
    const h = harness({
      attachUiDocument: async () => {
        throw new Error("Unity disconnected before responding to 'attachUiDocument'");
      },
    });

    const text = textOf(await h.attach.execute('c1', ATTACH_ARGS, undefined));

    expect(text).toContain('did not get an answer from Unity (timeout or disconnect)');
    expect(text).toContain('MAY have landed');
    expect(text).toContain('get_game_object("UI/HUD")');
    expect(h.recorded).toEqual(['unity: attach UIDocument (may have landed)']);
  });

  it('still lets a genuinely different RPC failure through to the approval gate, unrecorded', async () => {
    const boom = new Error("Unity RPC 'attachUiDocument' error: target is not a GameObject");
    let seen: unknown = null;
    const h = harness({
      attachUiDocument: async () => {
        throw boom;
      },
      gated: async (_id, _name, _verb, _signal, action) => {
        try {
          return await action();
        } catch (e) {
          seen = e;
          return { content: [{ type: 'text', text: 'gated caught it' }] };
        }
      },
    });

    const text = textOf(await h.attach.execute('c1', ATTACH_ARGS, undefined));

    expect(text).toBe('gated caught it');
    expect(seen).toBe(boom);
    expect(h.recorded).toEqual([]);
  });
});

describe('unity_set_property', () => {
  it('asks for approval with the human-readable verb', async () => {
    const h = harness();
    await h.setProperty.execute('c1', SET_ARGS, undefined);
    expect(h.verbs).toEqual(['set PlayerController.speed = 7 on "Player"']);
  });

  it('does nothing at all when the user rejects the approval', async () => {
    const h = harness({
      gated: async (_id, _name, v) => ({
        content: [{ type: 'text', text: `User rejected the Unity action (${v}).` }],
      }),
    });

    const res = await h.setProperty.execute('c1', SET_ARGS, undefined);

    expect(textOf(res)).toBe('User rejected the Unity action (set PlayerController.speed = 7 on "Player").');
    expect(h.setCalls).toEqual([]);
    expect(h.recorded).toEqual([]);
  });

  it('passes a Unity refusal through verbatim and records no change', async () => {
    const h = harness({
      setSerializedProperty: async () => ({
        ok: false,
        reason: '"Player" (PlayerController) has no serialized property "speeed". It has: speed, jumpHeight.',
      }),
    });

    const res = await h.setProperty.execute('c1', { ...SET_ARGS, property: 'speeed' }, undefined);

    expect(textOf(res)).toBe(
      '"Player" (PlayerController) has no serialized property "speeed". It has: speed, jumpHeight.',
    );
    expect(h.recorded).toEqual([]);
  });

  it('reports the before and after values, the type, and the not-saved note', async () => {
    const h = harness();
    const text = textOf(await h.setProperty.execute('c1', SET_ARGS, undefined));

    expect(text).toContain('Set PlayerController.speed on Player: 5 → 7 (Float).');
    expect(text.endsWith(NOT_SAVED_NOTE)).toBe(true);
  });

  it('says an asset write was saved rather than telling the user to save a scene', async () => {
    const h = harness({
      setSerializedProperty: async () =>
        setReply({
          target: { path: 'Assets/Data/Enemy.asset', instanceId: 21, type: 'EnemyData', isAsset: true },
          // sceneDirty is deliberately left TRUE: the note must key off what was
          // written, not off a flag an asset write has no business setting.
          sceneDirty: true,
        }),
    });

    const text = textOf(
      await h.setProperty.execute(
        'c1',
        { assetPath: 'Assets/Data/Enemy.asset', property: 'speed', value: '7' },
        undefined,
      ),
    );

    expect(text).toContain("The asset is saved. Undo is available in Unity's Edit menu.");
    expect(text).not.toContain('not saved');
  });

  it('records the change as uncheckpointed on success only', async () => {
    const h = harness();
    await h.setProperty.execute('c1', SET_ARGS, undefined);
    expect(h.recorded).toEqual(['unity: set PlayerController.speed = 7 on "Player"']);
  });

  it('treats an RPC timeout as "may have landed" and tells the model to re-read before retrying', async () => {
    const h = harness({
      setSerializedProperty: async () => {
        throw new Error("Unity RPC 'setSerializedProperty' timed out");
      },
    });

    const text = textOf(await h.setProperty.execute('c1', SET_ARGS, undefined));

    expect(text).toContain('did not get an answer from Unity (timeout or disconnect)');
    expect(text).toContain('get_game_object("Player")');
    expect(h.recorded).toEqual(['unity: set speed (may have landed)']);
  });

  // R10, the write half: a disconnect mid-RPC is the domain-reload case, and
  // the write lands on the far side of the reload.
  it('treats a mid-RPC disconnect as "may have landed" too', async () => {
    const h = harness({
      setSerializedProperty: async () => {
        throw new Error("Unity disconnected before responding to 'setSerializedProperty'");
      },
    });

    const text = textOf(await h.setProperty.execute('c1', SET_ARGS, undefined));

    expect(text).toContain('did not get an answer from Unity (timeout or disconnect)');
    expect(text).toContain('MAY have landed');
    expect(h.recorded).toEqual(['unity: set speed (may have landed)']);
  });

  it('refuses, without asking for approval, when neither a gameObject nor an assetPath is given', async () => {
    const h = harness();
    const res = await h.setProperty.execute('c1', { property: 'speed', value: '7' }, undefined);

    expect(textOf(res)).toBe('unity_set_property needs a `gameObject` (a scene path) or an `assetPath`.');
    expect(h.verbs).toEqual([]);
    expect(h.setCalls).toEqual([]);
  });

  it('refuses when both a gameObject and an assetPath are given', async () => {
    const h = harness();
    const res = await h.setProperty.execute(
      'c1',
      { gameObject: 'Player', assetPath: 'Assets/Data/Enemy.asset', property: 'speed', value: '7' },
      undefined,
    );

    expect(textOf(res)).toContain('takes either a `gameObject` or an `assetPath`, not both');
    expect(h.verbs).toEqual([]);
  });

  it('refuses a missing value unless the kind is null', async () => {
    const h = harness();
    const res = await h.setProperty.execute('c1', { gameObject: 'Player', property: 'target' }, undefined);
    expect(textOf(res)).toContain('needs a `value`');
    expect(h.verbs).toEqual([]);

    await h.setProperty.execute('c1', { gameObject: 'Player', property: 'target', kind: 'null' }, undefined);
    expect(h.setCalls[0]).toEqual({
      target: { path: 'Player' },
      property: 'target',
      value: { kind: 'null' },
    });
    expect(h.verbs).toEqual(['set target = null on "Player"']);
  });

  it('omits the component when the caller did not name one', async () => {
    const h = harness();
    await h.setProperty.execute('c1', { gameObject: 'Player', property: 'm_Name', value: 'Hero' }, undefined);
    expect(h.setCalls[0]).toEqual({
      target: { path: 'Player' },
      property: 'm_Name',
      value: { kind: 'string', value: 'Hero' },
    });
    expect(h.verbs).toEqual(['set m_Name = Hero on "Player"']);
  });
});

describe("toSerializedValue — kind:'auto' inference", () => {
  it('reads a whole number as an int', () => {
    expect(toSerializedValue('auto', '7')).toEqual({ kind: 'int', value: 7 });
    expect(toSerializedValue('auto', '-42')).toEqual({ kind: 'int', value: -42 });
  });

  it('reads anything else numeric as a float', () => {
    expect(toSerializedValue('auto', '7.5')).toEqual({ kind: 'float', value: 7.5 });
    expect(toSerializedValue('auto', '-0.25')).toEqual({ kind: 'float', value: -0.25 });
  });

  it('reads true/false as a bool, whatever the case', () => {
    expect(toSerializedValue('auto', 'true')).toEqual({ kind: 'bool', value: true });
    expect(toSerializedValue('auto', 'False')).toEqual({ kind: 'bool', value: false });
  });

  it('falls back to a string, keeping the text exactly as written', () => {
    expect(toSerializedValue('auto', 'Player One')).toEqual({ kind: 'string', value: 'Player One' });
    expect(toSerializedValue('auto', ' padded ')).toEqual({ kind: 'string', value: ' padded ' });
    expect(toSerializedValue('auto', '')).toEqual({ kind: 'string', value: '' });
  });

  it('never infers when an explicit kind is given', () => {
    expect(toSerializedValue('string', '7')).toEqual({ kind: 'string', value: '7' });
    expect(toSerializedValue('float', '7')).toEqual({ kind: 'float', value: 7 });
    expect(toSerializedValue('enum', 'Trigger')).toEqual({ kind: 'enum', enumName: 'Trigger' });
  });

  it('routes an objectRef by whether the text looks like an asset path or a scene path', () => {
    expect(toSerializedValue('objectRef', 'Assets/Data/Enemy.asset')).toEqual({
      kind: 'objectRef',
      ref: { assetPath: 'Assets/Data/Enemy.asset' },
    });
    expect(toSerializedValue('objectRef', 'UI/HUD')).toEqual({
      kind: 'objectRef',
      ref: { scenePath: 'UI/HUD' },
    });
  });

  it("carries no value at all for kind:'null'", () => {
    expect(toSerializedValue('null', undefined)).toEqual({ kind: 'null' });
  });
});

describe('formatPropertyValue', () => {
  it('renders scalars plainly and quotes strings, so an empty string is visible', () => {
    expect(formatPropertyValue(7)).toBe('7');
    expect(formatPropertyValue(true)).toBe('true');
    expect(formatPropertyValue('')).toBe('""');
    expect(formatPropertyValue('Hero')).toBe('"Hero"');
  });

  it('renders an object reference by name, and an empty one as None', () => {
    expect(formatPropertyValue({ name: 'HUD', type: 'VisualTreeAsset', instanceId: 3 })).toBe('HUD');
    expect(formatPropertyValue({ name: null })).toBe('None');
  });

  it('renders a nameless composite as compact JSON rather than [object Object]', () => {
    expect(formatPropertyValue({ x: 1, y: 2 })).toBe('{"x":1,"y":2}');
    expect(formatPropertyValue(null)).toBe('null');
  });
});
