import { Info, CheckCircle, AlertTriangle, AlertCircle, X } from 'lucide-react';
import { useNotificationsStore } from '../../../stores/notifications';
import type { NotificationType } from '../../../types';

const ICON_MAP: Record<NotificationType, React.ReactNode> = {
  info: <Info size={16} className="notif-icon notif-icon--info" />,
  success: <CheckCircle size={16} className="notif-icon notif-icon--success" />,
  warning: <AlertTriangle size={16} className="notif-icon notif-icon--warning" />,
  error: <AlertCircle size={16} className="notif-icon notif-icon--error" />,
};

export default function NotificationContainer() {
  const { notifications, removeNotification } = useNotificationsStore();

  if (notifications.length === 0) return null;

  const visible = notifications.slice(-3);

  return (
    <div className="notif-container">
      {visible.map((notif) => (
        <div key={notif.id} className={`notif-toast notif-toast--${notif.type}`}>
          {ICON_MAP[notif.type]}
          <div className="notif-content" style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>
            <span className="notif-message">{notif.message}</span>
            {notif.actions && notif.actions.length > 0 && (
              <div className="notif-actions" style={{ display: 'flex', gap: 8 }}>
                {notif.actions.map((a) => (
                  <button
                    key={a.label}
                    className="notif-action"
                    onClick={() => {
                      a.run();
                      removeNotification(notif.id);
                    }}
                    style={{
                      padding: '3px 10px',
                      fontSize: 11,
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-primary)',
                      borderRadius: 3,
                      cursor: 'pointer',
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="notif-dismiss"
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
