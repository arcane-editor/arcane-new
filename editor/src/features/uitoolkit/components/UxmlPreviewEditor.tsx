import { useEffect, useMemo, useState } from 'react';
import { PanelsTopLeft, AlertTriangle } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUnityIndexStore } from '../../../stores/unity-index';
import { parseUxml } from '../../../utils/uxml-model';
import { buildRenderPlan } from '../services/render-plan';
import { loadStyleSheets } from '../services/style-resolve';
import type { UssStyleSheet } from '../../../utils/uss-model';
import { PreviewCanvas } from './PreviewCanvas';
import { PreviewToolbar } from './PreviewToolbar';
import { usePreviewCamera, type StageBackground } from '../hooks/usePreviewCamera';
import { ElementInspector } from './ElementInspector';
import { cascadeFor, targetFor } from '../services/cascade';
import { loadUsageIndex, EMPTY_USAGE_INDEX, type UsageIndex } from '../services/usage-index';
import { loadPanelSettings, NO_PANEL, type PanelResolution } from '../services/panel-resolve';
import { panelLayoutSize } from '../../../utils/panel-settings';
import { blankStringsAndComments } from '../../unity-analyzers';
import type { RenderNode } from '../services/render-plan';

export function isUxmlFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.uxml');
}

interface Props {
  path: string;
  name: string;
  /** Raw UXML, from the live Monaco buffer rather than disk. */
  content: string;
}

/**
 * Rendered preview of a `.uxml`.
 *
 * Reads the live editor buffer, so it reflows as you type — which is also why
 * `parseUxml` recovers rather than throws: mid-keystroke the document is almost
 * always malformed XML, and a throwing parser would flash this view away on
 * every character.
 *
 * The reference resolution the panel and the analyzers do is deliberately NOT
 * repeated here. This answers one question: what does it look like.
 */
