// Scene-mutation agent tools (B4) — the first two tools that CHANGE a Unity
// scene rather than describe it: attach a UIDocument, and set one serialized
// property. Both are engine mutations, so both go through `mutate-tools.ts`'s
// `gated()` per-call human approval, exactly as unity_play/unity_refresh do.
//
// WHY THESE TWO. Every Unity turn used to end at the same wall: the agent could
// write a perfect .uxml and a perfect MonoBehaviour and then had to say "now
// drag this into the Inspector". These close that gap for the two cases that
// come up in almost every UI or tuning task.
//
// CHECKPOINTS. A Unity scene edit lives in Unity's memory, not in a file this
// IDE snapshotted, so the turn's checkpoint CANNOT restore it. Both tools call
// `recordUncheckpointedChange` on success so the checkpoint row says so instead
// of offering a restore that silently covers less than the user thinks (Global
// Constraint 2). Undo still works — in Unity's own Edit menu, which is what the
// result text tells the user.
//
// DI SEAM (Bun testability, Global Constraint 4). `gated()` reaches
// `stores/unity` and `stores/ai`, `bridgeRpc` reaches Tauri, and
// `stores/checkpoints` reaches the workspace store — all three touch `document`
// transitively, so NONE of them is a static value import here. Every runtime
// dependency arrives through `SceneMutateDeps`, whose production defaults use
// dynamic `import()` inside the call. Same seam as `read-tools.ts` and
// `ui-toolkit-tool.ts`.

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import type {
  AttachUiDocumentParams,
  AttachUiDocumentResult,
  RpcRefusal,
  SerializedValue,
  SetSerializedPropertyParams,
  SetSerializedPropertyResult,
} from '../../../unity-bridge';
import { txt } from './text-result';

/** The asset counterpart to the scene note: an asset write IS saved, because it would be lost otherwise. */
const ASSET_SAVED_NOTE = "The asset is saved. Undo is available in Unity's Edit menu.";

/**
 * How a successful mutation ends: what the user still has to do, and what Undo
 * will and will not take back.
 *
 * `createdAssets` is not decoration. Ctrl/Cmd+Z reverses the scene changes and
 * leaves a created PanelSettings or .tss on disk, so promising a bare "Undo is
 * available" after creating one is a claim the Edit menu does not honour.
 */
function closingNote(sceneDirty: boolean, createdAssets: string[] = []): string {
  const undo =
    createdAssets.length > 0
      ? `Undo (Unity's Edit menu) reverses the scene changes but not the created ` +
        `asset${createdAssets.length > 1 ? 's' : ''} at ${createdAssets.join(' and ')} — ` +
        `delete ${createdAssets.length > 1 ? 'those' : 'that'} by hand if you undo.`
      : "Undo is available in Unity's Edit menu.";
  return sceneDirty
    ? `The scene is modified but not saved — save it in Unity (Ctrl/Cmd+S). ${undo}`
    : undo;
}

/**
 * A failed RPC whose outcome is genuinely UNKNOWN rather than negative.
 *
 * Unity does not cancel a handler when the wait expires: it runs to completion
 * and its scene write lands, after the reply has already said "timed out".
 * Reporting that as a plain failure is how the turn's checkpoint row ends up
 * claiming "restorable" over a scene that really did change.
 */
function isIndeterminateFailure(message: string): boolean {
  return /timed out|timeout/i.test(message);
}

/**
 * An installed bridge older than these RPCs answers "Unknown method", which on
 * its own reads as an IDE bug. Named the way `read-tools.ts` names the same
 * situation for the console RPCs.
 */
function oldPackageNote(message: string): string | null {
  if (!/unknown method/i.test(message)) return null;
  return (
    'The installed UnityIDE bridge package predates protocol 4, which added the scene-write RPCs — ' +
    'update the package in Unity, then retry. Until then, ask the user to make this change in the Inspector.'
  );
}

/**
 * Turn a thrown RPC failure into the honest result for it: an old package says
 * so, an indeterminate failure records the change and warns, and anything else
 * is rethrown for `gated()` to report as the failure it is.
 */
