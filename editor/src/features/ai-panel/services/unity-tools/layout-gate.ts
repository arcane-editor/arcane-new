/**
 * Feed the RENDERED geometry of a design-mode write back to the model.
 *
 * `asset-gate.ts` answers "is this document well-formed?" — it parses, resolves
 * stylesheet references, and checks property names. Every one of those can pass
 * on a screen where the primary button sits at zero height, the title is
 * clipped out of its container, or the whole panel is laid out off the edge of
 * the screen. Geometry is not a string problem, so no string checker will ever
 * see it.
 *
 * `unity_ui_layout` exists for exactly this and the design prompt requires the
 * model to call it. This gate is what makes that a property of the system
 * rather than of the model's compliance: after a write lands, the session's
 * document is laid out through the same pipeline the canvas uses and any
 * error-severity finding is appended to the tool result. The model reads it on
 * its next turn and the loop re-iterates until it clears — the same mechanism,
 * and the same result shape, as the analyzer and asset gates.
 *
 * It probes the SESSION'S DOCUMENT rather than the file that was written,
 * because a `.uss` write changes the layout of every document that references
 * it and is the more common way a screen collapses.
 *
 * Most warn-severity findings are deliberately dropped: repeating design advice
 * as a gate trains the model to skim the block that also carries the errors.
 * Three are kept (`GATED_WARN_CODES`) because they describe something the
 * player cannot see or cannot read, which is a different claim from "consider
 * more margin".
 *
 * **The gate also reports STYLE COVERAGE, not just geometry** (`style-coverage.ts`).
 * A screen whose `.uxml` is full of well-chosen class names and whose stylesheet
 * declares none of them lays out perfectly: every box is the right size, the
 * lint has nothing to say, and the result is flat default grey. That was the
 * single loudest complaint about this mode, and it was invisible here because
 * geometry was the only question being asked.
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentTool } from '../vendor/types';
import { isRejectedWrite } from '../write-approval-gate';
import { resolveToCwd } from '../vendor/tools/path-utils';
import { useDesignChatStore } from '../../../../stores/design-chat';

/** The subset of a probe this gate reports on. */
export interface LayoutGateReport {
  /** Gated geometry findings, already formatted one per line. */
  problems: string[];
  /** How many elements were measured — the evidence that it ran at all. */
  elements: number;
  /**
   * The style-coverage note, or `null` when every element is painted. Null is
   * silence on purpose: a paragraph confirming a good document is a paragraph
   * that teaches the model to stop reading this block.
   */
  styling: string | null;
  /**
   * A PNG data URL of the rendered document, or `null` when it could not be
   * captured (see `render-image.ts` — every failure is null, never a blank
   * frame). Never reaches the MODEL from here: `agent-loop.ts` strips image
   * blocks out of every tool result, and the server's `role:'tool'` shape is
   * text-only. It reaches the USER through `onRender`, and the model through
   * the next send's attachments.
   */
  image: string | null;
}

/**
 * Warn-tier findings that survive the drop.
 *
 * Each describes something a player cannot see (`offscreen`), cannot read
 * (`clipped-text`), or cannot reliably hit (`button-too-small`) — outcomes, not
 * advice. `overlap` and `hud-edge` stay dropped: overlapping absolute siblings
 * and a tight safe-area margin are both legitimate often enough that gating
 * them would be noise. (`zero-size` and `low-contrast` are already errors.)
 */
const GATED_WARN_CODES: ReadonlySet<string> = new Set([
  'offscreen',
  'clipped-text',
  'button-too-small',
]);

export interface LayoutGateDeps {
  /**
   * Lay the document out and lint it, or return `null` when it could not be
   * measured at all (unreadable, unparseable, no DOM).
   */
  probe: (documentPath: string, workspacePath: string) => Promise<LayoutGateReport | null>;
  /**
   * Publish the picture. Called after every probe — with `null` when the
   * render failed — so the dock can say "could not be captured" instead of
   * quietly showing the previous turn's screen as if it were this one.
   */
  onRender: (documentPath: string, dataUrl: string | null) => void;
}

export const defaultLayoutGateDeps: LayoutGateDeps = {
  async probe(documentPath, workspacePath) {
    // Dynamic, for the reason `ui-layout-tool.ts` documents: `layout-probe.ts`
    // touches `document`/`attachShadow`/`getComputedStyle`, and the barrel that
    // exports it also pulls in React components. A static import kills the
    // DOM-less Bun suite on load alone.
    const [uitoolkit, { parseUxml }, { lintLayout }, { panelLayoutSize }] = await Promise.all([
      import('../../../uitoolkit'),
      import('../../../../utils/uxml-model'),
      import('../../../../utils/layout-lint'),
      import('../../../../utils/panel-settings'),
    ]);

    const abs = resolveToCwd(documentPath, workspacePath);
    const text = await invoke<string>('read_file', { path: abs }).catch(() => null);
    if (text === null) return null;

    const guidMap = await invoke<Record<string, string>>('unity_index_guid_map', { workspacePath })
      .catch(() => ({}) as Record<string, string>);

    const doc = parseUxml(text);
    const { sheets } = await uitoolkit.loadStyleSheets(
      doc,
      documentPath,
      workspacePath,
      async (guid: string) => guidMap[guid] ?? null,
    );
    const panel = await uitoolkit.loadPanelSettings(documentPath, workspacePath);
    const size = panel.settings ? panelLayoutSize(panel.settings, SCREEN) : SCREEN;
    const result = uitoolkit.probeLayout({ uxmlText: text, sheets, size });
    const plan = uitoolkit.buildRenderPlan(doc, sheets);
    // Rasterised from the plan the probe just measured, so the picture and the
    // numbers can never describe different documents. Null on any failure.
    const image = await uitoolkit.renderToPng(plan, size).catch(() => null);

    // Pure and cheap, and it answers the other half of "did that work": the
    // plan the probe just rendered, matched against the sheets that reached it.
    const coverage = uitoolkit.styleCoverage(plan.root, sheets);

    return {
      image,
      elements: result.nodes.length,
      problems: lintLayout(result, size)
        .filter((f) => f.severity === 'error' || GATED_WARN_CODES.has(f.code))
        .map((f) => `${f.code}: ${f.message}`),
      styling: uitoolkit.formatStyleCoverage(documentPath, coverage),
    };
  },
  onRender(documentPath, dataUrl) {
    useDesignChatStore.getState().setRender(documentPath, dataUrl);
  },
};

