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

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  notifications: [],

  addNotification: ({ type, message, actions, persistent }) => {
    const id = `notif-${++nextId}`;
    set((state) => ({
      notifications: [
        ...state.notifications,
        { id, type, message, createdAt: Date.now(), actions, persistent },
      ],
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
