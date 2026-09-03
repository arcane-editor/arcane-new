import { describe, it, expect } from 'bun:test';
import { resolveStyleHref, normalisePath } from './style-resolve';

const UXML = 'Assets/UI/MainMenu.uxml';
const GUIDS: Record<string, string> = {
  f0154438155644d28abb4c5d5375a045: 'Assets/UI/MainMenu.uss',
};
const byGuid = (g: string) => GUIDS[g] ?? null;
const none = () => null;

describe('normalisePath', () => {
  it('collapses . and ..', () => {
    expect(normalisePath('Assets/UI/../Styles/./Theme.uss')).toBe('Assets/Styles/Theme.uss');
  });
});

describe('resolveStyleHref', () => {
  it('prefers the guid, because it survives the asset being moved', () => {
    const raw =
      'project://database/Assets/OLD/Path.uss?fileID=7433441132597879392&amp;guid=f0154438155644d28abb4c5d5375a045&amp;type=3#MainMenu';
    // The literal path in the src is stale; the guid is not.
    expect(resolveStyleHref(raw, 'src', UXML, byGuid).path).toBe('Assets/UI/MainMenu.uss');
  });

  it('falls back to the project path when the guid is unknown', () => {
    const raw =
      'project://database/Assets/UI/MainMenu.uss?fileID=1&amp;guid=f0154438155644d28abb4c5d5375a045&amp;type=3';
    expect(resolveStyleHref(raw, 'src', UXML, none).path).toBe('Assets/UI/MainMenu.uss');
  });

  it('reads a bare project:// uri with no query', () => {
    const raw = 'project://database/Packages/com.unity.x/Editor/HelpButton.uss';
    expect(resolveStyleHref(raw, 'src', UXML, none).path)
      .toBe('Packages/com.unity.x/Editor/HelpButton.uss');
  });

  it('resolves a relative src against the document that named it', () => {
    expect(resolveStyleHref('MainMenu.uss', 'src', UXML, none).path)
      .toBe('Assets/UI/MainMenu.uss');
    expect(resolveStyleHref('../Shared/Theme.uss', 'src', UXML, none).path)
      .toBe('Assets/Shared/Theme.uss');
  });

  it('percent-decodes a path with spaces', () => {
    const raw = 'project://database/Assets/Core%20RP%20Library/Styles.uss';
    expect(resolveStyleHref(raw, 'src', UXML, none).path)
      .toBe('Assets/Core RP Library/Styles.uss');
  });

  it('says why a Resources-relative path is unresolved rather than guessing', () => {
    const got = resolveStyleHref('Styles/Theme', 'path', UXML, none);
    expect(got.path).toBe(null);
    expect(got.reason).toContain('Resources-relative');
  });

  it('reports an unreadable src instead of returning a bogus path', () => {
    const got = resolveStyleHref('', 'src', UXML, none);
    expect(got.path).toBe(null);
    expect(got.reason).toBeTruthy();
  });
});
