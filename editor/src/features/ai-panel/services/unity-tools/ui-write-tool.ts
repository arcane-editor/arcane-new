/**
 * `unity_ui_write` — write a `.uxml`/`.uss` and create the `.meta` it needs.
 *
 * A new UI Toolkit file has no GUID until Unity imports it — which happens on
 * the Editor's own schedule, not this turn's. Without a GUID,
 * `<Style src="project://database/...guid=...">` cannot be built and
 * `unity_attach_ui_document` (Task 12) cannot resolve the document either, so
 * a plan that writes a `.uxml` and immediately tries to wire it up would have
 * to wait for a background import that might not even be running (Unity
 * parks its main thread while unfocused — see the harness's own
 * `unity-background-compile` history). This tool closes that gap by
 * assigning the GUID itself, the same way UI Builder's own writer would
 * (`meta-guid.ts`), and only ever creates a `.meta` when none already exists
 * — writing one over an asset Unity has already imported would be ignored.
 *
 * It also refuses to write UI Toolkit markup into a project that has
 * committed to uGUI and never asked for UI Toolkit (`ui-stack.ts`), and
 * validates the content BEFORE writing it, with the exact same checks the
 * generic write tool's asset gate (`asset-gate.ts`) runs AFTER the fact — the
 * difference here is a parse error or a genuinely missing stylesheet refuses
 * the write outright instead of reporting it once the broken file is already
 * on disk.
 *
 * Registered in `createUnityAssetMutateTools()` alongside `unity_asset_edit`
 * and `unity_input_edit`: it declares a top-level `path` + `content`, so
 * `withCheckpoint`/`withWriteApproval` cover it with no special case, and the
 * cs-gates are correctly never applied to it (it never touches `.cs`, and its
 * own validation already covers what the asset gate would re-check).
 */

import { invoke } from '@tauri-apps/api/core';
import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool } from '../vendor/types';
import { txt, cap } from './text-result';
import { resolveToCwd } from '../vendor/tools/path-utils';
import { useCheckpointsStore } from '../../../../stores/checkpoints';
import { parseUxml } from '../../../../utils/uxml-model';
import {
  checkUxml,
  checkUss,
  formatFindings,
  type AssetFinding,
  type UxmlCheckContext,
} from './asset-checks';
import {
  allocateGuid,
  buildMetaText,
  styleSrcFor,
  relativeStyleSrc,
  extractGuidFromMeta,
  type MetaKind,
} from './meta-guid';
import type { UiStack } from './ui-stack';
import { registerPendingGuidCheck } from './guid-verify';

const schema = Type.Object({
  path: Type.String({
    description: 'Project-relative .uxml or .uss path under Assets/, e.g. "Assets/UI/HUD.uxml".',
  }),
  content: Type.String({ description: 'The full file contents.' }),
  adoptUiToolkit: Type.Optional(
    Type.Boolean({
      description:
        'Required to write UI Toolkit files into a project that uses uGUI (Canvas) and has no .uxml yet. Only set it when the user asked for UI Toolkit.',
    }),
  ),
});
type Params = Static<typeof schema>;

export interface UiWriteToolDeps {
  /** Called after a successful write — see `asset-edit-tool.ts`'s `onWrite`. */
  onWrite?: (path: string) => void;
  /**
   * Snapshot the `.meta`'s pre-image (always `null` — the writer only ever
   * creates one when none exists) so a turn `Restore` removes it again. Safe
   * to call unconditionally: `stores/checkpoints.ts`'s `recordPreWrite`
   * discards calls made outside an open turn (checkpoints disabled, or no
   * session), the same guard that already protects every other write path.
   */
  recordPreWrite?: (absPath: string, beforeContent: string | null) => void;
  write: (absPath: string, content: string) => Promise<void>;
  exists: (absPath: string) => Promise<boolean>;
  /** `null` when the file does not exist or cannot be read. */
  readFile: (absPath: string) => Promise<string | null>;
  /** The project's persistent GUID index — guid -> path (Rust `unity_index_guid_map`). */
  guidMap: (workspacePath: string) => Promise<Record<string, string>>;
  /** The `checkUxml` context (declared classes, C# refs, .uss paths) — same construction `asset-gate.ts` uses. */
  snapshot: (workspacePath: string) => Promise<UxmlCheckContext>;
  /** Which UI stack the project uses (`unity-facts.ts`'s cached `UnityFacts.uiStack`). */
  stack: (workspacePath: string) => Promise<UiStack>;
}

