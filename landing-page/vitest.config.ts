import { defineConfig } from 'vitest/config';

// Pure-function tests only: the modules under test must not require a DOM or
// an Astro build. Keep it that way — this harness exists for validators.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
