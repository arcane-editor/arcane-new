// A picture of the screen, from the same render plan the canvas and the layout
// probe use.
//
// `probeLayout` answers "where did everything end up" in numbers, and
// `style-coverage.ts` answers "did anything paint" in counts. Both are real
// signals and both miss the thing a person notices in half a second: that the
// title collides with the panel edge, that the accent is the only saturated
// colour and it is on the least important control, that the whole screen is
// grey. This produces the pixels, so the dock can show the user what a turn
// actually made — and so the model can be handed the same picture when it is
// asked to change it.
//
// ## How, and why this way
//
// The DOM is serialised into an SVG `<foreignObject>` and drawn to a canvas.
// The alternative — capturing the real preview through the OS — would
// photograph whatever the user happens to be looking at: their zoom, their
// scroll, the design dock sitting on top of it. This renders the DOCUMENT, at
// the panel's own resolution, whatever the window is doing.
//
// Two things do not survive, and the caller is told so rather than left to
// assume otherwise:
//
//   - **Fonts.** `-unity-font-definition` names a Unity asset, not a web font;
//     the SVG rasteriser has no way to load one, so type renders in the default
//     family at the right size and weight. Layout is unaffected (the probe
//     measures separately), but a typeface choice is not visible here.
//   - **Background images.** `url(project://…)` resolves inside Unity, not in a
//     data-URL document, so a 9-slice panel renders as its background colour.
//
// ## Honesty
//
// Every failure returns `null`. Nothing here ever returns a blank or partial
// image dressed as a render: a black rectangle handed to a model is worse than
// no image at all, because the model will describe it. `foreignObject`
// rasterisation is the historically fragile part of this on WebKit, which is
// the engine this app actually runs on, so the null path is the expected one to
// exercise — not a formality.

import type { RenderNode, RenderPlan } from './render-plan';

export interface Size {
  width: number;
  height: number;
}

/**
 * Longest side of the produced image.
 *
 * A 1920×1080 panel rasterised 1:1 is a ~1.5MB PNG once base64'd, which is a
 * quarter of `image-attach.ts`'s whole budget for something the model reads at
 * a glance. 1280 keeps text legible and the file a few hundred KB.
 */
export const MAX_RENDER_EDGE = 1280;

/** The ground the preview paints behind a panel — Unity panels are transparent over the game. */
export const STAGE_BACKGROUND = '#1b1726';

export interface RenderImageDeps {
  /** Decode an image URL. Rejects on a decode failure, which is one of the ways this returns null. */
  loadImage: (url: string) => Promise<CanvasImageSource>;
  /** A drawing surface at the requested size. */
  canvas: (size: Size) => HTMLCanvasElement | null;
}

const defaultDeps: RenderImageDeps = {
  loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('the SVG render could not be decoded'));
      img.src = url;
    });
  },
  canvas(size) {
    const el = document.createElement('canvas');
    el.width = size.width;
    el.height = size.height;
    return el;
  },
};

/** XML text content. `<foreignObject>` is parsed as XML, so an unescaped `&` is a hard parse error, not a glitch. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * `:host` back to a real selector.
 *
 * `uss-model.ts` compiles USS's `:root` to `:host` because the preview mounts
 * inside a shadow root. There is no shadow root inside a `foreignObject`, so
 * every `:host` rule would match nothing and a screen whose entire background
 * comes from `:root { background-color: … }` would render transparent — which
 * this module's own blank check would then correctly report as "nothing
 * rendered". Rewriting keeps the two renderers showing the same picture.
 */
export function inlineHostSelector(css: string): string {
  return css.replace(/:host\b/g, `.${STAGE_CLASS}`);
}

const STAGE_CLASS = 'u-stage';

