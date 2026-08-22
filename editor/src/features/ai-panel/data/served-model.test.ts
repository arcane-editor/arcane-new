import { describe, it, expect } from 'bun:test';
import { modelShortName } from './served-model';

describe('modelShortName', () => {
  it('strips the provider prefix before the first slash', () => {
    expect(modelShortName('xai/grok-4.6')).toBe('grok-4.6');
    expect(modelShortName('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('for @cf/ ids strips ONLY the @cf/ prefix, keeping the rest verbatim (its own slash included)', () => {
    expect(modelShortName('@cf/qwen/x')).toBe('qwen/x');
    expect(modelShortName('@cf/meta/llama-3')).toBe('meta/llama-3');
  });

  it('passes an id with no slash through unchanged', () => {
    expect(modelShortName('gpt-4')).toBe('gpt-4');
  });

  it('only strips the FIRST slash for a non-@cf id with multiple segments', () => {
    expect(modelShortName('anthropic/claude-3/opus')).toBe('claude-3/opus');
  });
});
