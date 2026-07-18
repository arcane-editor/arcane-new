import { describe, expect, test } from 'bun:test';
import { ARCANE_API_URL, ARCANE_WEB_URL } from './api';

// bun test does not load .env.development (NODE_ENV=test), and editor/.env
// contains no VITE_ARCANE_* vars — so these assert the fail-safe fallbacks.
describe('api config', () => {
  test('falls back to the production API URL', () => {
    expect(ARCANE_API_URL).toBe('https://api.arcaneai.org');
  });
  test('falls back to the production web URL', () => {
    expect(ARCANE_WEB_URL).toBe('https://arcaneai.org');
  });
});
