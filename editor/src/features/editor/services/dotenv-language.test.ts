import { describe, expect, it } from 'bun:test';
import { DOTENV_LANG_ID, registerDotEnvLanguage } from './dotenv-language';
import { getMonacoLanguageId } from '../../../utils/language-detect';

interface Registered {
  id: string;
  filenames?: string[];
  filenamePatterns?: string[];
}

/** Captures what registerDotEnvLanguage tells Monaco, without a real Monaco. */
function fakeMonaco() {
  const registrations: Registered[] = [];
  const configs: Record<string, { comments?: { lineComment?: string } }> = {};
  const tokenizers: string[] = [];
  return {
    calls: { registrations, configs, tokenizers },
    monaco: {
      languages: {
        register: (spec: Registered) => registrations.push(spec),
        setLanguageConfiguration: (id: string, cfg: { comments?: { lineComment?: string } }) => {
          configs[id] = cfg;
        },
        setMonarchTokensProvider: (id: string) => tokenizers.push(id),
      },
    },
  };
}

describe('registerDotEnvLanguage', () => {
  // Registration is guarded by module-level state (Monaco's language registry
  // is process-global), so only the first call in this file does anything —
  // hence one test covering the whole registration rather than several that
  // would silently observe a no-op.
  it('registers dotenv with the lineComment that makes Cmd+/ work, and only once', () => {
    const { monaco, calls } = fakeMonaco();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDotEnvLanguage(monaco as any);

    expect(calls.registrations.some((r) => r.id === DOTENV_LANG_ID)).toBe(true);
    expect(calls.tokenizers).toContain(DOTENV_LANG_ID);

    // The load-bearing assertion. Monaco's editor.action.commentLine looks up
    // comments.lineComment and silently no-ops when it is absent ("Mode does
    // not support line comments") — which is exactly why .env files could not
    // be commented while they resolved to plaintext.
    expect(calls.configs[DOTENV_LANG_ID]?.comments?.lineComment).toBe('#');

    // Idempotent: beforeMount fires per editor instance.
    const afterFirst = calls.registrations.length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerDotEnvLanguage(monaco as any);
    expect(calls.registrations.length).toBe(afterFirst);
  });

  // The two halves have to agree or the language is registered but never used.
  it('uses the same id that language-detect resolves .env to', () => {
    expect(getMonacoLanguageId('.env')).toBe(DOTENV_LANG_ID);
    expect(getMonacoLanguageId('.env.production')).toBe(DOTENV_LANG_ID);
  });
});
