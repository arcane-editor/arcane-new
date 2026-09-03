import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RenderNode } from '../services/render-plan';

/**
 * The containment seam. The ONLY place in this app that calls `attachShadow`.
 *
 * **Why a shadow root and not a scoped class prefix.** The preview renders the
 * user's USS, which includes selectors like `*` and `VisualElement`. In the
 * light DOM those would style the IDE itself, and the IDE's own rules would
 * style the preview right back — `App.css` sets `* { margin: 0; padding: 0 }`,
 * a 13px root font, themed scrollbars and a focus-visible outline, none of
 * which belong in a Unity panel. A prefix beats none of that without an
 * `!important` arms race.
 *
 * **What a shadow root does not block**, and what `render-plan`'s reset handles
 * instead: inherited properties (`font-family`, `color`, `white-space`) cross
 * the boundary, so `:host` carries `all: initial` plus a restore; and custom
 * properties cross AND survive `all`, which is why `compileSelector` rewrites
 * `:root` to `:host` so the document's own definitions land where they win.
 *
 * The interface is deliberately narrow — CSS string in, DOM out — so swapping to
 * an iframe later is one file.
 */
export function PreviewStage({
  css,
  root,
  selectedId,
  onSelect,
  scale = 1,
  showBoxes = false,
}: {
  css: string;
  root: RenderNode | null;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /**
   * The stage's display scale.
   *
   * The document is laid out at its reference resolution and the whole thing is
   * then scaled to fit, so every length in here is divided by this on the way
   * to the screen. Selection chrome authored in plain pixels arrives at half a
   * pixel — which is exactly how a 1px outline managed to be invisible.
   */
  scale?: number;
  /** Outline every element, for finding the containers you cannot see. */
  showBoxes?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || shadow) return;
    // `attachShadow` throws if called twice on the same element, and React 19
    // strict mode runs effects twice in development.
    setShadow(host.shadowRoot ?? host.attachShadow({ mode: 'open' }));
  }, [shadow]);

  // The selected element's laid-out box, read back after render. `offsetWidth`
  // is layout pixels — the transform does not touch it — so these are the
  // numbers the document really produced at its reference resolution.
  // State is set through a comparison so a measurement that has not changed
  // cannot start a render loop.
  useEffect(() => {
    const el =
      shadow && selectedId
        ? (shadow.querySelector(`[data-u-id="${CSS.escape(selectedId)}"]`) as HTMLElement | null)
        : null;
    const next = el ? { width: Math.round(el.offsetWidth), height: Math.round(el.offsetHeight) } : null;
    setSize((prev) =>
      prev?.width === next?.width && prev?.height === next?.height ? prev : next,
    );
  }, [shadow, selectedId, css, root]);

  const label = selectionLabel(root, selectedId, size);

  return (
    <div ref={hostRef} style={{ ...HOST, ['--u-scale' as string]: scale }}>
      {shadow &&
        createPortal(
          <>
            <style>{css}</style>
            {/* Before the selection chrome, not after: `.u-el` and `.u-selected`
                tie on specificity, so whichever block comes last wins the
                outline — and boxes-on would erase the selection. */}
            {showBoxes && <style>{BOXES_CSS}</style>}
            <style>{SELECTION_CSS}</style>
            {root ? (
              <Element
                node={root}
                selectedId={selectedId}
                onSelect={onSelect}
                label={label}
                isRoot
              />
            ) : null}
          </>,
          shadow,
        )}
    </div>
  );
}

/** `#play-button · Button · 420 × 34` — what the badge on the canvas says. */
function selectionLabel(
  root: RenderNode | null,
  selectedId: string | null | undefined,
  size: { width: number; height: number } | null,
): string | null {
  if (!root || !selectedId) return null;
  let hit: RenderNode | null = null;
  (function walk(node: RenderNode) {
    if (hit) return;
    if (node.id === selectedId) hit = node;
    else node.children.forEach(walk);
  })(root);
  if (!hit) return null;
  const node: RenderNode = hit;
  const name = node.name ? `#${node.name}` : node.tag;
  const measured = size ? ` · ${size.width} × ${size.height}` : '';
  return `${name}${node.name ? ` · ${node.tag}` : ''}${measured}`;
}

