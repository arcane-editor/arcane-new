// The agent's own view of its own layout — the same render pipeline the human
// preview (`PreviewStage.tsx`) uses, run offscreen and measured instead of
// painted.
//
// A UXML/USS pair can compile clean, pass every C# test, and still lay out
// wrong: a flex rule that pushes a HUD element off the panel, a class typo
// that leaves a label at its default (invisible) size, a colour combination
// nobody previewed. None of that shows up anywhere the agent can already look
// -- `unity_ui_toolkit` sees the string joins, not the geometry. This module
// is what closes that gap: build the exact DOM `PreviewStage` would render,
// force one layout pass, and read back what the browser actually decided.
//
// Real DOM only -- `document.createElement`, `attachShadow`, `getComputedStyle`
// -- so this is never imported directly under Bun; `ui-layout-tool.ts` reaches
// it through a dynamic `import()` of the `uitoolkit` barrel, exactly like
// `loadStyleSheets`/`loadPanelSettings`. Its own coverage is the injected
// `probe` seam in `ui-layout-tool.test.ts`, not a Bun test of this file.

import { parseUxml } from '../../../utils/uxml-model';
import type { UssStyleSheet } from '../../../utils/uss-model';
import {
  DEFAULT_MAX_NODES,
  type LayoutNode,
  type LayoutNodeStyles,
  type LayoutProbeResult,
} from '../../../utils/layout-tree-text';
import { buildRenderPlan, type RenderNode } from './render-plan';

export interface ProbeLayoutOptions {
  uxmlText: string;
  sheets: readonly UssStyleSheet[];
  size: { width: number; height: number };
  /** Defaults to {@link DEFAULT_MAX_NODES}. */
  maxNodes?: number;
}

export interface ProbeLayoutOutput extends LayoutProbeResult {
  /** The plan's own honesty strip -- built-in theme approximation, unresolved stylesheets. */
  notes: string[];
}

/** `render-plan.ts`'s own synthetic classes (`ELEMENT_CLASS`, the type chain, inline-style classes) — machinery, not content. */
const SYNTHETIC_CLASS = /^u-(el|t-|i-)/;

function visibleClasses(classes: readonly string[]): string[] {
  return classes.filter((c) => !SYNTHETIC_CLASS.test(c));
}

/**
 * Build the DOM `PreviewStage`'s own `Element` component would, one non-React
 * div per `RenderNode`: classes joined, `name` as a real `id`, `data-u-id` for
 * traceability, text as content. `elById` is filled as a side effect so the
 * measurement pass below can look a node's element up by id in O(1) rather
 * than re-querying the shadow root per node.
 */
function renderDom(node: RenderNode, elById: Map<string, HTMLElement>): HTMLElement {
  const el = document.createElement('div');
  el.className = node.classes.join(' ');
  if (node.name) el.id = node.name;
  el.setAttribute('data-u-id', node.id);
  if (node.text) el.textContent = node.text;
  elById.set(node.id, el);
  for (const child of node.children) {
    el.appendChild(renderDom(child, elById));
  }
  return el;
}

function pickStyles(cs: CSSStyleDeclaration): LayoutNodeStyles {
  return {
    display: cs.display,
    flexDirection: cs.flexDirection,
    justifyContent: cs.justifyContent,
    alignItems: cs.alignItems,
    flexGrow: cs.flexGrow,
    width: cs.width,
    height: cs.height,
    padding: cs.padding,
    margin: cs.margin,
    backgroundColor: cs.backgroundColor,
    color: cs.color,
    fontSize: cs.fontSize,
    opacity: cs.opacity,
    position: cs.position,
    overflow: cs.overflow,
  };
}

/**
 * Lay `uxmlText` + `sheets` out at `size` and measure every element.
 *
 * The host is `position:fixed` off the left edge of the viewport (never
 * `display:none` -- a display:none subtree never lays out at all, which is
 * the one thing this function exists to force) and `contain:strict`, so the
 * measurement can never affect, or be affected by, whatever the IDE itself is
 * showing at the moment the agent asks for this.
 */
export function probeLayout(opts: ProbeLayoutOptions): ProbeLayoutOutput {
  const { uxmlText, sheets, size, maxNodes = DEFAULT_MAX_NODES } = opts;
  const doc = parseUxml(uxmlText);
  const plan = buildRenderPlan(doc, sheets);

  const host = document.createElement('div');
  host.style.cssText =
    `position:fixed; left:-100000px; top:0; width:${size.width}px; height:${size.height}px; ` +
    'contain:strict; overflow:hidden;';
  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = plan.css;
  shadow.appendChild(styleEl);

  const nodes: LayoutNode[] = [];
  let truncated = false;

  try {
    document.body.appendChild(host);

    const elById = new Map<string, HTMLElement>();
    if (plan.root) shadow.appendChild(renderDom(plan.root, elById));

    // Force layout before any measurement -- appending the host and its
    // subtree above only schedules it; reading a geometry property is what
    // actually flushes it.
    const hostRect = host.getBoundingClientRect();

    const walk = (node: RenderNode, depth: number, parentId: string | null): boolean => {
      if (nodes.length >= maxNodes) {
        truncated = true;
        return false;
      }
      const el = elById.get(node.id);
      if (el) {
        const rect = el.getBoundingClientRect();
        nodes.push({
          id: node.id,
          parentId,
          name: node.name,
          kind: node.tag,
          classes: visibleClasses(node.classes),
          depth,
          box: {
            x: Math.round(rect.left - hostRect.left),
            y: Math.round(rect.top - hostRect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          styles: pickStyles(getComputedStyle(el)),
          text: node.text,
          overflowX: el.scrollWidth > el.clientWidth,
        });
      }
      for (const child of node.children) {
        if (!walk(child, depth + 1, node.id)) return false;
      }
      return true;
    };

    if (plan.root) walk(plan.root, 0, null);
  } finally {
    host.remove();
  }

  return { nodes, truncated, notes: plan.notes };
}
