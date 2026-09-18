import { expect, it } from 'bun:test';

it('resolves Windows Unity Data and macOS Unity Resources layouts', async () => {
  const { compilerLayout } = await import('./unity-automation-paths');
  expect(compilerLayout('C:/Unity/Editor/Data', 'win32')).toEqual({
    scripting: 'C:\\Unity\\Editor\\Data',
    mono: 'C:\\Unity\\Editor\\Data\\MonoBleedingEdge\\bin\\mono.exe',
    csc: 'C:\\Unity\\Editor\\Data\\MonoBleedingEdge\\lib\\mono\\4.5\\csc.exe',
  });
  expect(compilerLayout('/Applications/Unity.app/Contents/Resources', 'darwin')).toEqual({
    scripting: '/Applications/Unity.app/Contents/Resources/Scripting',
    mono: '/Applications/Unity.app/Contents/Resources/Scripting/MonoBleedingEdge/bin/mono',
    csc: '/Applications/Unity.app/Contents/Resources/Scripting/MonoBleedingEdge/lib/mono/4.5/csc.exe',
  });
});

it('recognizes optional Input System sources with either path separator', async () => {
  const { isOptionalInputSource } = await import('./unity-automation-paths');
  expect(isOptionalInputSource('C:\\repo\\Editor\\InputSystem\\Adapter.cs')).toBe(true);
  expect(isOptionalInputSource('/repo/Editor/InputSystem/Adapter.cs')).toBe(true);
  expect(isOptionalInputSource('C:\\repo\\Editor\\Handlers\\Playtest.cs')).toBe(false);
});

it('reads the Unity version out of a Hub install path on every platform', async () => {
  const { unityVersionFromResources } = await import('./unity-automation-paths');
  expect(unityVersionFromResources('/Applications/Unity/Hub/Editor/6000.3.5f2/Unity.app/Contents/Resources')).toBe('6000.3.5f2');
  expect(unityVersionFromResources('C:\\Program Files\\Unity\\Hub\\Editor\\2022.3.62f1\\Editor\\Data')).toBe('2022.3.62f1');
  expect(unityVersionFromResources('/home/me/Unity/Hub/Editor/6000.5.0b3/Editor/Data/Resources')).toBe('6000.5.0b3');
  expect(unityVersionFromResources('/opt/unity-custom/Resources')).toBeNull();
});

it('defines every OR_NEWER symbol the resolved editor would, and none it would not', async () => {
  const { unityVersionDefines } = await import('./unity-automation-paths');
  const six3 = unityVersionDefines('6000.3.5f2');
  expect(six3).toContain('UNITY_2021_3_OR_NEWER');
  expect(six3).toContain('UNITY_2023_3_OR_NEWER');
  expect(six3).toContain('UNITY_6000_0_OR_NEWER');
  expect(six3).toContain('UNITY_6000_3_OR_NEWER');
  expect(six3).toContain('UNITY_6000_3');
  expect(six3).toContain('UNITY_6000');
  expect(six3).not.toContain('UNITY_6000_4_OR_NEWER');
  expect(new Set(six3).size).toBe(six3.length);

  const lts2022 = unityVersionDefines('2022.3.62f1');
  expect(lts2022).toContain('UNITY_2021_3_OR_NEWER');
  expect(lts2022).toContain('UNITY_2022_3_OR_NEWER');
  expect(lts2022).not.toContain('UNITY_2023_1_OR_NEWER');
  expect(lts2022).not.toContain('UNITY_6000_0_OR_NEWER');

  const six5 = unityVersionDefines('6000.5.0b3');
  expect(six5).toContain('UNITY_6000_4_OR_NEWER');
  expect(six5).toContain('UNITY_6000_5_OR_NEWER');
  expect(six5).not.toContain('UNITY_6000_6_OR_NEWER');

  const next = unityVersionDefines('7000.0.0a1');
  expect(next).toContain('UNITY_6000_9_OR_NEWER');
  expect(next).toContain('UNITY_7000_0_OR_NEWER');
  expect(() => unityVersionDefines('nonsense')).toThrow();
});