/** One `<div>` per node, mirroring `PreviewStage`'s own element, as strict XHTML. */
function serialiseNode(node: RenderNode): string {
  const classes = node.classes.length > 0 ? ` class="${escapeAttr(node.classes.join(' '))}"` : '';
  const id = node.name ? ` id="${escapeAttr(node.name)}"` : '';
  const style = node.inlineStyle ? ` style="${escapeAttr(node.inlineStyle)}"` : '';
  const children = node.children.map(serialiseNode).join('');
  const text = node.text ? escapeText(node.text) : '';
  return `<div${id}${classes}${style}>${text}${children}</div>`;
}

/**
 * The SVG document, as a string.
 *
 * Exported for testing: the whole browser-only half below is one `drawImage`
 * call around this, and this is the part with the escaping and the `:host`
 * rewrite in it — the two places a bug would produce a silently wrong picture
 * rather than an obvious failure.
 */
export function buildRenderSvg(plan: RenderPlan, size: Size): string {
  const body = plan.root ? serialiseNode(plan.root) : '';
  const css = inlineHostSelector(plan.css);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" ` +
    `viewBox="0 0 ${size.width} ${size.height}">` +
    `<foreignObject x="0" y="0" width="${size.width}" height="${size.height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${size.width}px;height:${size.height}px;overflow:hidden">` +
    `<style>${escapeText(css)}</style>` +
    `<div class="${STAGE_CLASS}" style="width:${size.width}px;height:${size.height}px">${body}</div>` +
    `</div></foreignObject></svg>`
  );
}

/** Fit `size` inside `MAX_RENDER_EDGE` without changing its aspect ratio. */
export function scaledSize(size: Size, maxEdge = MAX_RENDER_EDGE): Size {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxEdge || longest === 0) return size;
  const factor = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(size.width * factor)),
    height: Math.max(1, Math.round(size.height * factor)),
  };
}

/**
 * True when nothing but the ground colour reached the canvas.
 *
 * The check that matters: a `foreignObject` WebKit declined to rasterise
 * produces a canvas containing exactly the background this function painted
 * first, and it is indistinguishable from a successful render of an empty
 * document unless something asks. Sampling rather than scanning every pixel —
 * a 1280×720 canvas is 3.7M bytes and this runs after every design write.
 */
function renderedNothing(ctx: CanvasRenderingContext2D, size: Size): boolean {
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size.width, size.height).data;
  } catch {
    // A tainted canvas throws here rather than at toDataURL on some engines.
    // Either way the image cannot be read, so it cannot be shown.
    return true;
  }
  const first = [data[0], data[1], data[2], data[3]];
  const stride = 4 * Math.max(1, Math.floor(data.length / 4 / 4096));
  for (let i = 0; i < data.length; i += stride) {
    if (
      data[i] !== first[0] ||
      data[i + 1] !== first[1] ||
      data[i + 2] !== first[2] ||
      data[i + 3] !== first[3]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Rasterise a render plan to a PNG data URL, or `null` if it could not be done.
 *
 * `null` covers every failure — no root, no 2D context, an SVG WebKit refused
 * to decode, a tainted canvas, and a canvas that came back a single flat
 * colour. Callers must say "the render could not be captured" rather than
 * showing nothing and letting it read as a screen with nothing on it.
 */
export async function renderToPng(
  plan: RenderPlan,
  size: Size,
  deps: RenderImageDeps = defaultDeps,
): Promise<string | null> {
  if (!plan.root || size.width <= 0 || size.height <= 0) return null;

  const out = scaledSize(size);
  const svg = buildRenderSvg(plan, size);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  try {
    const image = await deps.loadImage(url);
    const canvas = deps.canvas(out);
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return null;

    // Paint the ground first, so a transparent document renders the way the
    // preview shows it rather than as a checkerboard-or-black lottery, and so
    // `renderedNothing` has a known colour to compare against.
    ctx.fillStyle = STAGE_BACKGROUND;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(image, 0, 0, out.width, out.height);

    if (renderedNothing(ctx, out)) return null;
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
