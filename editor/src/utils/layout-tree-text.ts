// A UI Toolkit layout, as text — the agent's own view of what its UXML/USS
// actually lays out to, without a screenshot.
//
// `features/uitoolkit/services/layout-probe.ts` does the real measuring, in a
// real DOM (an offscreen host + shadow root), which is why this module does
// not: it only formats a `LayoutProbeResult` the probe already collected.
// Splitting it out this way is what lets `unity_ui_layout`'s tool tests and
// `layout-lint.ts` run under Bun with a hand-built fixture, with neither of
// them needing `document` to exist.
//
// A leaf module: no imports, so it loads under Bun's DOM-less test runtime.

export interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The `getComputedStyle` pick `layout-probe.ts` reads off each node. */
export interface LayoutNodeStyles {
  display?: string;
  flexDirection?: string;
  justifyContent?: string;
  alignItems?: string;
  flexGrow?: string;
  width?: string;
  height?: string;
  padding?: string;
  margin?: string;
  backgroundColor?: string;
  color?: string;
  fontSize?: string;
  opacity?: string;
  position?: string;
  overflow?: string;
}

export interface LayoutNode {
  /** The source `UxmlNode`/`RenderNode` id (dot-chained, e.g. `0.1.2`). */
  id: string;
  /** `null` for the document root. */
  parentId: string | null;
  /** The `name` attribute — `null` for an unnamed element. */
  name: string | null;
  /** Element type/tag, e.g. `"Button"`, `"VisualElement"`, `"Label"`. */
  kind: string;
  classes: string[];
  /** 0 for the root. */
  depth: number;
  /** Host-relative, in CSS pixels at the panel's layout size. */
  box: LayoutBox;
  styles: LayoutNodeStyles;
  text: string | null;
  /** `scrollWidth > clientWidth` — this node's own content overflows it horizontally. */
  overflowX: boolean;
}

export interface LayoutProbeResult {
  /** Depth-first, parent before children — the order both the tree text and the lint walk in. */
  nodes: LayoutNode[];
  /** True when the walk stopped at `maxNodes` before the real tree finished. */
  truncated: boolean;
}

/** `probeLayout`'s own default, re-exported so the tool never hardcodes it twice. */
export const DEFAULT_MAX_NODES = 400;
/** `renderLayoutTree`'s own default depth. */
export const DEFAULT_MAX_DEPTH = 6;

const MAX_OUTPUT_CHARS = 6_000;
const TEXT_EXCERPT_MAX = 40;

/**
 * The "key styles" shown inline when `includeStyles` is set — layout-deciding
 * properties, not the full computed-style pick (`layout-lint.ts` reads the
 * rest, e.g. `color`/`backgroundColor`, off the same node for contrast).
 */
const TREE_STYLE_KEYS: Array<keyof LayoutNodeStyles> = [
  'display',
  'flexDirection',
  'justifyContent',
  'alignItems',
  'flexGrow',
  'position',
];

/** `flexDirection` -> `flex-direction`, so the line reads like real USS/CSS. */
function cssKey(key: keyof LayoutNodeStyles): string {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function styleSuffix(styles: LayoutNodeStyles): string {
  const parts: string[] = [];
  for (const key of TREE_STYLE_KEYS) {
    const value = styles[key];
    if (value) parts.push(`${cssKey(key)}:${value}`);
  }
  return parts.length > 0 ? ` {${parts.join('; ')}}` : '';
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TEXT_EXCERPT_MAX) return trimmed;
  return `${trimmed.slice(0, TEXT_EXCERPT_MAX - 1)}…`;
}

function nodeLine(node: LayoutNode, includeStyles: boolean): string {
  const indent = '  '.repeat(node.depth);
  const label = node.name || '#anon';
  const classSuffix = node.classes.length > 0 ? `.${node.classes.join('.')}` : '';
  const box = `[${node.box.x},${node.box.y} ${node.box.w}×${node.box.h}]`;
  const text = node.text && node.text.trim() !== '' ? ` "${excerpt(node.text)}"` : '';
  return `${indent}${label} ${node.kind}${classSuffix} ${box}${includeStyles ? styleSuffix(node.styles) : ''}${text}`;
}

/**
 * One line per node, indented by depth. Capped at 6,000 characters — this is a
 * tool result, not a file — with a `… (N more nodes)` trailer naming how many
 * nodes the cap left out. `maxDepth` trims the view on purpose (a deep HUD
 * tree is mostly noise past a few levels) and nodes it excludes are not
 * counted in that trailer, unlike nodes the character cap cuts off.
 */
export function renderLayoutTree(
  result: LayoutProbeResult,
  opts: { maxDepth?: number; includeStyles?: boolean } = {},
): string {
  const { maxDepth = DEFAULT_MAX_DEPTH, includeStyles = false } = opts;
  const eligible = result.nodes.filter((n) => n.depth <= maxDepth);
  if (eligible.length === 0) return '(no elements)';

  const lines: string[] = [];
  let chars = 0;
  let cutAt = -1;

  for (let i = 0; i < eligible.length; i++) {
    const line = nodeLine(eligible[i], includeStyles);
    const added = line.length + 1; // +1 for the newline that will join it
    // Always render at least one line, even an oversized first one — an empty
    // result would be a worse answer than one line over budget.
    if (chars + added > MAX_OUTPUT_CHARS && lines.length > 0) {
      cutAt = i;
      break;
    }
    lines.push(line);
    chars += added;
  }

  let out = lines.join('\n');
  if (cutAt !== -1) {
    const more = eligible.length - cutAt;
    out += `\n… (${more} more node${more === 1 ? '' : 's'})`;
  }
  return out;
}
