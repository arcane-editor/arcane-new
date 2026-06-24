import type { Monaco } from '@monaco-editor/react';
import { shaderlabLanguage, shaderlabLanguageConfig } from './languages/shaderlab';
import { hlslLanguage, hlslLanguageConfig } from './languages/hlsl';
import { registerShaderCompletions } from './services/completions';
import { registerIncludeResolver } from './services/include-resolver';

/** Monaco language ids owned by this feature. */
const SHADERLAB_LANG_ID = 'shaderlab';
const HLSL_LANG_ID = 'hlsl';

let registered = false;
const intelligenceDisposers: Array<() => void> = [];

/**
 * Register ShaderLab + HLSL syntax highlighting AND intelligence (completions
 * + `#include` go-to-definition) in one idempotent call. Invoked from the
 * editor's `beforeMount`, so no extra App-level wiring is required.
 *
 * Highlighting (Monarch tokenizers + language config) and the completion /
 * definition providers are all language-scoped to `shaderlab` / `hlsl`, so
 * nothing here leaks into C#/TS/etc.
 */
export function registerShaderLanguages(monaco: Monaco): void {
  if (registered) return;
  registered = true;

  // Register ShaderLab language (.shader files)
  monaco.languages.register({ id: SHADERLAB_LANG_ID, extensions: ['.shader'] });
  monaco.languages.setMonarchTokensProvider(SHADERLAB_LANG_ID, shaderlabLanguage);
  monaco.languages.setLanguageConfiguration(SHADERLAB_LANG_ID, shaderlabLanguageConfig);

  // Register HLSL language (.hlsl, .cginc, .compute files)
  monaco.languages.register({ id: HLSL_LANG_ID, extensions: ['.hlsl', '.cginc', '.compute'] });
  monaco.languages.setMonarchTokensProvider(HLSL_LANG_ID, hlslLanguage);
  monaco.languages.setLanguageConfiguration(HLSL_LANG_ID, hlslLanguageConfig);

  // Intelligence: static completions (gated on `unity.shader.completions`) and
  // best-effort `#include` navigation. Disposers retained for `disposeShaderLanguages`.
  intelligenceDisposers.push(
    registerShaderCompletions(monaco, SHADERLAB_LANG_ID, HLSL_LANG_ID),
    registerIncludeResolver(monaco, SHADERLAB_LANG_ID, HLSL_LANG_ID),
  );

  console.log('[ShaderLanguages] Registered ShaderLab and HLSL languages + intelligence');
}

/**
 * Tear down the completion / definition providers and reset the registration
 * guard. Monaco language registration itself is process-global and can't be
 * un-registered, but disposing the providers is enough for hot-reload / test
 * teardown. Mostly here for symmetry and dispose-safety.
 */
export function disposeShaderLanguages(): void {
  for (const dispose of intelligenceDisposers.splice(0)) dispose();
  registered = false;
}
