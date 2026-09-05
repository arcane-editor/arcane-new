import { describe, it, expect, beforeEach } from 'bun:test';
import { useUpdatesStore } from './updates';

describe('useUpdatesStore', () => {
  beforeEach(() => useUpdatesStore.getState().clearPending());

  it('holds nothing until an update is staged', () => {
    expect(useUpdatesStore.getState().pending).toBeNull();
  });

  it('remembers the staged version and its platform behaviour', () => {
    useUpdatesStore.getState().setPending({ version: '0.3.3', installed: true });
    expect(useUpdatesStore.getState().pending).toEqual({ version: '0.3.3', installed: true });
  });

  it('replaces an earlier pending update rather than stacking one behind it', () => {
    // The watcher stops after staging, so a second event only happens after a
    // restart — but every window runs its own listener and the event is
    // broadcast to all of them. Last write wins; nothing queues.
    useUpdatesStore.getState().setPending({ version: '0.3.3', installed: true });
    useUpdatesStore.getState().setPending({ version: '0.3.4', installed: true });
    expect(useUpdatesStore.getState().pending?.version).toBe('0.3.4');
  });

  it('carries the Windows shape, where restarting still has work to do', () => {
    useUpdatesStore.getState().setPending({ version: '0.3.3', installed: false });
    expect(useUpdatesStore.getState().pending?.installed).toBe(false);
  });
});