async function rpcFailureResult(
  e: unknown,
  deps: SceneMutateDeps,
  onIndeterminate: { record: string; text: string },
): Promise<AgentToolResult> {
  const message = e instanceof Error ? e.message : String(e);
  const old = oldPackageNote(message);
  if (old) return txt(old);
  if (isIndeterminateFailure(message)) {
    await deps.recordUncheckpointedChange(onIndeterminate.record);
    return txt(onIndeterminate.text);
  }
  throw e;
}

/** `mutate-tools.ts`'s connection check + inline approval gate, as a dependency. */
export type GatedFn = (
  toolCallId: string,
  toolName: string,
  verb: string,
  signal: AbortSignal | undefined,
  action: () => Promise<AgentToolResult>,
) => Promise<AgentToolResult>;

export interface SceneMutateDeps {
  gated: GatedFn;
  attachUiDocument: (p: AttachUiDocumentParams) => Promise<AttachUiDocumentResult | RpcRefusal>;
  setSerializedProperty: (
    p: SetSerializedPropertyParams,
  ) => Promise<SetSerializedPropertyResult | RpcRefusal>;
  /** Marks the turn's checkpoint as not fully restorable. */
  recordUncheckpointedChange: (command: string) => Promise<void>;
}

export const defaultSceneMutateDeps: SceneMutateDeps = {
  async gated(toolCallId, toolName, verb, signal, action) {
    const { gated } = await import('./mutate-tools');
    return gated(toolCallId, toolName, verb, signal, action);
  },
  async attachUiDocument(p) {
    const { bridgeRpc } = await import('../../../unity-bridge');
    return bridgeRpc.attachUiDocument(p);
  },
  async setSerializedProperty(p) {
    const { bridgeRpc } = await import('../../../unity-bridge');
    return bridgeRpc.setSerializedProperty(p);
  },
  async recordUncheckpointedChange(command) {
    const { useCheckpointsStore } = await import('../../../../stores/checkpoints');
    useCheckpointsStore.getState().recordUncheckpointedChange(command);
  },
};

