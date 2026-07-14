/**
 * UserMessage — simple chat bubble for user-sent messages.
 * Renders any attachments staged at send time as a row of read-only chips
 * above the message text.
 */

import { memo } from 'react';
import type { AiMessage } from '../../../stores/ai';
import AttachmentChip from './AttachmentChip';

interface UserMessageProps {
  message: AiMessage;
}

function UserMessage({ message }: UserMessageProps) {
  return (
    <div className="ai-message user">
      <div className="ai-message-avatar">
        <span className="ai-user-avatar">U</span>
      </div>
      <div className="ai-message-content">
        {message.attachments && message.attachments.length > 0 && (
          <div className="ai-panel-attachments ai-panel-attachments--inline">
            {message.attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} removable={false} />
            ))}
          </div>
        )}
        <div className="ai-message-text">{message.text}</div>
      </div>
    </div>
  );
}

export default memo(UserMessage);
