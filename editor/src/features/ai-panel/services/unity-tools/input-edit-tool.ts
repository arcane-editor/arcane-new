/**
 * `unity_input_edit` — change an `.inputactions` asset safely.
 *
 * The Input Actions editor in this app deliberately refuses raw text editing of
 * a parseable `.inputactions` (`InputActionsEditor.tsx`), for a reason that
 * applies at least as strongly to an agent: the format carries `id` GUIDs that
 * Unity matches actions and bindings by. Renaming an action keeps every
 * Inspector reference alive precisely because the id is stable — and a hand
 * edit that drops, duplicates or re-orders one breaks references silently, in
 * scenes and prefabs that will not be opened until later.
 *
 * So every operation here goes through the model in
 * `utils/inputactions-model.ts`, whose round-trip contract is
 * `serializeInputActions(parseInputActions(text)) === text`. Unknown fields
 * Unity adds between versions survive untouched, the file's own indentation is
 * replayed, and a one-binding change stays a one-line diff.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { txt } from './text-result';
import {
  parseInputActions,
  serializeInputActions,
  addAction,
  addBinding,
  setBindingPath,
  listActions,
  findBindingConflicts,
} from '../../../../utils/inputactions-model';

const schema = Type.Object({
  path: Type.String({
    description: 'The .inputactions asset to change, e.g. "Assets/InputSystem_Actions.inputactions".',
  }),
  operation: Type.Union(
    [Type.Literal('add-action'), Type.Literal('add-binding'), Type.Literal('set-binding-path')],
    {
      description:
        'add-action: a new action in an existing map, optionally with bindings. add-binding: one more control on an existing action. set-binding-path: rebind an existing binding by its id.',
    },
  ),
  map: Type.Optional(
    Type.String({ description: 'Action map name. Required for add-action and add-binding.' }),
  ),
  action: Type.Optional(
    Type.String({ description: 'Action name. Required for add-action and add-binding.' }),
  ),
  controlPath: Type.Optional(
    Type.String({
      description:
        'Unity control path, e.g. "<Keyboard>/space" or "<Gamepad>/buttonSouth". Required for add-binding and set-binding-path.',
    }),
  ),
  bindingId: Type.Optional(
    Type.String({ description: 'The binding id to rebind. Required for set-binding-path.' }),
  ),
  actionType: Type.Optional(
    Type.Union([Type.Literal('Button'), Type.Literal('Value'), Type.Literal('PassThrough')], {
      description: 'Action type for add-action. Defaults to Button.',
    }),
  ),
  expectedControlType: Type.Optional(
    Type.String({
      description:
        'For add-action: the control type, e.g. "Button", "Vector2", "Axis". ReadValue<T>() must agree with this or it throws at runtime.',
    }),
  ),
  controlPaths: Type.Optional(
    Type.Array(Type.String(), {
      description: 'For add-action: control paths to bind immediately.',
    }),
  ),
  groups: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Control scheme names the new binding belongs to, e.g. ["Gamepad"]. Omit to make it available in every scheme.',
    }),
  ),
});
type Params = Static<typeof schema>;

export interface InputEditToolDeps {
  /** Called after a successful write — see `asset-edit-tool.ts`'s `onWrite`. */
  onWrite?: (path: string) => void;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
}

export const defaultInputEditDeps: InputEditToolDeps = {
  async readFile(path) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('read_file', { path });
  },
  async writeFile(path, contents) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_file', { path, contents });
  },
};

