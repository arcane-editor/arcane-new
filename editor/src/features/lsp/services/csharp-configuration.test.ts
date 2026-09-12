import { describe, expect, it, beforeEach } from 'bun:test';
import {
  buildCsharpConfiguration,
  configurationForItem,
  csharpConfigurationChange,
} from './csharp-configuration';
import { useSettingsStore } from '../../../stores/settings';

// What this protects: csharp-ls defaults `analyzersEnabled` to OFF. The client
// answered every `workspace/configuration` item with `{}`, which the server
// logged as "could not retrieve `csharp` workspace configuration section" and
// then ignored — so the Unity analyzers would be referenced by the project,
// loaded by Roslyn, and never asked to run. Nothing else in the pipeline says
// so, and the symptom is a file with no squiggles, which is what clean code
// looks like.

function setAnalyzers(enabled: boolean): void {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, 'lsp.csharp.analyzers': enabled },
  }));
}

beforeEach(() => {
  setAnalyzers(true);
});

describe('buildCsharpConfiguration', () => {
  it('turns the analyzers on, because the server will not', () => {
    expect(buildCsharpConfiguration().analyzersEnabled).toBe(true);
  });

  it('follows the setting when it is switched off', () => {
    setAnalyzers(false);
    expect(buildCsharpConfiguration().analyzersEnabled).toBe(false);
  });

  it('leaves formatting to the editor and metadata URIs alone', () => {
    // Monaco sends its own formatting options with every request, and the
    // editor has no handler for the `csharp:/` scheme — a definition into
    // decompiled source would open nothing.
    const config = buildCsharpConfiguration();
    expect(config.applyFormattingOptions).toBe(false);
    expect(config.useMetadataUris).toBe(false);
  });
});

describe('configurationForItem', () => {
  it('answers the csharp section for the csharp server', () => {
    expect(configurationForItem('csharp', 'csharp')).toMatchObject({
      analyzersEnabled: true,
    });
  });

  it('answers a section-less request, which is what csharp-ls sends', () => {
    expect(configurationForItem('csharp', undefined)).toMatchObject({
      analyzersEnabled: true,
    });
  });

  it('gives another language server nothing', () => {
    // typescript-language-server has no business receiving C# settings.
    expect(configurationForItem('typescript', 'csharp')).toEqual({});
    expect(configurationForItem('typescript', undefined)).toEqual({});
  });

  it('gives an unrelated section nothing', () => {
    expect(configurationForItem('csharp', 'editor')).toEqual({});
  });
});

describe('csharpConfigurationChange', () => {
  it('wraps the settings the way didChangeConfiguration expects', () => {
    // csharp-ls reads `settings.csharp`; a bare object at the top level is
    // silently ignored.
    expect(csharpConfigurationChange()).toEqual({
      settings: {
        csharp: {
          analyzersEnabled: true,
          applyFormattingOptions: false,
          useMetadataUris: false,
        },
      },
    });
  });
});
