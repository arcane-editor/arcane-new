import { getCurrentWebview } from '@tauri-apps/api/webview';
import { zoomFactorFor } from '../zoom';

/**
 * Push a zoom level onto this window's webview.
 *
 * Native page zoom rather than a CSS transform, which is what VS Code does via
 * Electron's `webFrame.setZoomLevel`. It matters here more than in a plain web
 * app: Monaco and xterm both measure character cells against real layout
 * boxes, and both already handle browser zoom (Monaco re-measures on
 * devicePixelRatio changes, xterm refits via its ResizeObserver). A CSS `zoom`
 * or `scale` on an ancestor instead leaves Monaco's mouse coordinates
 * disagreeing with what is painted.
 *
 * Kept out of `zoom.ts` so the level arithmetic stays testable — importing the
 * Tauri webview API under `bun test` pulls in an environment that does not
 * exist there. Same reason `layout-persist.ts` injects its writer.
 *
 * Failure is swallowed deliberately: zoom is a cosmetic preference, and the
 * call rejects in any non-Tauri context (dev in a plain browser tab). Nothing
 * downstream depends on it having landed.
 */
export async function applyWebviewZoom(level: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(zoomFactorFor(level));
  } catch {
    // no-op: see above
  }
}
