import { describe, it, expect } from 'bun:test';
import { inspectorView, scriptPathGate } from './so-inspector-gate';

const WS = '/proj';
// Stands in for `classifyFile(rel) === FilePriority.MonoBehaviour`, whose own
// rule is `csharp`'s to own and test.
const isRuntimeScript = (rel: string) =>
  rel.startsWith('Assets/') && !rel.startsWith('Assets/Editor/');
const gate = (activeFilePath: string | null, over = {}) =>
  scriptPathGate({
    isUnityProject: true,
    workspacePath: WS,
    activeFilePath,
    isRuntimeScript,
    ...over,
  });

describe('scriptPathGate', () => {
  it('accepts a runtime script under Assets/', () => {
    expect(gate('/proj/Assets/Combat/WeaponDef.cs')).toEqual({
      abs: '/proj/Assets/Combat/WeaponDef.cs',
      rel: 'Assets/Combat/WeaponDef.cs',
    });
  });

  it('honours the injected runtime-script classifier', () => {
    expect(gate('/proj/Assets/Editor/WeaponDefEditor.cs')).toBeNull();
  });

  it('rejects a non-script file', () => {
    expect(gate('/proj/Assets/Data/Sword.asset')).toBeNull();
  });

  it('rejects virtual tabs, which are not files on disk', () => {
    expect(gate('diff:///proj/Assets/A.cs')).toBeNull();
    expect(gate('auth://callback')).toBeNull();
  });

  it('rejects a script outside the workspace', () => {
    expect(gate('/elsewhere/Assets/A.cs')).toBeNull();
  });

  it('rejects a script outside Assets/', () => {
    expect(gate('/proj/Packages/foo/A.cs')).toBeNull();
  });

  it('requires a Unity project, a workspace and an open file', () => {
    expect(gate('/proj/Assets/A.cs', { isUnityProject: false })).toBeNull();
    expect(gate('/proj/Assets/A.cs', { workspacePath: null })).toBeNull();
    expect(gate(null)).toBeNull();
  });

  it('tolerates a workspace path with a trailing slash', () => {
    expect(
      scriptPathGate({
        isUnityProject: true,
        workspacePath: '/proj/',
        activeFilePath: '/proj/Assets/A.cs',
        isRuntimeScript,
      })?.rel,
    ).toBe('Assets/A.cs');
  });
});

describe('inspectorView', () => {
  it('shows the tabs for a ScriptableObject', () => {
    expect(inspectorView('scriptableObject', 0)).toBe('tabs');
  });

  it('keeps the usage list for a MonoBehaviour', () => {
    expect(inspectorView('monoBehaviour', 5)).toBe('sceneUsage');
  });

  it('promotes an unresolved base when instances of it exist on disk', () => {
    // `WeaponDef : BaseDef` with `BaseDef : ScriptableObject` in another file.
    // An .asset whose m_Script points here could not exist unless this really
    // is a ScriptableObject, so the project answers what the syntax cannot.
    expect(inspectorView('unknown', 3)).toBe('tabs');
  });

  it('falls back to the usage list when an unresolved base has no instances', () => {
    expect(inspectorView('unknown', 0)).toBe('sceneUsage');
  });
});
