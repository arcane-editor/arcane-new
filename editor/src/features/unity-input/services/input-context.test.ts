import { describe, it, expect } from 'bun:test';
import { parseInputMeta, referencedByScene, assetStem } from './input-context';

/** A real `.inputactions.meta`, copied verbatim from a Unity 6 project. */
const META_NO_WRAPPER = `fileFormatVersion: 2
guid: 052faaac586de48259a63d0c4782560b
ScriptedImporter:
  internalIDToNameTable: []
  externalObjects: {}
  serializedVersion: 2
  userData: 
  assetBundleName: 
  assetBundleVariant: 
  script: {fileID: 11500000, guid: 8404be70184654265930450def6a9037, type: 3}
  generateWrapperCode: 0
  wrapperCodePath: 
  wrapperClassName: 
  wrapperCodeNamespace: 
`;

const META_WRAPPER_DEFAULTED = META_NO_WRAPPER.replace(
  'generateWrapperCode: 0',
  'generateWrapperCode: 1',
);

const META_WRAPPER_NAMED = META_WRAPPER_DEFAULTED
  .replace('wrapperClassName: ', 'wrapperClassName: PlayerControls')
  .replace('wrapperCodePath: ', 'wrapperCodePath: Assets/Input/PlayerControls.cs');

const PATH = 'Assets/Input/InputSystem_Actions.inputactions';

describe('parseInputMeta', () => {
  it('reads the guid', () => {
    expect(parseInputMeta(META_NO_WRAPPER, PATH).guid)
      .toBe('052faaac586de48259a63d0c4782560b');
  });

  it('reports no wrapper when generation is off', () => {
    expect(parseInputMeta(META_NO_WRAPPER, PATH).wrapper).toBe(null);
  });

  it('falls back to the asset file name when the class name is blank', () => {
    // The most common configuration: generation ticked, name left empty, Unity
    // names the class after the asset. Treating blank as "no wrapper" would
    // leave the majority case undetected — which is the entire blind spot.
    const meta = parseInputMeta(META_WRAPPER_DEFAULTED, PATH);
    expect(meta.wrapper).not.toBe(null);
    expect(meta.wrapper!.className).toBe('InputSystem_Actions');
    expect(meta.wrapper!.path).toBe(null);
  });

  it('prefers an explicit class name and path', () => {
    const meta = parseInputMeta(META_WRAPPER_NAMED, PATH);
    expect(meta.wrapper!.className).toBe('PlayerControls');
    expect(meta.wrapper!.path).toBe('Assets/Input/PlayerControls.cs');
  });

  it('does not mistake the importer script guid for the asset guid', () => {
    // The meta contains TWO guids; only the top-level one identifies the asset.
    expect(parseInputMeta(META_NO_WRAPPER, PATH).guid)
      .not.toBe('8404be70184654265930450def6a9037');
  });

  it('survives a truncated meta without throwing', () => {
    expect(() => parseInputMeta('fileFormatVersion: 2\nguid:', PATH)).not.toThrow();
    expect(parseInputMeta('', PATH).guid).toBe(null);
  });
});

describe('assetStem', () => {
  it('strips the directory and the extension', () => {
    expect(assetStem('Assets/Input/Controls.inputactions')).toBe('Controls');
  });

  it('handles a bare file name', () => {
    expect(assetStem('Controls.inputactions')).toBe('Controls');
  });
});

describe('referencedByScene', () => {
  it('counts scenes and prefabs, which can carry Inspector wiring', () => {
    expect(referencedByScene(['Assets/Scenes/Main.unity'])).toBe(true);
    expect(referencedByScene(['Assets/Prefabs/Player.prefab'])).toBe(true);
  });

  it('ignores hits that cannot wire an InputActionReference', () => {
    // A .asset or a .meta referencing the guid says nothing about Inspector
    // wiring, so it must not suppress the unread verdict.
    expect(referencedByScene(['Assets/Settings/Thing.asset'])).toBe(false);
    expect(referencedByScene([])).toBe(false);
  });

  it('is case-insensitive about the extension', () => {
    expect(referencedByScene(['Assets/Scenes/Main.UNITY'])).toBe(true);
  });
});
