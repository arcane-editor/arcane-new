import { expect, it } from 'bun:test';
import { createSetupLease } from './setup-lease';

it('releases an ownership response that arrives after its effect was cleaned up', async () => {
  let respond!: (allowed: boolean) => void;
  const calls: Array<{ command: string; lease: string }> = [];
  const owner = createSetupLease('welcome', 'old-effect', async (command, args) => {
    calls.push({ command, lease: args.lease });
    if (command === 'claim_editor_setup') return new Promise<boolean>((resolve) => { respond = resolve; });
  });
  const pending = owner.claim();
  await owner.release();
  respond(true);
  expect(await pending).toBe(false);
  expect(calls).toEqual([
    { command: 'claim_editor_setup', lease: 'old-effect' },
    { command: 'release_editor_setup', lease: 'old-effect' },
  ]);
  expect(await owner.claim()).toBe(false);
});

it('keeps a StrictMode successor owned when its predecessor releases late', async () => {
  let current: string | null = null;
  const readCurrent = (): string | null => current;
  let releaseOld!: () => void;
  const native = async (command: string, args: { windowLabel: string; lease: string }) => {
    if (command === 'claim_editor_setup') { current = args.lease; return true; }
    if (args.lease === 'old-effect') await new Promise<void>((resolve) => { releaseOld = resolve; });
    if (current === args.lease) current = null;
  };
  const old = createSetupLease('welcome', 'old-effect', native);
  const next = createSetupLease('welcome', 'new-effect', native);
  expect(await old.claim()).toBe(true);
  const lateRelease = old.release();
  expect(await next.claim()).toBe(true);
  releaseOld();
  await lateRelease;
  expect(readCurrent()).toBe('new-effect');
  await next.release();
  expect(readCurrent()).toBeNull();
});

it('retries a denied claim and keeps only one native claim in flight', async () => {
  let respond!: (allowed: boolean) => void;
  let calls = 0;
  const owner = createSetupLease('welcome', 'effect', async (command) => {
    if (command === 'claim_editor_setup') {
      calls++;
      return new Promise<boolean>((resolve) => { respond = resolve; });
    }
  });
  const first = owner.claim();
  expect(await owner.claim()).toBe(false);
  respond(false);
  expect(await first).toBe(false);
  const second = owner.claim();
  respond(true);
  expect(await second).toBe(true);
  expect(await owner.claim()).toBe(true);
  expect(calls).toBe(2);
  await owner.release();
});
