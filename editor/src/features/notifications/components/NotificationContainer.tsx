import { Info, CheckCircle, AlertTriangle, AlertCircle, X } from 'lucide-react';
import { useNotificationsStore } from '../../../stores/notifications';
import type { NotificationType } from '../../../types';

const ICON_MAP: Record<NotificationType, React.ReactNode> = {
  info: <Info size={16} className="notification-icon" />,
  success: <CheckCircle size={16} className="notification-icon" />,
  warning: <AlertTriangle size={16} className="notification-icon" />,
  error: <AlertCircle size={16} className="notification-icon" />,
};

export default function NotificationContainer() {
  const { notifications, removeNotification } = useNotificationsStore();

  if (notifications.length === 0) return null;

  const visible = notifications.slice(-3);

  return (
    <div className="notification-container">
      {visible.map((notif) => (
        <div key={notif.id} className={`notification-toast notification-${notif.type}`}>
          {ICON_MAP[notif.type]}
          <div className="notification-content">
            <span className="notification-message">{notif.message}</span>
            {notif.actions && notif.actions.length > 0 && (
              <div className="notification-actions">
                {notif.actions.map((a) => (
                  <button
                    key={a.label}
                    className="notification-action"
                    onClick={() => {
                      a.run();
                      removeNotification(notif.id);
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="notification-dismiss"
            onClick={() => removeNotification(notif.id)}
            title="Dismiss"
            aria-label="Dismiss notification"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
