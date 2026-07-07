import { mock } from 'bun:test';

// Some services import zustand stores that transitively pull in the full app
// module graph (UI components -> Monaco -> browser-only globals like
// `window`/`document`, plus boot-order-dependent circular store imports).
// Those stores are irrelevant to pure-function unit tests, so stub the ones
// known to drag in that chain rather than loading the real modules under
// `bun test` (which has no DOM and doesn't run the app's boot sequence).
mock.module('../src/stores/graphify', () => ({
  useGraphifyStore: {
    getState: () => ({ status: 'absent' as const, summary: null, enrichment: null }),
  },
}));
