/**
 * The `csharp` configuration section this editor reports to csharp-ls.
 *
 * csharp-ls asks for it with `workspace/configuration` right after
 * `initialized`, and accepts pushed updates via
 * `workspace/didChangeConfiguration`. The client used to answer that request
 * with `{}` for every item, which the server logged as "could not retrieve
 * `csharp` workspace configuration section" and then ignored — leaving every
 * option at its default. That was harmless until 0.24, where the default for
 * `analyzersEnabled` is **off**: the Unity analyzers would be referenced by the
 * project, loaded by Roslyn, and never asked to run.
 *
 * Field names come from `CSharpConfiguration` in the server's `Types.fs`.
 */

import { useSettingsStore } from '../../../stores/settings';

export interface CsharpConfiguration {
  /**
   * Run the analyzers the project references. Off by default in csharp-ls
   * "to avoid unexpected latency" — which is a real cost (each pull runs
   * every analyzer over the whole compilation) that the diagnostics cadence
   * in `providers.ts` is tuned around.
   */
  analyzersEnabled: boolean;
  /**
   * Let the editor own formatting options rather than the server. Monaco
   * already sends tab size and insert-spaces with every formatting request.
   */
  applyFormattingOptions: boolean;
  /**
   * `csharp:/` metadata URIs for decompiled sources. The editor has no
   * handler for that scheme, so asking for them would produce definitions
   * that open nothing.
   */
  useMetadataUris: boolean;
}

export function buildCsharpConfiguration(): CsharpConfiguration {
  return {
    analyzersEnabled: useSettingsStore.getState().getSetting('lsp.csharp.analyzers') !== false,
    applyFormattingOptions: false,
    useMetadataUris: false,
  };
}

/**
 * Answer one `workspace/configuration` item.
 *
 * The request carries a `section` per item and expects one result per item, in
 * order. Anything that is not the C# server's `csharp` section gets `{}` —
 * the server should see an empty section, not this editor's C# settings.
 */
export function configurationForItem(
  languageId: string,
  section: string | undefined,
): Record<string, unknown> {
  if (languageId !== 'csharp') return {};
  if (section !== undefined && section !== 'csharp') return {};
  return buildCsharpConfiguration() as unknown as Record<string, unknown>;
}

/** The `workspace/didChangeConfiguration` payload for a settings change. */
export function csharpConfigurationChange(): { settings: { csharp: CsharpConfiguration } } {
  return { settings: { csharp: buildCsharpConfiguration() } };
}