/** The screen a `ScaleWithScreenSize` panel scales against — the same assumption the preview and `unity_ui_layout` make. */
const SCREEN = { width: 1920, height: 1080 };

/**
 * Did this `unity_ui_write` call actually put bytes on disk?
 *
 * Deliberately NOT `write-approval-gate.ts`'s `isSuccessfulWrite`, which tests
 * for the vendor write/edit tools' `Successfully wrote …` marker.
 * `unity_ui_write` has its own result vocabulary — it answers `Wrote <path>
 * (guid …)` on success and `Not writing <path>: …` on each of its refusals —
 * so the shared predicate is FALSE for every one of its successes, and a gate
 * built on it would silently never run. (This is also why the asset gate is
 * deliberately not applied to the asset-mutate tools in agent mode: the two
 * vocabularies do not meet.)
 */
function wroteSomething(res: { content: Array<{ type: string; text?: string }> }): boolean {
  const text = res.content.find((c) => c.type === 'text')?.text ?? '';
  return /^Wrote\b/.test(text);
}

/** How many findings to spell out before counting the rest. A wall of them is not read. */
const MAX_REPORTED = 6;

/**
 * The note appended to the tool result.
 *
 * Shaped like `asset-checks.ts`'s `formatFindings` on purpose: the two read the
 * same to the model, and `compaction.ts`'s repair sentinels can protect them
 * with one mechanism.
 */
export function formatLayoutFindings(documentPath: string, report: LayoutGateReport): string {
  const shown = report.problems.slice(0, MAX_REPORTED);
  const more = report.problems.length - shown.length;
  const body = shown.map((p) => `  • ${p}`).join('\n');
  return (
    `\n\n[Unity layout] ${report.problems.length} problem(s) in the rendered layout of ${documentPath} ` +
    `(${report.elements} elements measured) — fix them before finishing:\n${body}` +
    (more > 0 ? `\n  • …and ${more} more.` : '')
  );
}

/**
 * The styling half, kept as its own labelled block rather than folded into the
 * geometry one. They are different questions with different fixes — a zero-height
 * button is a flex problem, an unstyled button is a missing rule — and a model
 * that reads one heading and acts on it should not have to disentangle them.
 */
export function formatStyleFindings(styling: string): string {
  return `\n\n[Unity styling] ${styling}`;
}

/** The note appended when the document could not be laid out at all. */
export function formatLayoutUnmeasured(documentPath: string): string {
  return (
    `\n\n[Unity layout] ${documentPath} could not be laid out for measurement, so its geometry is ` +
    'UNCHECKED — not confirmed good. Call unity_ui_layout to see why.'
  );
}

/**
 * Append the rendered geometry of `documentPath` to a successful UI write.
 *
 * `documentPath` is read at call time rather than captured, so the gate follows
 * the design session as it moves between documents.
 */
export function withLayoutGate(
  tool: AgentTool,
  workspacePath: string,
  documentPath: () => string | null,
  deps: LayoutGateDeps = defaultLayoutGateDeps,
): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const res = await tool.execute(id, params, signal, onUpdate);
      if (isRejectedWrite(res) || !wroteSomething(res)) return res;

      const written = (params as { path?: string }).path?.toLowerCase() ?? '';
      if (!written.endsWith('.uxml') && !written.endsWith('.uss')) return res;

      const target = documentPath();
      if (!target) return res;

      let report: LayoutGateReport | null;
      try {
        report = await deps.probe(target, workspacePath);
      } catch {
        // A gate that throws must not take the write down with it —
        // `asset-gate.ts` makes the same promise for the same reason.
        return res;
      }

      // Always publish, including the failure: the dock showing the PREVIOUS
      // turn's picture next to this turn's writes would be a quietly wrong
      // answer to "what did that do".
      deps.onRender(target, report?.image ?? null);

      if (report === null) {
        return {
          ...res,
          content: [...res.content, { type: 'text', text: formatLayoutUnmeasured(target) }],
        };
      }

      const text =
        (report.problems.length > 0 ? formatLayoutFindings(target, report) : '') +
        (report.styling ? formatStyleFindings(report.styling) : '');
      if (!text) return res;

      return { ...res, content: [...res.content, { type: 'text', text }] };
    },
  };
}
