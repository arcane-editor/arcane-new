import { PreviewStage } from './PreviewStage';
import type { PreviewCamera, StageBackground } from '../hooks/usePreviewCamera';
import type { RenderNode } from '../services/render-plan';
import type { Size } from '../services/viewport';

/**
 * The pannable, zoomable canvas the document sits on.
 *
 * Three coordinate spaces meet here, and keeping them apart is most of the
 * job:
 *
 * - **World** — the document's own space. `width: 420px` in USS is 420 units,
 *   whatever the camera is doing. Only `.uxml-stage-world` lives here.
 * - **Screen** — canvas pixels. The stage's frame, its shadow and its label
 *   are sized here, so a 1px border stays 1px at 400% instead of becoming
 *   four. This is why the frame is positioned and sized in JS rather than
 *   riding the same `transform` as its contents.
 * - **Shadow** — inside `PreviewStage`, where the user's USS applies. It is
 *   handed the camera's zoom as `--u-scale` so selection chrome can divide by
 *   it and stay one screen pixel wide at any magnification.
 */
export function PreviewCanvas({
  camera,
  layout,
  css,
  root,
  selectedId,
  onSelect,
  showBoxes,
  background,
  label,
}: {
  camera: PreviewCamera;
  /** The panel's layout box — the world's extent, and the stage's aspect. */
  layout: Size;
  css: string;
  root: RenderNode | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  showBoxes: boolean;
  background: StageBackground;
  /** Sits above the frame, the way a design tool names an artboard. */
  label: string;
}) {
  const { viewport, containerRef, handlers, panning, spaceHeld } = camera;
  const { x, y, zoom } = viewport;

  return (
    <div
      ref={containerRef}
      // The cursor is a CLASS rather than an inline style because it has to win
      // over both `.uxml-stage` and the `cursor: pointer` inside the preview's
      // shadow root: with the pointer captured, a drag that wanders over an
      // element must keep reading as a drag.
      className={`uxml-canvas${panning ? ' is-panning' : spaceHeld ? ' is-grab' : ''}`}
      // Focusable so the zoom keys work after a click, not only on hover. No
      // visible focus ring: it would frame the whole preview in accent colour
      // for what is, from the user's side, just having clicked the canvas.
      tabIndex={0}
      {...handlers}
    >
      {/* The grid translates AND scales with the camera. A fixed grid would
          leave a pan reading as the stage sliding across a static backdrop;
          this way the whole canvas moves, which is the cue that you are
          moving a viewport rather than dragging an object. */}
      <div
        className="uxml-canvas-grid"
        style={{
          backgroundSize: `${GRID * zoom}px ${GRID * zoom}px, ${GRID * zoom}px ${GRID * zoom}px, ${
            GRID * COARSE * zoom
          }px ${GRID * COARSE * zoom}px, ${GRID * COARSE * zoom}px ${GRID * COARSE * zoom}px`,
          backgroundPosition: `${x}px ${y}px`,
          // Below ~6px apart the fine grid stops reading as a grid and starts
          // reading as noise, so it fades out and the coarse one carries on.
          opacity: GRID * zoom < 6 ? 0.35 : 1,
        }}
      />

      <div
        className="uxml-stage"
        style={{
          left: x,
          top: y,
          width: layout.width * zoom,
          height: layout.height * zoom,
        }}
      >
        {/* What the UI is composited over. Unity panels are transparent above
            the game, so a single dark backdrop quietly hides every
            light-on-light contrast mistake in the document. */}
        <div className="uxml-stage-surface" data-bg={background} />

        <div
          className="uxml-stage-world"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `scale(${zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <PreviewStage
            css={css}
            root={root}
            selectedId={selectedId}
            onSelect={onSelect}
            scale={zoom}
            showBoxes={showBoxes}
          />
        </div>
      </div>

      {/* Outside the frame and in screen space, so it neither overlaps the
          document nor grows with the zoom. */}
      <div
        className="uxml-stage-label"
        style={{ left: x, top: y, width: layout.width * zoom }}
      >
        {label}
      </div>
    </div>
  );
}

/** Fine grid spacing, in world units. */
const GRID = 24;

/** Coarse lines every this many fine cells. */
const COARSE = 5;

export default PreviewCanvas;
