import { describe, expect, it } from 'bun:test';
import { parseUss } from '../../../utils/uss-model';
import { parseUxml } from '../../../utils/uxml-model';
import { buildRenderPlan } from './render-plan';
import {
  buildRenderSvg,
  inlineHostSelector,
  renderToPng,
  scaledSize,
  MAX_RENDER_EDGE,
  type RenderImageDeps,
} from './render-image';

function plan(uxml: string, uss: string[] = []) {
  return buildRenderPlan(
    parseUxml(uxml),
    uss.map((src, i) => parseUss(src, `/p/s${i}.uss`)),
  );
}

const PANEL = { width: 1920, height: 1080 };

describe('buildRenderSvg', () => {
  it('emits one div per element, carrying its name as an id and its classes', () => {
    const svg = buildRenderSvg(
      plan(
        '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button name="play" class="btn" /></ui:UXML>',
      ),
      PANEL,
    );
    expect(svg).toContain('id="play"');
    expect(svg).toContain('btn');
    expect(svg).toContain('<foreignObject');
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
  });

  it('escapes text, because foreignObject is parsed as XML', () => {
    // A bare `&` here is a hard XML parse error, so the whole image silently
    // fails to decode — the exact class of bug that produces a blank render.
    const svg = buildRenderSvg(
      plan(
        '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Label text="Save &amp; Quit" /></ui:UXML>',
      ),
      PANEL,
    );
    expect(svg).toContain('Save &amp; Quit');
    expect(svg).not.toMatch(/Save & Quit/);
  });

  it('escapes a quote inside an inline style attribute', () => {
    const svg = buildRenderSvg(
      plan(
        '<ui:UXML xmlns:ui="UnityEngine.UIElements">' +
          '<ui:VisualElement style="background-image: url(&quot;a.png&quot;);" /></ui:UXML>',
      ),
      PANEL,
    );
    expect(svg).toContain('&quot;');
  });

  it('rewrites :host, or a screen whose background comes from :root renders empty', () => {
    const svg = buildRenderSvg(
      plan('<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:VisualElement /></ui:UXML>', [
        ':root { background-color: rgb(20, 18, 30); }',
      ]),
      PANEL,
    );
    expect(svg).not.toContain(':host');
    expect(svg).toContain('.u-stage');
  });

  it('carries the panel size, not the window size', () => {
    const svg = buildRenderSvg(plan('<ui:UXML xmlns:ui="UnityEngine.UIElements"/>'), {
      width: 800,
      height: 600,
    });
    expect(svg).toContain('width="800"');
    expect(svg).toContain('viewBox="0 0 800 600"');
  });
});

describe('inlineHostSelector', () => {
  it('leaves an unrelated selector alone', () => {
    expect(inlineHostSelector('.hosting { color: red; }')).toBe('.hosting { color: red; }');
  });

  it('rewrites every occurrence, including a descendant form', () => {
    expect(inlineHostSelector(':host > .u-el { flex-grow: 1; } :host { all: initial; }')).toBe(
      '.u-stage > .u-el { flex-grow: 1; } .u-stage { all: initial; }',
    );
  });
});

describe('scaledSize', () => {
  it('leaves a small panel alone', () => {
    expect(scaledSize({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });

  it('fits a 1080p panel inside the edge budget without distorting it', () => {
    const out = scaledSize(PANEL);
    expect(Math.max(out.width, out.height)).toBe(MAX_RENDER_EDGE);
    expect(out.width / out.height).toBeCloseTo(PANEL.width / PANEL.height, 2);
  });

  it('never produces a zero dimension', () => {
    const out = scaledSize({ width: 4000, height: 1 });
    expect(out.height).toBeGreaterThanOrEqual(1);
  });
});

// ── The browser half, through its seam ───────────────────────────────────────

function fakeCanvas(pixels: () => Uint8ClampedArray, dataUrl = 'data:image/png;base64,AAAA') {
  const ctx = {
    fillStyle: '',
    fillRect() {},
    drawImage() {},
    getImageData: () => ({ data: pixels() }),
  };
  return {
    getContext: () => ctx,
    toDataURL: () => dataUrl,
  } as unknown as HTMLCanvasElement;
}

/** Two distinct colours — i.e. something actually drew. */
function painted(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(4096 * 4);
  data.fill(20);
  data[4000] = 255;
  return data;
}

/** One flat colour everywhere — what a foreignObject WebKit declined to draw looks like. */
function flat(): Uint8ClampedArray {
  return new Uint8ClampedArray(4096 * 4).fill(27);
}

function deps(over: Partial<RenderImageDeps> = {}): RenderImageDeps {
  return {
    loadImage: async () => ({}) as CanvasImageSource,
    canvas: () => fakeCanvas(painted),
    ...over,
  };
}

describe('renderToPng', () => {
  const SIMPLE = plan(
    '<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button name="play" /></ui:UXML>',
  );

  it('returns a PNG data URL when something rendered', async () => {
    const out = await renderToPng(SIMPLE, PANEL, deps());
    expect(out).toStartWith('data:image/png');
  });

  it('returns null when the SVG could not be decoded', async () => {
    // The WebKit foreignObject path is the fragile one, and this is what it
    // looks like from here.
    const out = await renderToPng(
      SIMPLE,
      PANEL,
      deps({
        loadImage: async () => {
          throw new Error('decode failed');
        },
      }),
    );
    expect(out).toBeNull();
  });

  it('returns null rather than a blank frame when nothing drew', async () => {
    // A flat rectangle handed to a model is worse than no image: the model
    // will describe it.
    const out = await renderToPng(SIMPLE, PANEL, deps({ canvas: () => fakeCanvas(flat) }));
    expect(out).toBeNull();
  });

  it('returns null when the canvas is tainted and cannot be read back', async () => {
    const tainted = {
      getContext: () => ({
        fillStyle: '',
        fillRect() {},
        drawImage() {},
        getImageData() {
          throw new Error('SecurityError');
        },
      }),
      toDataURL: () => 'data:image/png;base64,AAAA',
    } as unknown as HTMLCanvasElement;
    expect(await renderToPng(SIMPLE, PANEL, deps({ canvas: () => tainted }))).toBeNull();
  });

  it('returns null for a document with no root, without calling the browser at all', async () => {
    let loaded = 0;
    const empty = plan('');
    const out = await renderToPng(
      empty,
      PANEL,
      deps({
        loadImage: async () => {
          loaded++;
          return {} as CanvasImageSource;
        },
      }),
    );
    expect(out).toBeNull();
    expect(loaded).toBe(0);
  });

  it('returns null for a zero-size panel', async () => {
    expect(await renderToPng(SIMPLE, { width: 0, height: 0 }, deps())).toBeNull();
  });
});