export const defaultUiWriteDeps: UiWriteToolDeps = {
  async write(absPath, content) {
    await invoke('write_file', { path: absPath, contents: content });
  },
  exists(absPath) {
    return invoke<boolean>('path_exists', { path: absPath });
  },
  readFile(absPath) {
    return invoke<string>('read_file', { path: absPath }).catch(() => null);
  },
  guidMap(workspacePath) {
    return invoke<Record<string, string>>('unity_index_guid_map', { workspacePath });
  },
  async snapshot(workspacePath) {
    const { uxmlContext } = await import('./asset-gate');
    return uxmlContext(workspacePath);
  },
  async stack(workspacePath) {
    const { getUnityUiStack } = await import('../prompts/unity-facts');
    return getUnityUiStack(workspacePath) ?? 'none';
  },
  recordPreWrite(absPath, beforeContent) {
    useCheckpointsStore.getState().recordPreWrite(absPath, beforeContent);
  },
};

const UGUI_REFUSAL =
  'This project uses uGUI (Canvas) and has no UI Toolkit documents. Not writing UXML into it. ' +
  'If the user wants to adopt UI Toolkit, say so and call unity_ui_write with adoptUiToolkit:true.';

/** `checkUxml`'s two non-blocking codes; every other code it can emit is a parse diagnostic. */
const NON_BLOCKING_UXML_CODES = new Set(['uxml-style-missing', 'uxml-class-undeclared']);

/** Pull the path a `uxml-style-missing` finding named, out of its prose message. `null` if the shape ever changes. */
function styleMissingTarget(finding: AssetFinding): string | null {
  const m = /<Style src> points at "([^"]+)"/.exec(finding.message);
  return m ? m[1] : null;
}

function findingsList(findings: readonly AssetFinding[]): string {
  return findings.map((f) => `  • ${f.code}: ${f.message}`).join('\n');
}

/** Every `name` a parsed `.uxml` declares, in document order. */
function declaredElementNames(content: string): string[] {
  const doc = parseUxml(content);
  const out: string[] = [];
  for (const node of doc.byId.values()) {
    if (node.name) out.push(node.name);
  }
  return out;
}

/**
 * Find a readable `.meta` of the same kind already in the project, so a new
 * asset's importer settings match the project's existing ones instead of
 * resetting to Unity's bare defaults (`meta-guid.ts`'s `buildMetaText`).
 * Tries every candidate the guid map names — "if none is readable" (the
 * brief's own phrasing), not just the first one.
 */
async function findSameKindTemplate(
  kind: MetaKind,
  guidMap: Record<string, string>,
  readFile: UiWriteToolDeps['readFile'],
): Promise<string | null> {
  const ext = `.${kind}`;
  for (const path of Object.values(guidMap)) {
    if (!path.toLowerCase().endsWith(ext)) continue;
    const text = await readFile(`${path}.meta`).catch(() => null);
    if (text) return text;
  }
  return null;
}