/** A bridge reply that is a refusal rather than a result. */
function isRefusal(r: { ok: boolean }): r is RpcRefusal {
  return r.ok === false;
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

// ── unity_attach_ui_document ─────────────────────────────────────────────────

const attachSchema = Type.Object({
  gameObject: Type.String({
    description: 'Hierarchy path, e.g. "UI/HUD". Created at the root if it does not exist.',
  }),
  uxmlPath: Type.String({ description: 'The .uxml to show, e.g. "Assets/UI/HUD.uxml".' }),
  panelSettingsPath: Type.Optional(
    Type.String({
      description:
        'Which PanelSettings asset to use. Omit unless the project has more than one — the ' +
        'refusal will list them.',
    }),
  ),
  sortingOrder: Type.Optional(
    Type.Number({ description: 'Draw order against other UIDocuments; higher draws on top.' }),
  ),
});
type AttachParams = Static<typeof attachSchema>;

/** How the PanelSettings choice reads to the user, so a guess never passes as a decision. */
function describePanelSettings(ps: AttachUiDocumentResult['panelSettings']): string {
  if (ps.created) return `Created the PanelSettings ${ps.path}.`;
  if (ps.confidence === 'only') return `Used ${ps.path}, this project's only PanelSettings.`;
  return `Used the PanelSettings ${ps.path}.`;
}

export function createUnityAttachUiDocumentTool(deps: SceneMutateDeps): AgentTool {
  return {
    name: 'unity_attach_ui_document',
    label: 'unity attach ui document',
    description:
      'Attach a UIDocument to a GameObject in the open Unity scene, wired to a .uxml, a ' +
      'PanelSettings and a theme (the whole chain — any missing link renders nothing and logs ' +
      'nothing). Creates the GameObject if the path does not exist. Requires user approval.',
    parameters: attachSchema,
    execute: (id, params, signal) => {
      const { gameObject, uxmlPath, panelSettingsPath, sortingOrder } = params as AttachParams;
      const verb = `attach a UIDocument (${baseName(uxmlPath)}) to "${gameObject}"`;
      return deps.gated(id, 'unity_attach_ui_document', verb, signal, async () => {
        let r: AttachUiDocumentResult | RpcRefusal;
        try {
          r = await deps.attachUiDocument({
            target: { path: gameObject },
            uxmlPath,
            ...(panelSettingsPath ? { panelSettingsPath } : {}),
            ...(sortingOrder != null ? { sortingOrder } : {}),
          });
        } catch (e) {
          return rpcFailureResult(e, deps, {
            record: 'unity: attach UIDocument (may have landed)',
            text:
              'The attach request timed out waiting for Unity, so its outcome is unknown — Unity finishes ' +
              'a scene write even after the deadline passes, so this one may have landed. Do not retry ' +
              `blindly: check with get_game_object("${gameObject}") or get_scene_hierarchy first, or you ` +
              'may end up with two UIDocuments on the same GameObject.',
          });
        }
        if (isRefusal(r)) return txt(r.reason);

        await deps.recordUncheckpointedChange(`unity: ${verb}`);

        const createdAssets: string[] = [];
        if (r.panelSettings.created) createdAssets.push(r.panelSettings.path);
        if (r.panelSettings.themeCreated && r.panelSettings.themePath) {
          createdAssets.push(r.panelSettings.themePath);
        }

        const lines = [
          `Attached a UIDocument to "${r.gameObject.path}"` +
            `${r.gameObject.created ? ' (created it)' : ''}` +
            `${r.uiDocument.created ? '' : ' — it already had one, so it was reused'}` +
            `, showing ${r.visualTreeAsset.path}.`,
          describePanelSettings(r.panelSettings),
        ];
        if (r.panelSettings.themeCreated) {
          lines.push(
            'It had no theme, so a default runtime theme was created for it — without one the UI ' +
              'renders nothing.',
          );
        }
        lines.push(closingNote(r.scene.dirty, createdAssets));
        return txt(lines.join('\n'));
      });
    },
  };
}

// ── unity_set_property ───────────────────────────────────────────────────────

const setPropertySchema = Type.Object({
  gameObject: Type.Optional(
    Type.String({ description: 'Hierarchy path of a GameObject in an open scene, e.g. "Player".' }),
  ),
  assetPath: Type.Optional(
    Type.String({ description: 'Asset to edit instead of a scene object, e.g. "Assets/Data/Enemy.asset".' }),
  ),
  component: Type.Optional(
    Type.String({ description: 'Component type name, e.g. "PlayerController". Omit for the GameObject itself.' }),
  ),
  property: Type.String({ description: 'Serialized property name, e.g. "speed" or "m_Intensity".' }),
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal('auto'),
        Type.Literal('int'),
        Type.Literal('float'),
        Type.Literal('bool'),
        Type.Literal('string'),
        Type.Literal('enum'),
        Type.Literal('objectRef'),
        Type.Literal('null'),
      ],
      { description: "How to interpret `value`. Default 'auto', which infers int/float/bool from the text." },
    ),
  ),
  value: Type.Optional(
    Type.String({
      description: 'The value as text; for objectRef pass an asset path (Assets/...) or a scene path.',
    }),
  ),
});
type SetPropertyParams = Static<typeof setPropertySchema>;

/**
 * Turn the tool's text `value` into the bridge's typed value.
 *
 * `auto` exists because the model writes `7`, not `{kind:"int",value:7}`, and a
 * schema that demanded the latter would spend turns on type bookkeeping. The
 * order matters: an integer-looking string is an int, anything else numeric is
 * a float, `true`/`false` is a bool, and everything else is a string.
 */
export function toSerializedValue(kind: SetPropertyParams['kind'], value: string | undefined): SerializedValue {
  if (kind === 'null') return { kind: 'null' };
  const raw = value ?? '';
  if (kind === 'objectRef') {
    return {
      kind: 'objectRef',
      ref: raw.startsWith('Assets/') ? { assetPath: raw } : { scenePath: raw },
    };
  }
  if (kind === 'enum') return { kind: 'enum', enumName: raw };
  if (kind === 'int') return { kind: 'int', value: Number(raw) };
  if (kind === 'float') return { kind: 'float', value: Number(raw) };
  if (kind === 'bool') return { kind: 'bool', value: /^true$/i.test(raw.trim()) };
  if (kind === 'string') return { kind: 'string', value: raw };

  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) return { kind: 'int', value: Number(trimmed) };
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return { kind: 'float', value: Number(trimmed) };
  if (/^(true|false)$/i.test(trimmed)) return { kind: 'bool', value: /^true$/i.test(trimmed) };
  return { kind: 'string', value: raw };
}

