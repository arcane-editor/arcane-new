import { create } from 'zustand';
import type { Notification, NotificationType, NotificationAction } from '../types';

interface AddNotificationParams {
  type: NotificationType;
  message: string;
  actions?: NotificationAction[];
  persistent?: boolean;
}

interface NotificationsState {
  notifications: Notification[];
  addNotification: (params: AddNotificationParams) => string;
  removeNotification: (id: string) => void;
  clearAll: () => void;
}

let nextId = 0;

/**
 * Hard cap on queued notifications — deliberately equal to the number the
 * toast container renders, so "stored" and "shown" can never diverge.
 *
 * They used to: the container rendered `notifications.slice(-3)` while the
 * store kept everything, and sticky entries (errors / `persistent`) never
 * expire. An unread error pushed past the visible window by newer toasts
 * stayed in the array and then POPPED BACK INTO VIEW seconds later, once
 * those newer toasts auto-dismissed — a toast reappearing out of nowhere
 * long after the event that caused it. The same mismatch also let the array
 * grow without bound across a long session, since nothing ever evicted the
 * entries that had scrolled out of view.
 */
export const MAX_NOTIFICATIONS = 3;

/** Sticky = requires an explicit dismiss; never auto-expires (see `addNotification`). */
function isSticky(n: Notification): boolean {
  return n.persistent === true || n.type === 'error';
}

/**
 * Drop oldest-first until the queue fits, preferring to evict dismissable
 * toasts so an unread error isn't silently displaced by routine chatter.
 * Falls back to evicting the oldest sticky when every slot is sticky —
 * bounded beats correct-but-invisible.
 */
function enforceCap(list: Notification[]): Notification[] {
  const out = [...list];
  while (out.length > MAX_NOTIFICATIONS) {
    const idx = out.findIndex((n) => !isSticky(n));
    out.splice(idx === -1 ? 0 : idx, 1);
  }
  return out;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  notifications: [],

  addNotification: ({ type, message, actions, persistent }) => {
    const id = `notif-${++nextId}`;
    set((state) => ({
      notifications: enforceCap([
        ...state.notifications,
        { id, type, message, createdAt: Date.now(), actions, persistent },
      ]),
    }));
    if (!persistent && type !== 'error') {
      setTimeout(() => get().removeNotification(id), 4000);
    }
    return id;
  },

  removeNotification: (id) => {
    set((state) => ({ notifications: state.notifications.filter((n) => n.id !== id) }));
  },

  clearAll: () => set({ notifications: [] }),
}));

export const notify = {
  info: (message: string) => useNotificationsStore.getState().addNotification({ type: 'info', message }),
  success: (message: string) => useNotificationsStore.getState().addNotification({ type: 'success', message }),
  warning: (message: string) => useNotificationsStore.getState().addNotification({ type: 'warning', message }),
  error: (message: string) => useNotificationsStore.getState().addNotification({ type: 'error', message }),
};
