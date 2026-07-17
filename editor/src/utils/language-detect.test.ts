import { describe, expect, it } from 'bun:test';
import { detectLanguage, getMonacoLanguageId } from './language-detect';

describe('detectLanguage — extensions', () => {
  it('resolves ordinary extensions', () => {
    expect(getMonacoLanguageId('Foo.cs')).toBe('csharp');
    expect(getMonacoLanguageId('a/b/main.ts')).toBe('typescript');
    expect(getMonacoLanguageId('style.css')).toBe('css');
  });

  it('is case-insensitive', () => {
    expect(getMonacoLanguageId('README.MD')).toBe('markdown');
  });

  it('falls back to plaintext for genuinely unknown files', () => {
    expect(getMonacoLanguageId('notes.xyz')).toBe('plaintext');
    expect(getMonacoLanguageId('LICENSE')).toBe('plaintext');
  });
});

// A dotfile has no extension in the usual sense — `.env`'s last dot-segment is
// "env", which isn't an extension anyone registers. Resolving these by BASENAME
// is what makes Cmd+/ work in them: Monaco's comment action is a silent no-op
// unless the language declares a lineComment, and plaintext declares none.
describe('detectLanguage — .env files', () => {
  it('resolves a bare .env', () => {
    expect(getMonacoLanguageId('.env')).toBe('dotenv');
    expect(detectLanguage('.env').displayName).toBe('DotEnv');
  });

  it('resolves .env variants', () => {
    for (const name of [
      '.env.local',
      '.env.production',
      '.env.development.local',
      '.env.test',
      '.env.example',
      '.env.sample',
    ]) {
      expect(getMonacoLanguageId(name)).toBe('dotenv');
    }
  });

  it('resolves .env by full path, not just bare filename', () => {
    expect(getMonacoLanguageId('/Users/me/api/.env')).toBe('dotenv');
    expect(getMonacoLanguageId('api/scripts/.env.production')).toBe('dotenv');
  });

  it('resolves conventional non-dotted env filenames', () => {
    expect(getMonacoLanguageId('env.example')).toBe('dotenv');
  });

  // Don't hijack real files that merely contain "env".
  it('does not claim unrelated files', () => {
    expect(getMonacoLanguageId('environment.ts')).toBe('typescript');
    expect(getMonacoLanguageId('env.json')).toBe('json');
    expect(getMonacoLanguageId('src/env.ts')).toBe('typescript');
    expect(getMonacoLanguageId('.envrc')).toBe('plaintext'); // direnv, not dotenv
  });

  it('has no LSP server', () => {
    expect(detectLanguage('.env').lspServerKey).toBeUndefined();
  });
});