export function createUnityUiWriteTool(
  workspacePath: string,
  deps: UiWriteToolDeps = defaultUiWriteDeps,
): AgentTool {
  // Per-tool-instance, which is per-send: `agent-service.ts` rebuilds the
  // whole tool array (`createToolsForPromptMode`) fresh at the start of every
  // send, so this Set never needs an explicit reset the way the cross-tool
  // registries in `guid-verify.ts`/`test-run-registry.ts` do — nothing else
  // needs to read it.
  const issuedThisSend = new Set<string>();

  return {
    name: 'unity_ui_write',
    label: 'unity ui write',
    description:
      'Write a .uxml or .uss file and create the .meta it needs, so <Style src> and unity_attach_ui_document ' +
      'can resolve it the same turn instead of waiting for Unity to import it. Validates before writing: a ' +
      'malformed .uxml or one whose <Style src> points at nothing that exists on disk is refused rather than ' +
      'written. Refuses to write UI Toolkit files into a project that uses uGUI (Canvas) and has none yet, ' +
      'unless adoptUiToolkit is set. Use this INSTEAD of write/unity_asset_edit for .uxml/.uss.',
    parameters: schema,
    async execute(_id, params) {
      const { path: relPath, content, adoptUiToolkit = false } = params as Params;
      const lower = relPath.toLowerCase();
      const isUxml = lower.endsWith('.uxml');
      const isUss = lower.endsWith('.uss');
      if (!isUxml && !isUss) {
        return txt(
          `unity_ui_write only writes .uxml and .uss files — use write / unity_asset_edit for ${relPath}.`,
        );
      }

      const stack = await deps.stack(workspacePath).catch(() => 'none' as UiStack);
      if (stack === 'ugui' && !adoptUiToolkit) {
        return txt(UGUI_REFUSAL);
      }

      const abs = resolveToCwd(relPath, workspacePath);

      let warnNote = '';
      if (isUxml) {
        const ctx = await deps.snapshot(workspacePath).catch(
          (): UxmlCheckContext => ({ declaredClasses: new Set(), csReferencedClasses: null, ussPaths: [] }),
        );
        const findings = checkUxml(content, ctx);

        const parseFindings = findings.filter((f) => !NON_BLOCKING_UXML_CODES.has(f.code));
        if (parseFindings.length > 0) {
          return txt(
            `Not writing ${relPath}: it does not parse as UXML, so Unity would fail to load it too.\n\n` +
              `${findingsList(parseFindings)}\n\nFix the markup and try again.`,
          );
        }

        const styleMissing = findings.filter((f) => f.code === 'uxml-style-missing');
        const unresolved: AssetFinding[] = [];
        for (const f of styleMissing) {
          const target = styleMissingTarget(f);
          const onDisk = target ? await deps.exists(resolveToCwd(target, workspacePath)) : false;
          if (!onDisk) unresolved.push(f);
        }
        if (unresolved.length > 0) {
          return txt(
            `Not writing ${relPath}: it references a stylesheet that does not exist.\n\n` +
              `${findingsList(unresolved)}\n\n` +
              'Write the .uss first (either order works), or fix the <Style src> path, and try again.',
          );
        }

        const warnFindings = findings.filter((f) => f.code === 'uxml-class-undeclared');
        if (warnFindings.length > 0) warnNote = formatFindings(relPath, warnFindings);
      } else {
        const findings = checkUss(content, relPath);
        if (findings.length > 0) warnNote = formatFindings(relPath, findings);
      }

      try {
        await deps.write(abs, content);
      } catch (e) {
        return txt(`The write to ${relPath} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      deps.onWrite?.(relPath);

      // GUID / .meta — only ever created when none exists (see this module's header).
      const metaAbs = `${abs}.meta`;
      const metaRelPath = `${relPath}.meta`;
      const metaExists = await deps.exists(metaAbs).catch(() => false);

      let guid: string | null = null;
      let metaCreated = false;
      if (metaExists) {
        const existingMeta = await deps.readFile(metaAbs);
        guid = existingMeta ? extractGuidFromMeta(existingMeta) : null;
      } else {
        const guidMap = await deps.guidMap(workspacePath).catch(() => ({}) as Record<string, string>);
        const taken = (g: string) => Object.prototype.hasOwnProperty.call(guidMap, g);
        try {
          guid = allocateGuid({ taken, issued: issuedThisSend });
        } catch {
          guid = null;
        }
        if (guid) {
          const kind: MetaKind = isUxml ? 'uxml' : 'uss';
          const template = await findSameKindTemplate(kind, guidMap, deps.readFile);
          const metaText = buildMetaText(kind, guid, template ?? undefined);
          try {
            await deps.write(metaAbs, metaText);
            metaCreated = true;
            deps.recordPreWrite?.(metaAbs, null);
            deps.onWrite?.(metaRelPath);
          } catch {
            // The content write already landed; a failed .meta write is a
            // degraded outcome to report, not a reason to undo it.
            guid = null;
          }
        }
      }

      // Only a FRESHLY allocated guid is "pending" — one read back from an
      // already-existing .meta is one Unity already confirmed by writing that
      // .meta in the first place, so there is nothing left to verify.
      if (guid && metaCreated) registerPendingGuidCheck(relPath, guid);

      const metaBaseName = metaRelPath.split('/').pop() ?? metaRelPath;
      const lines: string[] = [];
      if (guid && metaCreated) {
        lines.push(`Wrote ${relPath} (guid ${guid}) and ${metaBaseName}.`);
      } else if (guid) {
        lines.push(`Wrote ${relPath} (guid ${guid}).`);
      } else {
        lines.push(
          `Wrote ${relPath}. Its GUID is unknown — ` +
            (metaExists
              ? 'the existing .meta could not be read.'
              : 'a .meta could not be allocated/written for it, so Unity will assign one on next import.'),
        );
      }

      if (isUss) {
        const src = guid ? styleSrcFor(relPath, guid) : relativeStyleSrc(relPath);
        lines.push(`<Style src="${src}" />`);
      } else {
        const names = declaredElementNames(content);
        lines.push(
          names.length > 0
            ? `Declared element names: ${names.join(', ')}.`
            : 'No element in it declares a name yet, so nothing is reachable from C# by name.',
        );
        lines.push(
          'Next: unity_ui_layout to see how it lays out; unity_attach_ui_document to put it on a GameObject.',
        );
      }

      return txt(cap(lines.join('\n') + warnNote));
    },
  };
}