export function UxmlPreviewEditor({ path, name, content }: Props) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const [sheets, setSheets] = useState<UssStyleSheet[]>([]);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [usages, setUsages] = useState<UsageIndex>(EMPTY_USAGE_INDEX);
  const [showBoxes, setShowBoxes] = useState(false);
  const [background, setBackground] = useState<StageBackground>('dark');
  const [panel, setPanel] = useState<PanelResolution>(NO_PANEL);

  // The panel decides the coordinate space, so this has to land before any
  // measurement means anything. Keyed on the path, not the buffer: typing in
  // the document does not change which UIDocument renders it.
  useEffect(() => {
    let cancelled = false;
    void loadPanelSettings(path, workspacePath).then((next) => {
      if (!cancelled) setPanel(next);
    });
    return () => {
      cancelled = true;
    };
  }, [path, workspacePath]);

  /**
   * The box the document is laid out in.
   *
   * NOT the screen. `width: 420px` in USS means 420 of the PANEL's pixels, and
   * a `ScaleWithScreenSize` panel with a 1200px reference lays out at 1200 on
   * any screen — so a preview that assumed 1920 drew every element at 62% of
   * the size Unity gives it. Falls back to the screen itself, which is exactly
   * what Unity does when no panel scaling applies.
   */
  const layout = useMemo(
    () => (panel.settings ? panelLayoutSize(panel.settings, SCREEN) : SCREEN),
    [panel.settings],
  );

  /**
   * The camera over that box.
   *
   * The document is laid out at the layout box's own size and the CAMERA does
   * all the scaling, which is what keeps every proportion honest: a
   * `width: 420px` card is 22% of a 1920px panel at every zoom, where laying
   * out at 1:1 CSS pixels in a 960px stage would draw it at twice its real
   * size.
   */
  const camera = usePreviewCamera(layout, CANVAS_PADDING);

  const doc = useMemo(() => parseUxml(content), [content]);

  // Keyed on the style refs rather than on the whole buffer: retyping a label
  // must not re-read every stylesheet off disk. The separator is a NUL, which
  // no style ref can contain, written as an ESCAPE — a literal NUL byte in the
  // source makes the whole file binary to git, so `git diff` refuses to show it
  // and every review of this file goes blind.
  const styleKey = useMemo(
    () => doc.styleRefs.map((r) => `${r.kind}:${r.raw}`).join('\u0000'),
    [doc.styleRefs],
  );

  useEffect(() => {
    let cancelled = false;
    const lookupGuid = (guid: string) => useUnityIndexStore.getState().resolveGuid(guid);
    void loadStyleSheets(doc, path, workspacePath, lookupGuid).then((loaded) => {
      if (cancelled) return;
      setSheets(loaded.sheets);
      setUnresolved(loaded.unresolved);
    });
    return () => {
      cancelled = true;
    };
    // `doc` is intentionally absent: it changes on every keystroke, and the
    // stylesheets it names are what actually matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleKey, path, workspacePath]);

  const plan = useMemo(() => buildRenderPlan(doc, sheets), [doc, sheets]);

  // Every named element in this document -- the only names worth scanning for.
  const names = useMemo(() => {
    const out: string[] = [];
    (function walk(n: RenderNode | null) {
      if (!n) return;
      if (n.name) out.push(n.name);
      n.children.forEach(walk);
    })(plan.root);
    return out;
  }, [plan.root]);
  const namesKey = useMemo(() => [...names].sort().join('\u0000'), [names]);

  // Walking the project's C# is the expensive part, so this keys on the NAMES:
  // retyping a label must not re-scan thousands of files.
  useEffect(() => {
    let cancelled = false;
    setUsages(EMPTY_USAGE_INDEX);
    void loadUsageIndex(workspacePath, namesKey.split('\u0000').filter(Boolean), blankStringsAndComments)
      .then((next) => {
        if (!cancelled) setUsages(next);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, namesKey]);

  const selectedNode = useMemo(() => {
    if (!selectedId) return null;
    let hit: RenderNode | null = null;
    (function walk(n: RenderNode | null) {
      if (!n || hit) return;
      if (n.id === selectedId) hit = n;
      else n.children.forEach(walk);
    })(plan.root);
    return hit;
  }, [plan.root, selectedId]);

  const cascade = useMemo(() => {
    if (!selectedId) return [];
    const target = targetFor(plan.root, selectedId);
    return target ? cascadeFor(target, sheets) : [];
  }, [plan.root, selectedId, sheets]);
  const notes = [...plan.notes, ...unresolved];

  return (
    <div className="editor-container" style={SHELL}>
      <div style={HEADER}>
        <PanelsTopLeft size={14} style={{ color: 'var(--accent)' }} />
        <span style={{ color: 'var(--text-primary)' }}>{name}</span>
        <span style={{ opacity: 0.7 }}>
          {doc.diagnostics.length > 0
            ? 'source is mid-edit'
            : `${sheets.length} stylesheet${sheets.length === 1 ? '' : 's'}`}
        </span>
        <PanelChip panel={panel} layout={layout} />
        <PreviewToolbar
          camera={camera}
          background={background}
          onBackground={setBackground}
          showBoxes={showBoxes}
          onShowBoxes={setShowBoxes}
        />
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <PreviewCanvas
        camera={camera}
        layout={layout}
        css={plan.css}
        root={plan.root}
        selectedId={selectedId}
        onSelect={setSelectedId}
        showBoxes={showBoxes}
        background={background}
        label={stageLabel(panel, layout)}
      />
      <ElementInspector
        node={selectedNode}
        usages={selectedNode?.name ? usages.byElement.get(selectedNode.name) ?? [] : []}
        cascade={cascade}
        usagesLoaded={usages.loaded}
      />
      </div>

      {notes.length > 0 && (
        <div style={STRIP}>
          <AlertTriangle size={11} style={{ flexShrink: 0, color: 'var(--warning)' }} />
          <div>
            <strong style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
              Not rendered:
            </strong>{' '}
            {notes.join(' · ')}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The name above the frame, the way a design tool names an artboard.
 *
 * Prefers the PanelSettings asset's name over the raw numbers: on a canvas the
 * useful question is *which panel am I looking at*, and the resolution is
 * already in the header chip that also carries where it came from.
 */
function stageLabel(panel: PanelResolution, layout: { width: number; height: number }): string {
  const size = `${layout.width} × ${layout.height}`;
  return panel.settings ? `${panel.settings.name} · ${size}` : size;
}

/**
 * The layout box, and where the number came from.
 *
 * Stated rather than assumed: this one number scales every element in the
 * preview, so a reader has to be able to see whether it was read off a wired
 * UIDocument or picked out of several candidates.
 */
function PanelChip({ panel, layout }: { panel: PanelResolution; layout: { width: number; height: number } }) {
  const source =
    panel.confidence === 'wired'
      ? panel.settings!.name
      : panel.confidence === 'only'
        ? `${panel.settings!.name} (only panel in the project)`
        : panel.confidence === 'ambiguous'
          ? `${panel.settings!.name} — assumed, ${panel.candidates} panels and none wired to this document`
          : 'no PanelSettings found — showing the screen size';
  return (
    <span
      style={{ ...METRIC, opacity: panel.confidence === 'ambiguous' ? 0.9 : 0.55 }}
      title={`Laid out at ${layout.width} × ${layout.height} — ${source}`}
    >
      {layout.width} × {layout.height}
      {panel.confidence === 'ambiguous' && (
        <span style={{ color: 'var(--warning)' }}> assumed</span>
      )}
    </span>
  );
}

const SHELL: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
};

const HEADER: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 10px',
  borderBottom: '1px solid var(--border)',
  fontSize: 12,
  color: 'var(--text-secondary)',
  flexShrink: 0,
};

const METRIC: React.CSSProperties = {
  opacity: 0.55,
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
};

/** Breathing room the fit leaves around the stage, in canvas pixels. */
const CANVAS_PADDING = 28;

/**
 * The screen the panel is imagined to be on.
 *
 * Distinct from the LAYOUT box: the screen is what a `ScaleWithScreenSize`
 * panel scales against, and 16:9 at 1080p is the assumption a UI is designed
 * under unless stated otherwise. Only its aspect ratio reaches the picture --
 * the layout box is derived from it and the project's PanelSettings.
 */
const SCREEN = { width: 1920, height: 1080 };

const STRIP: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 7,
  padding: '6px 12px',
  borderTop: '1px solid var(--border)',
  fontSize: 11.5,
  lineHeight: 1.5,
  color: 'var(--text-secondary)',
  flexShrink: 0,
  maxHeight: 96,
  overflowY: 'auto',
};

export default UxmlPreviewEditor;
