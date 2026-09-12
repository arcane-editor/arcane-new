import { describe, expect, it, beforeEach } from 'bun:test';
import {
  roslynAnalyzersInjected,
  roslynAnalyzersReporting,
  setRoslynAnalyzersInjected,
} from './roslyn-analyzers-state';

// What this protects: the local Unity rules stand down for the inspections the
// Roslyn analyzers cover better, and standing down is only safe while those
// analyzers are actually reporting. The first version of this module checked
// one of the three conditions — that the generated csproj names the analyzer
// assembly — and the consequence was precise and silent: unticking "Roslyn
// Analyzers (Unity)" made every UNT marker disappear while the rules they had
// superseded stayed switched off. Three inspections vanished from both engines
// at once, with nothing reported anywhere.

beforeEach(() => {
  setRoslynAnalyzersInjected(false);
});

describe('roslynAnalyzersInjected', () => {
  it('starts false, so the fallback rules run until Roslyn is known to be live', () => {
    expect(roslynAnalyzersInjected()).toBe(false);
  });

  it('records what unity_setup_lsp reported', () => {
    setRoslynAnalyzersInjected(true);
    expect(roslynAnalyzersInjected()).toBe(true);
    setRoslynAnalyzersInjected(false);
    expect(roslynAnalyzersInjected()).toBe(false);
  });
});

describe('roslynAnalyzersReporting', () => {
  const live = { analyzersEnabled: true, serverRunning: true };

  it('is true only when all three conditions hold', () => {
    setRoslynAnalyzersInjected(true);
    expect(roslynAnalyzersReporting(live)).toBe(true);
  });

  it('is false when the user switched the analyzers off', () => {
    // csharp-ls runs no analyzer pipeline at all with analyzersEnabled false,
    // so every UNT diagnostic disappears — and the local rules must return.
    setRoslynAnalyzersInjected(true);
    expect(roslynAnalyzersReporting({ ...live, analyzersEnabled: false })).toBe(false);
  });

  it('is false when the C# server is not running', () => {
    // It can exhaust its restart budget, and the csproj says nothing about that.
    setRoslynAnalyzersInjected(true);
    expect(roslynAnalyzersReporting({ ...live, serverRunning: false })).toBe(false);
  });

  it('is false when the csproj never named the analyzer', () => {
    expect(roslynAnalyzersReporting(live)).toBe(false);
  });

  it('needs every condition, not any', () => {
    for (const injected of [false, true]) {
      for (const analyzersEnabled of [false, true]) {
        for (const serverRunning of [false, true]) {
          setRoslynAnalyzersInjected(injected);
          expect(roslynAnalyzersReporting({ analyzersEnabled, serverRunning })).toBe(
            injected && analyzersEnabled && serverRunning,
          );
        }
      }
    }
  });
});
