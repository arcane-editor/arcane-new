import { describe, it, expect, beforeEach } from 'bun:test';
import { useNotificationsStore, MAX_NOTIFICATIONS } from './notifications';

function ids() {
  return useNotificationsStore.getState().notifications.map((n) => n.message);
}

describe('notifications store', () => {
  beforeEach(() => {
    useNotificationsStore.getState().clearAll();
  });

  it('caps the queue at MAX_NOTIFICATIONS so nothing is stored-but-unrendered', () => {
    for (let i = 0; i < MAX_NOTIFICATIONS + 3; i++) {
      useNotificationsStore.getState().addNotification({ type: 'info', message: `m${i}`, persistent: true });
    }
    expect(useNotificationsStore.getState().notifications).toHaveLength(MAX_NOTIFICATIONS);
  });

  // The resurfacing bug: an error (never auto-expires) used to be pushed out of
  // the rendered `slice(-3)` window by newer toasts while staying in the array,
  // then pop back into view seconds later when those newer toasts expired.
  // The container now renders the queue verbatim, so "stored" == "shown" and
  // an entry can never be hidden-then-restored: it stays put until evicted or
  // dismissed, and the queue never exceeds what the container draws.
  it('keeps an unread error continuously queued while newer toasts come and go', () => {
    const errId = useNotificationsStore.getState().addNotification({ type: 'error', message: 'boom' });
    const transient: string[] = [];
    for (let i = 0; i < MAX_NOTIFICATIONS; i++) {
      // Dismissable (non-persistent, non-error) — the routine chatter that
      // used to bury the error without evicting it.
      transient.push(
        useNotificationsStore.getState().addNotification({ type: 'info', message: `t${i}` }),
      );
    }

    // Never more than the container renders — no stored-but-invisible backlog.
    expect(useNotificationsStore.getState().notifications.length).toBeLessThanOrEqual(
      MAX_NOTIFICATIONS,
    );
    // The error was never hidden, so it has nothing to resurface from.
    expect(useNotificationsStore.getState().notifications.some((n) => n.id === errId)).toBe(true);

    // Draining the newer toasts leaves exactly the still-unread error.
    for (const id of transient) useNotificationsStore.getState().removeNotification(id);
    expect(ids()).toEqual(['boom']);
  });

  it('evicts the oldest dismissable notification before a sticky one', () => {
    useNotificationsStore.getState().addNotification({ type: 'error', message: 'sticky' });
    for (let i = 0; i < MAX_NOTIFICATIONS - 1; i++) {
      useNotificationsStore.getState().addNotification({ type: 'info', message: `i${i}` });
    }
    // Queue is full: one sticky error + (MAX-1) dismissables.
    useNotificationsStore.getState().addNotification({ type: 'info', message: 'newest' });

    const msgs = ids();
    expect(msgs).toContain('sticky'); // the error survived
    expect(msgs).toContain('newest');
    expect(msgs).not.toContain('i0'); // oldest dismissable went instead
  });

  it('falls back to evicting the oldest sticky when every slot is sticky', () => {
    for (let i = 0; i < MAX_NOTIFICATIONS; i++) {
      useNotificationsStore.getState().addNotification({ type: 'error', message: `e${i}` });
    }
    useNotificationsStore.getState().addNotification({ type: 'error', message: 'newest' });

    const msgs = ids();
    expect(msgs).toHaveLength(MAX_NOTIFICATIONS);
    expect(msgs).not.toContain('e0');
    expect(msgs).toContain('newest');
  });
});
