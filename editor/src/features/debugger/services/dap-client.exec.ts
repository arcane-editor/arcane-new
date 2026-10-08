import { afterAll, expect, it, mock } from 'bun:test';
let stop: () => Promise<unknown> = async () => undefined;
mock.module('@tauri-apps/api/core', () => ({ invoke: async () => stop() }));
mock.module('../../../utils/tauri-listener', () => ({ listenScoped: async () => () => {} }));
const { dapClient } = await import('./dap-client');
afterAll(() => mock.restore());
it('does not signal exit until native shutdown completes, and propagates failure', async () => {
  let exited = 0;
  dapClient.on('__exited', () => exited++);
  stop = async () => { throw new Error('detach not acknowledged'); };
  await expect(dapClient.stop()).rejects.toThrow('detach not acknowledged');
  expect(exited).toBe(0);
  let complete!: () => void;
  stop = () => new Promise<void>(resolve => { complete = resolve; });
  const pending = dapClient.stop();
  expect(exited).toBe(0);
  complete(); await pending;
  expect(exited).toBe(1);
});
