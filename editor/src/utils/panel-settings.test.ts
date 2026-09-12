import { describe, it, expect } from 'bun:test';
import {
  parsePanelSettings,
  panelLayoutSize,
  findPanelSettingsRef,
  guidFromMeta,
  type PanelSettings,
} from './panel-settings';

/** The demo project's asset, trimmed to the fields that matter. */
const ASSET = `%YAML 1.1
--- !u!114 &11400000
MonoBehaviour:
  m_Name: MainMenuPanelSettings
  m_EditorClassIdentifier: UnityEngine.dll::UnityEngine.UIElements.PanelSettings
  m_ScaleMode: 1
  m_Scale: 1
  m_ReferenceDpi: 96
  m_FallbackDpi: 96
  m_ReferenceResolution: {x: 1200, y: 800}
  m_ScreenMatchMode: 0
  m_Match: 0
  m_SortingOrder: 0
  m_DynamicAtlasSettings:
    m_MinAtlasSize: 64
`;

const HD = { width: 1920, height: 1080 };

describe('parsePanelSettings', () => {
  it('reads the fields that decide the layout box', () => {
    const s = parsePanelSettings(ASSET, 'Assets/UI/MainMenuPanelSettings.asset')!;
    expect(s.name).toBe('MainMenuPanelSettings');
    expect(s.scaleMode).toBe('scale-with-screen');
    expect(s.referenceResolution).toEqual({ width: 1200, height: 800 });
    expect(s.screenMatchMode).toBe('match-width-or-height');
    expect(s.match).toBe(0);
  });

  it('does not let m_ScaleMode be read as m_Scale', () => {
    // The prefix trap: an unanchored /m_Scale:\s*(\d+)/ matches inside
    // `m_ScaleMode: 1` and silently returns the wrong number.
    expect(parsePanelSettings(ASSET, 'x')!.scale).toBe(1);
    const scaled = ASSET.replace('m_Scale: 1', 'm_Scale: 2');
    expect(parsePanelSettings(scaled, 'x')!.scale).toBe(2);
  });

  it('returns null for an asset that is not PanelSettings', () => {
    expect(parsePanelSettings('MonoBehaviour:\n  m_Name: Weapon\n', 'x')).toBe(null);
  });

  it('treats a zero scale as 1 rather than dividing the layout to nothing', () => {
    expect(parsePanelSettings(ASSET.replace('m_Scale: 1', 'm_Scale: 0'), 'x')!.scale).toBe(1);
  });
});

describe('panelLayoutSize', () => {
  const base = parsePanelSettings(ASSET, 'x')!;
  const withMode = (over: Partial<PanelSettings>): PanelSettings => ({ ...base, ...over });

  it('matches width: the reference width IS the layout width', () => {
    // The whole bug in one assertion — the demo lays out at 1200, not 1920.
    expect(panelLayoutSize(base, HD)).toEqual({ width: 1200, height: 675 });
  });

  it('matches height when match is 1', () => {
    expect(panelLayoutSize(withMode({ match: 1 }), HD)).toEqual({ width: 1422, height: 800 });
  });

  it('blends the two logarithmically at match 0.5', () => {
    // Geometric, not arithmetic: the mean of 1200 and 1422 is 1311, and Unity
    // interpolating in log space lands lower.
    const { width } = panelLayoutSize(withMode({ match: 0.5 }), HD);
    expect(width).toBe(1306);
  });

  it('shrink takes the larger ratio, expand the smaller', () => {
    expect(panelLayoutSize(withMode({ screenMatchMode: 'shrink' }), HD).width).toBe(1200);
    expect(panelLayoutSize(withMode({ screenMatchMode: 'expand' }), HD).width).toBe(1422);
  });

  it('constant pixel size lays out at the screen size, divided by the scale', () => {
    expect(panelLayoutSize(withMode({ scaleMode: 'constant-pixel', scale: 1 }), HD)).toEqual(HD);
    expect(panelLayoutSize(withMode({ scaleMode: 'constant-pixel', scale: 2 }), HD))
      .toEqual({ width: 960, height: 540 });
  });

  it('falls back to the screen rather than to nothing on a broken asset', () => {
    const broken = withMode({ referenceResolution: { width: 0, height: 0 } });
    expect(panelLayoutSize(broken, HD)).toEqual(HD);
  });
});

describe('findPanelSettingsRef', () => {
  const scene = `--- !u!1 &100
GameObject:
  m_Name: MainMenu UI
--- !u!114 &101
MonoBehaviour:
  m_EditorClassIdentifier: UnityEngine.dll::UnityEngine.UIElements.UIDocument
  m_PanelSettings: {fileID: 11400000, guid: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: 2}
  sourceAsset: {fileID: 9197481963319205126, guid: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, type: 3}
--- !u!114 &102
MonoBehaviour:
  m_EditorClassIdentifier: UnityEngine.dll::UnityEngine.UIElements.UIDocument
  m_PanelSettings: {fileID: 11400000, guid: cccccccccccccccccccccccccccccccc, type: 2}
  sourceAsset: {fileID: 1, guid: dddddddddddddddddddddddddddddddd, type: 3}
`;

  it('finds the panel of the UIDocument that renders this UXML', () => {
    expect(findPanelSettingsRef(scene, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))
      .toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('does not pair a UXML with another UIDocument’s panel', () => {
    // The reason this splits on the document separator: matching across the
    // whole file would hand the second document's UXML the first one's panel.
    expect(findPanelSettingsRef(scene, 'dddddddddddddddddddddddddddddddd'))
      .toBe('cccccccccccccccccccccccccccccccc');
  });

  it('accepts the pre-Unity-6 field name', () => {
    const old = scene.replace('sourceAsset:', 'm_VisualTreeAsset:');
    expect(findPanelSettingsRef(old, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))
      .toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('returns null when nothing renders it', () => {
    expect(findPanelSettingsRef(scene, 'ffffffffffffffffffffffffffffffff')).toBe(null);
  });
});

describe('guidFromMeta', () => {
  it('reads the guid', () => {
    expect(guidFromMeta('fileFormatVersion: 2\nguid: f0154438155644d28abb4c5d5375a045\n'))
      .toBe('f0154438155644d28abb4c5d5375a045');
  });

  it('ignores a guid that is nested under another key', () => {
    expect(guidFromMeta('ScriptedImporter:\n  script: {guid: aaaa}\n')).toBe(null);
  });
});