function Element({
  node,
  selectedId,
  onSelect,
  label,
  isRoot,
}: {
  node: RenderNode;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  label?: string | null;
  isRoot?: boolean;
}) {
  const selected = selectedId === node.id;
  const classes = [...node.classes];
  if (selected) classes.push('u-selected');
  if (isRoot) classes.push('u-root');

  return (
    <div
      className={classes.join(' ')}
      // `name` becomes a real id so `#play-button` keeps Unity's id specificity.
      id={node.name ?? undefined}
      data-u-id={node.id}
      // Read by the badge through `content: attr(...)`, so naming the selection
      // costs no extra element and cannot disturb the document's layout.
      data-u-label={selected && label ? label : undefined}
      onClick={
        onSelect
          ? (e) => {
              e.stopPropagation();
              onSelect(node.id);
            }
          : undefined
      }
    >
      {node.text}
      {node.children.map((child) => (
        <Element
          key={child.id}
          node={child}
          selectedId={selectedId}
          onSelect={onSelect}
          label={label}
        />
      ))}
    </div>
  );
}

/**
 * Selection chrome, kept out of `render-plan` because it is ours rather than
 * the document's — a USS rule must never be able to fight it. It cannot: USS
 * has no `outline` property at all, so nothing the user writes reaches these.
 *
 * Every length divides by `--u-scale`. The stage lays the document out at 1920
 * and scales the result to fit, so an outline authored as `1px` arrives on a
 * 960px stage as half a pixel — which is why the previous selection outline
 * was, correctly, impossible to see.
 *
 * `:not(:has(...))` picks the INNERMOST element under the pointer. Without it
 * every ancestor matches `:hover` too and the whole chain lights up, which
 * reads as noise rather than as "this is what you are about to select". Where
 * `:has` is unsupported the selector simply never matches and the hover cue is
 * absent — no other behaviour depends on it.
 */
const SELECTION_CSS = `
.u-el:hover:not(:has(.u-el:hover)):not(.u-selected) {
  outline: calc(1px / var(--u-scale, 1)) dashed rgba(212, 176, 98, 0.55);
  outline-offset: calc(1px / var(--u-scale, 1));
  cursor: pointer;
}

.u-selected {
  outline: calc(2px / var(--u-scale, 1)) solid #D4B062;
  outline-offset: calc(1px / var(--u-scale, 1));
  /* A halo, so the outline holds against a background of any brightness —
     including the accent-coloured button the outline itself is drawn in. */
  box-shadow:
    0 0 0 calc(4px / var(--u-scale, 1)) rgba(212, 176, 98, 0.22),
    0 0 calc(18px / var(--u-scale, 1)) rgba(212, 176, 98, 0.35);
}

/* Names the selection on the canvas. Absolutely positioned out of flow, and
   counter-scaled so it stays readable at any stage size. */
.u-selected[data-u-label]::after {
  content: attr(data-u-label);
  position: absolute;
  left: 0;
  bottom: calc(100% + 3px / var(--u-scale, 1));
  transform: scale(calc(1 / var(--u-scale, 1)));
  transform-origin: bottom left;
  z-index: 2;
  padding: 2px 6px;
  border-radius: 3px;
  background: #D4B062;
  color: #17141F;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  line-height: 14px;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
}

/* The root fills the stage, and the stage clips — a badge above it would be
   the one that is never seen. Tuck that one inside. */
.u-selected.u-root[data-u-label]::after {
  bottom: auto;
  top: calc(3px / var(--u-scale, 1));
  transform-origin: top left;
}
`;

/**
 * Every box outlined. UI Toolkit layouts are mostly invisible containers, so
 * "why is this 40px lower than I expected" is usually a wrapper you cannot see.
 */
const BOXES_CSS = `
.u-el {
  outline: calc(1px / var(--u-scale, 1)) solid rgba(255, 255, 255, 0.14);
}
`;

const HOST: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
};
