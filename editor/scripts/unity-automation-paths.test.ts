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