/** One serialized value as the user reads it — never a raw JSON blob when a name exists. */
export function formatPropertyValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // The bridge writes `{ name: null }` for an empty object reference and
    // `{ name }` for a filled one or an enum.
    if ('name' in o) return typeof o.name === 'string' ? o.name : 'None';
    return JSON.stringify(v);
  }
  return String(v);
}

export function createUnitySetPropertyTool(deps: SceneMutateDeps): AgentTool {
  return {
    name: 'unity_set_property',
    label: 'unity set property',
    description:
      'Set one serialized property on a component, a GameObject or an asset in the connected ' +
      'Unity Editor — the "wire it up in the Inspector" step. Reports the value before and after ' +
      'so a coerced or clamped write is visible. Requires user approval.',
    parameters: setPropertySchema,
    execute: (id, params, signal) => {
      const { gameObject, assetPath, component, property, kind = 'auto', value } =
        params as SetPropertyParams;

      // Validated before the approval prompt: asking a human to approve a call
      // that cannot run is noise, and the model can fix this without them.
      if (!gameObject && !assetPath) {
        return Promise.resolve(
          txt('unity_set_property needs a `gameObject` (a scene path) or an `assetPath`.'),
        );
      }
      if (gameObject && assetPath) {
        return Promise.resolve(
          txt(
            'unity_set_property takes either a `gameObject` or an `assetPath`, not both — ' +
              'pass the one you mean to change.',
          ),
        );
      }
      if (kind !== 'null' && value == null) {
        return Promise.resolve(
          txt("unity_set_property needs a `value` (or kind:'null' to clear an object reference)."),
        );
      }

      const shownValue = kind === 'null' ? 'null' : value;
      const where = gameObject ? `"${gameObject}"` : assetPath;
      const verb =
        `set ${component ? `${component}.` : ''}${property} = ${shownValue} on ${where}`;

      return deps.gated(id, 'unity_set_property', verb, signal, async () => {
        let r: SetSerializedPropertyResult | RpcRefusal;
        try {
          r = await deps.setSerializedProperty({
            ...(gameObject ? { target: { path: gameObject } } : {}),
            ...(assetPath ? { assetPath } : {}),
            ...(component ? { component } : {}),
            property,
            value: toSerializedValue(kind, value),
          });
        } catch (e) {
          return rpcFailureResult(e, deps, {
            record: `unity: set ${property} (may have landed)`,
            text:
              `The write to ${property} timed out waiting for Unity, so its outcome is unknown — Unity ` +
              'finishes the write even after the deadline passes, so it may have landed. Read the current ' +
              `value with ${gameObject ? `get_game_object("${gameObject}")` : `read ${assetPath}`} before ` +
              'retrying.',
          });
        }
        if (isRefusal(r)) return txt(r.reason);

        await deps.recordUncheckpointedChange(`unity: ${verb}`);

        return txt(
          `Set ${component ? `${component}.` : ''}${r.property} on ${r.target.path}: ` +
            `${formatPropertyValue(r.previous)} → ${formatPropertyValue(r.applied)} (${r.propertyType}).\n` +
            // Keyed on WHAT was written, not on whether a scene happened to be
            // dirtied: an asset write is already saved and telling the user to
            // save a scene for it is noise.
            `${r.target.isAsset ? ASSET_SAVED_NOTE : closingNote(r.sceneDirty)}`,
        );
      });
    },
  };
}

/**
 * The scene-mutation tools. Registered only in the mutating prompt modes, via
 * `createUnityMutateTools()`, which also gives them `timeoutMs: Infinity` —
 * both block on a human approval that may take minutes.
 */
export function createUnitySceneMutateTools(
  deps: SceneMutateDeps = defaultSceneMutateDeps,
): AgentTool[] {
  return [createUnityAttachUiDocumentTool(deps), createUnitySetPropertyTool(deps)];
}
