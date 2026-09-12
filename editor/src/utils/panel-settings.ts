// `PanelSettings` — the coordinate space a UXML document is laid out in.
//
// A UXML file does not say how big anything is. `width: 420px` means 420 of the
// PANEL's pixels, and the panel's size comes from the `PanelSettings` asset the
// document is rendered through. Assume 1920 when the project says 1200 and
// every proportion in the preview is off by 38% — the document is not wrong,
// the screen it was placed on is.
//
// A leaf module: no imports, so it loads under Bun's DOM-less test runtime, and
// the arithmetic below is the part worth pinning.

export type PanelScaleMode =
  /** 1 UI pixel is 1 screen pixel, divided by `scale`. */
  | 'constant-pixel'
  /** Physical size, via DPI. */
  | 'constant-physical'
  /** The reference resolution is the design space. The common one. */
  | 'scale-with-screen';

export type ScreenMatchMode = 'match-width-or-height' | 'shrink' | 'expand';

export interface PanelSettings {
  name: string;
  scaleMode: PanelScaleMode;
  /** Only meaningful for `constant-pixel`. */
  scale: number;
  referenceResolution: { width: number; height: number };
  screenMatchMode: ScreenMatchMode;
  /** 0 matches width, 1 matches height, in between blends logarithmically. */
  match: number;
  referenceDpi: number;
  fallbackDpi: number;
}

const SCALE_MODES: PanelScaleMode[] = ['constant-pixel', 'scale-with-screen', 'constant-physical'];
const MATCH_MODES: ScreenMatchMode[] = ['match-width-or-height', 'shrink', 'expand'];

function num(yaml: string, key: string, fallback: number): number {
  // Anchored to the start of a line so `m_Scale` cannot be matched inside
  // `m_ScaleMode`, and so a key nested under another block is not mistaken for
  // the top-level one.
  const m = new RegExp(`^\\s*${key}:\\s*(-?[\\d.]+)\\s*$`, 'm').exec(yaml);
  return m ? Number(m[1]) : fallback;
}

/**
 * Read a `PanelSettings` asset.
 *
 * Returns null when the file is not one — the caller uses that to skip, rather
 * than rendering a document against numbers that came from something else.
 */
export function parsePanelSettings(yaml: string, path: string): PanelSettings | null {
  if (!yaml.includes('UnityEngine.UIElements.PanelSettings')) return null;

  const res = /^\s*m_ReferenceResolution:\s*\{x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+)\}/m.exec(yaml);
  const nameMatch = /^\s*m_Name:\s*(.+)$/m.exec(yaml);

  return {
    name: nameMatch ? nameMatch[1].trim() : path.split('/').pop() ?? path,
    scaleMode: SCALE_MODES[num(yaml, 'm_ScaleMode', 0)] ?? 'constant-pixel',
    // A zero scale would divide the layout into infinity; Unity treats it as 1.
    scale: num(yaml, 'm_Scale', 1) || 1,
    referenceResolution: res
      ? { width: Number(res[1]), height: Number(res[2]) }
      : { width: 1200, height: 800 },
    screenMatchMode: MATCH_MODES[num(yaml, 'm_ScreenMatchMode', 0)] ?? 'match-width-or-height',
    match: num(yaml, 'm_Match', 0),
    referenceDpi: num(yaml, 'm_ReferenceDpi', 96),
    fallbackDpi: num(yaml, 'm_FallbackDpi', 96),
  };
}

export interface Size {
  width: number;
  height: number;
}

/**
 * The logical size the document is laid out in, on a screen of `screen`.
 *
 * Mirrors `PanelSettings.ResolveScale`: every mode computes a SCALE, and the
 * layout box is the screen divided by it. Rounded, because a layout box of
 * 674.9999 makes every measurement in the inspector look wrong by a pixel.
 */
export function panelLayoutSize(settings: PanelSettings, screen: Size): Size {
  const ref = settings.referenceResolution;
  const scale = (() => {
    switch (settings.scaleMode) {
      case 'constant-pixel':
        return settings.scale;
      case 'constant-physical':
        // No real DPI to read here, so this is the fallback Unity itself uses
        // when the screen does not report one.
        return settings.fallbackDpi / settings.referenceDpi;
      case 'scale-with-screen': {
        if (ref.width <= 0 || ref.height <= 0) return 1;
        const byWidth = screen.width / ref.width;
        const byHeight = screen.height / ref.height;
        switch (settings.screenMatchMode) {
          case 'shrink':
            return Math.max(byWidth, byHeight);
          case 'expand':
            return Math.min(byWidth, byHeight);
          case 'match-width-or-height': {
            // Unity interpolates in LOG space, so match 0.5 sits geometrically
            // between the two ratios rather than arithmetically.
            const t = Math.min(1, Math.max(0, settings.match));
            const logged = Math.log2(byWidth) * (1 - t) + Math.log2(byHeight) * t;
            return 2 ** logged;
          }
        }
      }
    }
  })();

  if (!Number.isFinite(scale) || scale <= 0) return { ...screen };
  return {
    width: Math.round(screen.width / scale),
    height: Math.round(screen.height / scale),
  };
}

/**
 * The `PanelSettings` guid of a `UIDocument` that renders `uxmlGuid`.
 *
 * Scenes and prefabs are streams of YAML documents separated by `--- !u!`, and
 * the two references live in the same one — so the join is "find the document
 * that names this UXML, then read its panel out of that document". Matching
 * across the whole file would pair a UIDocument with another one's settings.
 *
 * Unity 6 calls the field `sourceAsset`; older versions `m_VisualTreeAsset`.
 * Both appear in projects that have been upgraded, so both are accepted.
 */
export function findPanelSettingsRef(yaml: string, uxmlGuid: string): string | null {
  if (!yaml.includes(uxmlGuid)) return null;
  for (const doc of yaml.split(/^--- /m)) {
    const uses = new RegExp(
      `^\\s*(?:sourceAsset|m_VisualTreeAsset|m_SourceAsset):\\s*\\{[^}]*guid:\\s*${uxmlGuid}`,
      'm',
    ).test(doc);
    if (!uses) continue;
    const panel = /^\s*m_PanelSettings:\s*\{[^}]*guid:\s*([0-9a-f]{32})/m.exec(doc);
    if (panel) return panel[1];
  }
  return null;
}

/** `guid: <32 hex>` out of a `.meta` file. */
export function guidFromMeta(meta: string): string | null {
  const m = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(meta);
  return m ? m[1] : null;
}
