import { describe, it, expect } from 'bun:test';
import { unityNoiseExcludes, UNITY_NOISE_EXTENSIONS } from './unity-scope';

describe('unityNoiseExcludes', () => {
  it('excludes .meta sidecars', () => {
    expect(unityNoiseExcludes()).toContain('**/*.meta');
  });

  it('excludes every YAML asset extension', () => {
    const globs = unityNoiseExcludes();
    for (const ext of UNITY_NOISE_EXTENSIONS) {
      expect(globs).toContain(`**/*.${ext}`);
    }
  });

  it('produces one glob per extension and nothing else', () => {
    expect(unityNoiseExcludes()).toHaveLength(UNITY_NOISE_EXTENSIONS.length);
  });

  it('does NOT exclude source files a Unity programmer searches', () => {
    const globs = unityNoiseExcludes();
    for (const ext of ['cs', 'shader', 'hlsl', 'cginc', 'compute', 'asmdef', 'asmref', 'uxml', 'uss', 'json', 'inputactions', 'md']) {
      expect(globs).not.toContain(`**/*.${ext}`);
    }
  });

  it('returns a fresh array so a caller cannot mutate the shared list', () => {
    const a = unityNoiseExcludes();
    a.push('**/*.cs');
    expect(unityNoiseExcludes()).not.toContain('**/*.cs');
  });
});
