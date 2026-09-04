import { Frame, Maximize, Minus, Moon, Plus, Sun, Grid2x2 } from 'lucide-react';
import type { PreviewCamera, StageBackground } from '../hooks/usePreviewCamera';

/**
 * The preview's controls: zoom, what the UI sits on, and box outlines.
 *
 * The zoom readout is the CAMERA's zoom, not the old fit ratio. Those were the
 * same number while fit was the only view available; now that they can differ,
 * showing the fit ratio would report 47% while the user reads a document at
 * 300%.
 */
export function PreviewToolbar({
  camera,
  background,
  onBackground,
  showBoxes,
  onShowBoxes,
}: {
  camera: PreviewCamera;
  background: StageBackground;
  onBackground: (next: StageBackground) => void;
  showBoxes: boolean;
  onShowBoxes: (next: boolean) => void;
}) {
  const { viewport, fitted, zoomIn, zoomOut, fit, actualSize } = camera;
  const percent = Math.round(viewport.zoom * 100);
  const next = BACKGROUNDS[(BACKGROUNDS.indexOf(background) + 1) % BACKGROUNDS.length];
  const BgIcon = BACKGROUND_ICON[background];

  return (
    <div className="uxml-toolbar">
      <div className="uxml-zoom" role="group" aria-label="Preview zoom">
        <button type="button" onClick={zoomOut} title="Zoom out  ( − )" aria-label="Zoom out">
          <Minus size={11} />
        </button>
        {/* Click the readout for 1:1 — the same place the number is, which is
            where you look when you want to know or change it. */}
        <button
          type="button"
          className="uxml-zoom-value"
          onClick={actualSize}
          title="Actual size, 1 USS pixel to 1 screen pixel  ( 1 )"
        >
          {percent}%
        </button>
        <button type="button" onClick={zoomIn} title="Zoom in  ( + )" aria-label="Zoom in">
          <Plus size={11} />
        </button>
      </div>

      <button
        type="button"
        className={`uxml-preview-toggle${fitted ? ' active' : ''}`}
        onClick={fit}
        aria-pressed={fitted}
        title="Fit the whole panel in view  ( 0 )"
      >
        <Maximize size={11} />
        Fit
      </button>

      <button
        type="button"
        className="uxml-preview-toggle"
        onClick={() => onBackground(next)}
        title={`Behind the UI: ${BACKGROUND_LABEL[background]} — click for ${BACKGROUND_LABEL[next]}. Unity panels are transparent over the game, so check the UI against more than one.`}
      >
        <BgIcon size={11} />
        {BACKGROUND_LABEL[background]}
      </button>

      <button
        type="button"
        className={`uxml-preview-toggle${showBoxes ? ' active' : ''}`}
        aria-pressed={showBoxes}
        onClick={() => onShowBoxes(!showBoxes)}
        title="Outline every element — UI Toolkit layouts are mostly containers you cannot see"
      >
        <Frame size={11} />
        Boxes
      </button>
    </div>
  );
}

/** Cycle order, dark first: it is the one most game UI is authored against. */
const BACKGROUNDS: StageBackground[] = ['dark', 'light', 'checker'];

const BACKGROUND_LABEL: Record<StageBackground, string> = {
  dark: 'Dark',
  light: 'Light',
  checker: 'Checker',
};

const BACKGROUND_ICON: Record<StageBackground, typeof Moon> = {
  dark: Moon,
  light: Sun,
  checker: Grid2x2,
};

export default PreviewToolbar;
