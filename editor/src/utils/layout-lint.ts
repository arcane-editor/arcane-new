// Lint pass over a probed UI Toolkit layout.
//
// Every finding here is a bug class that compiles clean, passes every C#
// test, and is invisible to `unity_ui_toolkit`'s string-join checks: an
// element a bad flex rule pushed off the panel, text visibly clipped, a label
// unreadable against its own background, two absolutely-positioned siblings
// stacked on each other, a button too small to tap, a HUD element crowding a
// device's unsafe area. Before `unity_ui_layout` the only way to catch any of
// these was a human looking at the preview.
//
// Pure and DOM-less: it only reads the `LayoutNode[]` `layout-probe.ts`
// already measured, so it is directly testable under Bun with hand-built
// fixtures.

import type { LayoutBox, LayoutNode, LayoutProbeResult } from './layout-tree-text';

export type LintSeverity = 'error' | 'warn';

export interface LintFinding {
  severity: LintSeverity;
  code: string;
  node: LayoutNode;
  message: string;
}

export interface Size {
  width: number;
  height: number;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Effective background default when no ancestor painted one — `PreviewStage`'s
 * own stage colour (`UxmlPreviewEditor.tsx`'s `STAGE` gradient starts at
 * `#1B1726`), so the contrast check matches what a human looking at the
 * preview actually sees the label sitting on.
 */
const DEFAULT_STAGE_BG: Rgba = { r: 0x1b, g: 0x17, b: 0x26, a: 1 };

const MIN_CONTRAST = 4.5;
const MIN_BUTTON_HEIGHT = 32;
/**
 * The HUD safe-area margin, in reference-resolution px.
 *
 * Must equal the number the system prompt states as a design rule
 * (`prompts/ui-design-facts.ts`'s `DESIGN_RULES`). The two drifted — the prompt
 * asked for ≥ 24px and the lint only complained below 16 — so a HUD placed at
 * exactly 20px broke the stated rule and passed the check that exists to
 * enforce it. `ui-design-facts.test.ts` pins them together.
 */
export const HUD_EDGE_MARGIN = 24;

function label(node: LayoutNode): string {
  return node.name ? `#${node.name}` : `<${node.kind}> (${node.id})`;
}

function boxLabel(box: LayoutBox): string {
  return `[${box.x},${box.y} ${box.w}×${box.h}]`;
}

function textExcerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
}

// ── offscreen ────────────────────────────────────────────────────────────────

function isOffscreen(box: LayoutBox, panel: Size): boolean {
  return box.x + box.w <= 0 || box.x >= panel.width || box.y + box.h <= 0 || box.y >= panel.height;
}

function lintOffscreen(nodes: readonly LayoutNode[], panel: Size): LintFinding[] {
  const out: LintFinding[] = [];
  for (const node of nodes) {
    if (!isOffscreen(node.box, panel)) continue;
    out.push({
      severity: 'warn',
      code: 'offscreen',
      node,
      message: `${label(node)} ${boxLabel(node.box)} is entirely outside the ${panel.width}×${panel.height} panel.`,
    });
  }
  return out;
}

// ── zero-size-with-content ──────────────────────────────────────────────────

function hasChild(id: string, nodes: readonly LayoutNode[]): boolean {
  return nodes.some((n) => n.parentId === id);
}

function lintZeroSize(nodes: readonly LayoutNode[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const node of nodes) {
    if (node.box.w > 0 && node.box.h > 0) continue;
    const hasText = !!node.text && node.text.trim() !== '';
    if (!hasText && !hasChild(node.id, nodes)) continue;
    out.push({
      severity: 'error',
      code: 'zero-size',
      node,
      message:
        `${label(node)} ${boxLabel(node.box)} has zero ${node.box.w === 0 ? 'width' : 'height'} but ` +
        `${hasText ? 'carries text' : 'has children'} — nothing in it can be seen.`,
    });
  }
  return out;
}

// ── clipped text ─────────────────────────────────────────────────────────────

function lintClippedText(nodes: readonly LayoutNode[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const node of nodes) {
    if (!node.overflowX) continue;
    if (!node.text || node.text.trim() === '') continue;
    out.push({
      severity: 'warn',
      code: 'clipped-text',
      node,
      message: `${label(node)} ${boxLabel(node.box)} text overflows its box horizontally ("${textExcerpt(node.text)}") — it will be visually clipped.`,
    });
  }
  return out;
}

// ── contrast ─────────────────────────────────────────────────────────────────

/** Parse a computed `rgb()`/`rgba()` colour string — the form `getComputedStyle` always normalises to. */
export function parseColor(value: string | undefined): Rgba | null {
  if (!value) return null;
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value.trim());
  if (!m) return null;
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] !== undefined ? Number(m[4]) : 1,
  };
}