export function createUnityInputEditTool(deps: InputEditToolDeps = defaultInputEditDeps): AgentTool {
  return {
    name: 'unity_input_edit',
    label: 'unity input edit',
    description:
      'Add an action, add a binding, or rebind a control in a Unity .inputactions asset. ' +
      'Round-trips the file through its own format — ids, unknown fields and indentation are preserved, ' +
      'so the diff is only what you changed. ' +
      'Use this INSTEAD of the edit tool for .inputactions: the format carries the GUIDs Unity matches ' +
      'actions and bindings by, and a text edit that drops or duplicates one breaks Inspector references ' +
      'in scenes and prefabs with no error anywhere. Call unity_input_actions first for the existing ' +
      'maps, actions and control schemes.',
    parameters: schema,
    async execute(_id, params) {
      const p = params as Params;

      let text: string;
      try {
        text = await deps.readFile(p.path);
      } catch (e) {
        return txt(`Could not read ${p.path}: ${e instanceof Error ? e.message : String(e)}`);
      }

      const parsed = parseInputActions(text);
      if (!parsed.doc) {
        return txt(
          `${p.path} does not parse as an .inputactions asset (${parsed.error}). ` +
            'It must be repaired before it can be edited — Unity cannot load it either.',
        );
      }

      let next = parsed;
      let summary: string;

      switch (p.operation) {
        case 'add-action': {
          if (!p.map || !p.action) return txt('add-action needs both `map` and `action`.');
          const result = addAction(parsed, {
            mapName: p.map,
            actionName: p.action,
            type: p.actionType,
            expectedControlType: p.expectedControlType,
            bindings: p.controlPaths ?? (p.controlPath ? [p.controlPath] : []),
            groups: p.groups,
          });
          if (result.error) return txt(`Nothing changed: ${result.error}.`);
          next = result.parsed;
          const bound = p.controlPaths ?? (p.controlPath ? [p.controlPath] : []);
          summary =
            `Added action ${p.map}/${p.action} (${p.actionType ?? 'Button'})` +
            (bound.length > 0 ? ` bound to ${bound.join(', ')}` : ' with no bindings yet');
          break;
        }
        case 'add-binding': {
          if (!p.map || !p.action || !p.controlPath) {
            return txt('add-binding needs `map`, `action` and `controlPath`.');
          }
          const result = addBinding(parsed, {
            mapName: p.map,
            actionName: p.action,
            path: p.controlPath,
            groups: p.groups,
          });
          if (result.error) return txt(`Nothing changed: ${result.error}.`);
          next = result.parsed;
          summary = `Bound ${p.controlPath} to ${p.map}/${p.action}`;
          break;
        }
        case 'set-binding-path': {
          if (!p.bindingId || !p.controlPath) {
            return txt('set-binding-path needs `bindingId` and `controlPath`.');
          }
          const before = JSON.stringify(parsed.doc);
          next = setBindingPath(parsed, p.bindingId, p.controlPath);
          if (JSON.stringify(next.doc) === before) {
            return txt(
              `No binding with id "${p.bindingId}" in ${p.path}. Call unity_input_actions to list the ` +
                'bindings and their ids.',
            );
          }
          summary = `Rebound ${p.bindingId} to ${p.controlPath}`;
          break;
        }
      }

      const serialized = serializeInputActions(next);
      try {
        await deps.writeFile(p.path, serialized);
      } catch (e) {
        return txt(`The write to ${p.path} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      deps.onWrite?.(p.path);

      const out = [`${summary}.`];

      // A new binding on a control another action already claims is the exact
      // failure this whole subsystem exists to surface: it compiles, it saves,
      // and one of the two actions silently never fires.
      const conflicts = next.doc ? findBindingConflicts(next.doc) : [];
      if (conflicts.length > 0) {
        out.push('', 'Binding conflicts now present (declaration order decides the winner):');
        for (const c of conflicts.slice(0, 10)) {
          out.push(`  ${c.path} — ${c.winner} wins, starved: ${c.starved.join(', ')}`);
        }
      }

      if (p.operation === 'add-action') {
        const action = next.doc
          ? listActions(next.doc).find((a) => a.mapName === p.map && a.name === p.action)
          : undefined;
        if (action) {
          out.push(
            '',
            `Reach it as FindAction("${action.qualifiedName}")` +
              (action.expectedControlType
                ? `, and ReadValue<${action.expectedControlType}> must match its control type.`
                : '. It has no expectedControlType, so ReadValue<T> is unchecked — set one if it is a Value action.'),
            'If the asset generates a wrapper class, Unity regenerates it on the next asset refresh; ' +
              'the new property is not available to C# until then.',
          );
        }
      }

      return txt(out.join('\n'));
    },
  };
}
