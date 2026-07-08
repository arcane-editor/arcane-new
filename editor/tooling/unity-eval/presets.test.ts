import { describe, it, expect } from 'bun:test';
import { resolvePreset, PRESETS } from './presets';

const CF_ENV = { CF_ACCOUNT_ID: 'acct123' } as NodeJS.ProcessEnv;
const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe('resolvePreset', () => {
  it('passes explicit flags through unchanged when no preset is given', () => {
    const explicit = { baseUrl: 'https://x', apiKeyEnv: 'X', model: 'm', label: 'l' };
    expect(resolvePreset(undefined, explicit, EMPTY_ENV)).toEqual(explicit);
  });

  it('cf-mid fills in baseUrl (from CF_ACCOUNT_ID)/apiKeyEnv/model/label, matching the committed baseline label', () => {
    const resolved = resolvePreset('cf-mid', {}, CF_ENV);
    expect(resolved.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1');
    expect(resolved.apiKeyEnv).toBe('CF_API_TOKEN');
    expect(resolved.model).toBe('@cf/moonshotai/kimi-k2.7-code');
    expect(resolved.label).toBe('cf-mid-kimi-k2.7');
    expect(resolved.reasoningLevel).toBeUndefined();
  });

  it('cf-high resolves to the glm-5.2 model, matching the committed baseline label', () => {
    const resolved = resolvePreset('cf-high', {}, CF_ENV);
    expect(resolved.model).toBe('@cf/zai-org/glm-5.2');
    expect(resolved.label).toBe('cf-high-glm-5.2');
  });

  it('cf-low resolves to the qwen coder model', () => {
    const resolved = resolvePreset('cf-low', {}, CF_ENV);
    expect(resolved.model).toBe('@cf/qwen/qwen2.5-coder-32b-instruct');
    expect(resolved.label).toBe('cf-low-qwen2.5-coder');
  });

  it('cf-* baseUrl is undefined without CF_ACCOUNT_ID set (caller must still supply it explicitly)', () => {
    const resolved = resolvePreset('cf-mid', {}, EMPTY_ENV);
    expect(resolved.baseUrl).toBeUndefined();
  });

  it('server-mid resolves to the local arcane-server Variant B routing, with reasoningLevel set', () => {
    const resolved = resolvePreset('server-mid', {}, EMPTY_ENV);
    expect(resolved.baseUrl).toBe('http://localhost:8787/v1');
    expect(resolved.apiKeyEnv).toBe('DEV_JWT');
    expect(resolved.model).toBe('unused');
    expect(resolved.reasoningLevel).toBe('mid');
    expect(resolved.label).toBe('server-mid');
  });

  it('explicit flags override every preset-supplied field', () => {
    const resolved = resolvePreset(
      'cf-mid',
      { baseUrl: 'https://override', apiKeyEnv: 'OVERRIDE_ENV', model: 'my-model', label: 'my-label' },
      CF_ENV,
    );
    expect(resolved).toEqual({
      baseUrl: 'https://override',
      apiKeyEnv: 'OVERRIDE_ENV',
      model: 'my-model',
      reasoningLevel: undefined,
      label: 'my-label',
    });
  });

  it('throws on an unknown preset name, naming the valid options', () => {
    expect(() => resolvePreset('cf-ultra', {}, CF_ENV)).toThrow(/Unknown --preset "cf-ultra"/);
  });

  it('every preset in PRESETS has a non-empty apiKeyEnv, model, and label', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.apiKeyEnv.length, `${name}.apiKeyEnv`).toBeGreaterThan(0);
      expect(preset.model.length, `${name}.model`).toBeGreaterThan(0);
      expect(preset.label.length, `${name}.label`).toBeGreaterThan(0);
    }
  });
});
