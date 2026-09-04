// Asset-gate — the non-`.cs` half of the write-feedback loop.
//
// `analyzer-gate.ts` runs the Unity analyzers on a `.cs` write and appends any
// error-severity findings to the tool result, so the agent self-corrects on its
// next turn. It early-returns on every other extension, which left the four
// Unity formats the editor treats as first class — `.uxml`, `.uss`,
// `.inputactions` and `.asset` — with no feedback at all. This gate is the same
// decorator for those four.
//
// It repeats `analyzer-gate.ts`'s two guards deliberately. `isRejectedWrite`
// keeps a user-rejected write inert; `isSuccessfulWrite` keeps a write that
// failed for any OTHER reason inert too. Without the second one a gate reports
// findings for content that never reached the disk — the bug
// `write-approval-gate.ts`'s header documents across all three cs-gates.
//
// The checking itself is pure and lives in `asset-checks.ts`, which imports only
// leaf modules and is therefore directly testable under Bun. Only the snapshot
// lookup and the asset read happen here.

import { invoke } from '@tauri-apps/api/core';
import type { AgentTool } from '../vendor/types';
import { tauriReadOperations } from '../tool-operations';
import { resolveToCwd } from '../vendor/tools/path-utils';
import { isRejectedWrite, isSuccessfulWrite } from '../write-approval-gate';
import {
  checkUxml,
  checkUss,
  checkInputActions,
  checkAssetDocument,
  formatFindings,
  isCheckableAsset,
  type AssetFinding,
  type UxmlCheckContext,
} from './asset-checks';

/** Workspace-relative path, to match `<Style src>`'s `project://` form. */
function relative(absPath: string, cwd: string): string {
  const base = (cwd.endsWith('/') ? cwd : `${cwd}/`).replace(/\\/g, '/');
  const p = absPath.replace(/\\/g, '/');
  return p.toLowerCase().startsWith(base.toLowerCase()) ? p.slice(base.length) : p;
}

/**
 * The project context the UXML check needs.
 *
 * Reached through a dynamic `import()` for the reason `input-actions-tool.ts`
 * documents at its own seam: the `unity-analyzers` barrel pulls Monaco, and a
 * static import would drag `stores/theme.ts` into the DOM-less runtime.
 * Failure yields the neutral context, which makes the gate quieter, never
 * louder.
 *
 * Exported for `ui-write-tool.ts`'s default deps: `unity_ui_write` validates
 * a `.uxml` write with the exact same `checkUxml` context this gate builds
 * for a raw one, so the two can never disagree about which `.uss` paths or
 * declared classes exist.
 */
export async function uxmlContext(cwd: string): Promise<UxmlCheckContext> {
  try {
    const mod = await import('../../../unity-analyzers');
    const uss = mod.getUssIndex();
    const csRefs = mod.getCsUiRefIndex();
    return {
      declaredClasses: new Set(uss?.allClasses ?? []),
      // Null until the project-wide walk lands — the check stays silent, which
      // is the correct failure mode for a suppressor.
      csReferencedClasses: csRefs.loaded ? csRefs.referencedClasses : null,
      ussPaths: [...(uss?.docs.keys() ?? [])].map((p) => relative(p, cwd)),
    };
  } catch {
    return { declaredClasses: new Set(), csReferencedClasses: null, ussPaths: [] };
  }
}

async function findingsFor(
  absPath: string,
  relPath: string,
  content: string,
  cwd: string,
): Promise<AssetFinding[]> {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.uxml')) return checkUxml(content, await uxmlContext(cwd));
  if (lower.endsWith('.uss')) return checkUss(content, relPath);
  if (lower.endsWith('.inputactions')) return checkInputActions(content);
  if (lower.endsWith('.asset')) {
    // Read it back through the same Rust reader the inspector uses, rather than
    // re-implementing Unity YAML here — a second parser would have to agree
    // with the writer forever (`asset-fields-client.ts`).
    try {
      const snapshot = await invoke<{ classId: string; scriptGuid: string | null }>(
        'unity_asset_read_fields',
        { path: absPath },
      );
      return checkAssetDocument(snapshot);
    } catch {
      return checkAssetDocument(null);
    }
  }
  return [];
}

/**
 * Validate a write to a Unity asset the analyzers do not cover, and feed any
 * problems back into the tool result.
 */
export function withUnityAssetGate(tool: AgentTool, cwd: string): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const res = await tool.execute(id, params, signal, onUpdate);
      if (isRejectedWrite(res)) return res;
      // Only a write that LANDED is worth checking. Checking `params.content`
      // for a write that failed reports findings for content the model merely
      // proposed — see the header.
      if (!isSuccessfulWrite(res)) return res;

      const p = (params as { path?: string }).path;
      if (!p || !isCheckableAsset(p)) return res;

      const abs = resolveToCwd(p, cwd);
      // `write` carries the content; `edit` does not, so re-read from disk.
      const content =
        (params as { content?: string }).content ??
        (await tauriReadOperations.readFile(abs).catch(() => null));
      if (content == null) return res;

      let findings: AssetFinding[];
      try {
        findings = await findingsFor(abs, relative(abs, cwd), content, cwd);
      } catch {
        // A gate that throws must not take the write down with it.
        return res;
      }

      // The raw write/edit tool has no idea `.uxml`/`.uss` have a purpose-built
      // writer — one that also creates the `.meta` a brand-new file needs
      // before `<Style src>`/`unity_attach_ui_document` can resolve it the
      // same turn (`ui-write-tool.ts`). Nudge every raw write toward it, not
      // just the ones with findings: a clean write is exactly the case where
      // the missing `.meta` is the only problem.
      const lowerP = p.toLowerCase();
      const isUiAsset = lowerP.endsWith('.uxml') || lowerP.endsWith('.uss');
      const tip = isUiAsset
        ? '\n\nTip: unity_ui_write also creates the .meta and validates before writing.'
        : '';
      if (findings.length === 0 && !tip) return res;

      const text = (findings.length > 0 ? formatFindings(p, findings) : '') + tip;
      return {
        ...res,
        content: [...res.content, { type: 'text', text }],
      };
    },
  };
}