/** WCAG relative luminance (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance). */
function relativeLuminance({ r, g, b }: Rgba): number {
  const chan = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

/** WCAG contrast ratio between two opaque colours (1:1 .. 21:1). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Nearest ancestor (including the node itself) whose background is not
 * transparent, per the brief: "nearest ancestor with alpha > 0" — not a full
 * alpha-composite of every translucent layer above it, which would be a
 * different (and unrequested) computation. Falls back to the stage colour
 * when nothing up the chain painted one.
 */
function effectiveBackground(node: LayoutNode, byId: Map<string, LayoutNode>): Rgba {
  let cur: LayoutNode | undefined = node;
  while (cur) {
    const bg = parseColor(cur.styles.backgroundColor);
    if (bg && bg.a > 0) return bg;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return DEFAULT_STAGE_BG;
}

function lintContrast(nodes: readonly LayoutNode[], byId: Map<string, LayoutNode>): LintFinding[] {
  const out: LintFinding[] = [];
  for (const node of nodes) {
    if (!node.text || node.text.trim() === '') continue;
    const fg = parseColor(node.styles.color);
    if (!fg) continue;
    const bg = effectiveBackground(node, byId);
    const ratio = contrastRatio(fg, bg);
    if (ratio >= MIN_CONTRAST) continue;
    out.push({
      severity: 'error',
      code: 'low-contrast',
      node,
      message: `${label(node)} text contrast is ${ratio.toFixed(2)}:1 against its background — below the WCAG AA minimum of ${MIN_CONTRAST}:1.`,
    });
  }
  return out;
}

// ── overlapping absolute siblings ───────────────────────────────────────────

function boxesOverlap(a: LayoutBox, b: LayoutBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function lintOverlappingAbsolute(nodes: readonly LayoutNode[]): LintFinding[] {
  const out: LintFinding[] = [];
  const byParent = new Map<string | null, LayoutNode[]>();
  for (const n of nodes) {
    if (n.styles.position !== 'absolute') continue;
    const list = byParent.get(n.parentId);
    if (list) list.push(n);
    else byParent.set(n.parentId, [n]);
  }
  for (const siblings of byParent.values()) {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i];
        const b = siblings[j];
        if (!boxesOverlap(a.box, b.box)) continue;
        out.push({
          severity: 'warn',
          code: 'overlap',
          node: b,
          message: `${label(b)} ${boxLabel(b.box)} overlaps ${label(a)} ${boxLabel(a.box)} — both are position:absolute under the same parent.`,
        });
      }
    }
  }
  return out;
}

// ── button too small ────────────────────────────────────────────────────────

function lintButtonHeight(nodes: readonly LayoutNode[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const node of nodes) {
    if (node.kind !== 'Button') continue;
    if (node.box.h >= MIN_BUTTON_HEIGHT) continue;
    out.push({
      severity: 'warn',
      code: 'button-too-small',
      node,
      message: `${label(node)} is ${node.box.h}px tall — below the ${MIN_BUTTON_HEIGHT}px minimum touch target.`,
    });
  }
  return out;
}

// ── HUD near panel edge ──────────────────────────────────────────────────────

function isHudNode(node: LayoutNode): boolean {
  const haystack = `${node.name ?? ''} ${node.classes.join(' ')}`.toLowerCase();
  return haystack.includes('hud');
}

function lintHudEdge(nodes: readonly LayoutNode[], panel: Size): LintFinding[] {
  const out: LintFinding[] = [];
  for (const node of nodes) {
    if (!isHudNode(node)) continue;
    if (isOffscreen(node.box, panel)) continue;
    const [edge, dist] = ([
      ['left', node.box.x],
      ['top', node.box.y],
      ['right', panel.width - (node.box.x + node.box.w)],
      ['bottom', panel.height - (node.box.y + node.box.h)],
    ] as Array<[string, number]>).reduce((min, cur) => (cur[1] < min[1] ? cur : min));
    if (dist >= HUD_EDGE_MARGIN) continue;
    out.push({
      severity: 'warn',
      code: 'hud-edge',
      node,
      message: `${label(node)} sits ${Math.round(dist)}px from the ${edge} edge — inside the ${HUD_EDGE_MARGIN}px HUD safe area (the design rule asks for at least ${HUD_EDGE_MARGIN}px from every edge).`,
    });
  }
  return out;
}

// ── entry point ──────────────────────────────────────────────────────────────

export function lintLayout(result: LayoutProbeResult, panel: Size): LintFinding[] {
  const nodes = result.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return [
    ...lintOffscreen(nodes, panel),
    ...lintZeroSize(nodes),
    ...lintClippedText(nodes),
    ...lintContrast(nodes, byId),
    ...lintOverlappingAbsolute(nodes),
    ...lintButtonHeight(nodes),
    ...lintHudEdge(nodes, panel),
  ];
}
