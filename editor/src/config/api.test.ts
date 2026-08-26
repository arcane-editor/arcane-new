import { describe, expect, test } from 'bun:test';
import { API_URL, WEB_URL } from './api';

// bun test does not load .env.development (NODE_ENV=test), and editor/.env
// contains no VITE_* vars — so these assert the fail-safe fallbacks.
describe('api config', () => {
  test('falls back to the production API URL', () => {
    expect(API_URL).toBe('https://api.unityide.app');
  });
  test('falls back to the production web URL', () => {
    expect(WEB_URL).toBe('https://unityide.app');
  });
});
