import { describe, it, expect } from 'bun:test';
import { choosePanel } from './panel-resolve';

const PANEL = (name: string) => `MonoBehaviour:
  m_Name: ${name}
  m_EditorClassIdentifier: UnityEngine.dll::UnityEngine.UIElements.PanelSettings
  m_ScaleMode: 1
  m_ReferenceResolution: {x: 1200, y: 800}
  m_ScreenMatchMode: 0
  m_Match: 0
`;

const SCENE = `--- !u!114 &101
MonoBehaviour:
  m_PanelSettings: {fileID: 11400000, guid: 22222222222222222222222222222222, type: 2}
  sourceAsset: {fileID: 91, guid: 11111111111111111111111111111111, type: 3}
`;

const GUIDS: Record<string, string> = {
  'Assets/UI/Menu.asset': '22222222222222222222222222222222',
  'Assets/UI/Other.asset': '33333333333333333333333333333333',
};
const guidOf = (path: string) => GUIDS[path] ?? null;

const assets = [
  { path: 'Assets/UI/Other.asset', content: PANEL('Other') },
  { path: 'Assets/UI/Menu.asset', content: PANEL('Menu') },
];
const scenes = [{ path: 'Assets/Scenes/Sample.unity', content: SCENE }];

describe('choosePanel', () => {
  it('prefers the panel a UIDocument actually renders this UXML through', () => {
    // `Other` sorts first and would win any "just take one" rule; the wiring
    // is what makes this an answer instead of a guess.
    const got = choosePanel('11111111111111111111111111111111', scenes, assets, guidOf);
    expect(got.confidence).toBe('wired');
    expect(got.settings!.name).toBe('Menu');
  });

  it('takes the only panel in the project without needing a wiring', () => {
    const got = choosePanel(null, [], [assets[0]], guidOf);
    expect(got.confidence).toBe('only');
    expect(got.candidates).toBe(1);
  });

  it('says so when several exist and none is wired', () => {
    // The caller shows this differently: an assumption has to look like one.
    const got = choosePanel('ffffffffffffffffffffffffffffffff', scenes, assets, guidOf);
    expect(got.confidence).toBe('ambiguous');
    expect(got.candidates).toBe(2);
  });

  it('ignores .asset files that are not PanelSettings', () => {
    const got = choosePanel(null, [], [{ path: 'a.asset', content: 'MonoBehaviour:\n  m_Name: Weapon\n' }], guidOf);
    expect(got.confidence).toBe('none');
    expect(got.settings).toBe(null);
  });
});
