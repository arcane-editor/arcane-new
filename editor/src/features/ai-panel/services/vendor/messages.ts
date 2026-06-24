/**
 * Message conversion - adapted from PI coding agent
 * packages/coding-agent/src/core/messages.ts
 *
 * Converts AgentMessage[] (which may include custom types like bashExecution)
 * to standard Message[] for the LLM.
 */

import type {
  AgentMessage,
  Message,
  UserMessage,
  BashExecutionMessage,
} from './types';

/**
 * Convert agent messages to LLM-compatible messages.
 * Custom message types (bashExecution) are converted to user messages.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  const result: Message[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
      case 'assistant':
      case 'toolResult':
        result.push(msg);
        break;
      case 'bashExecution':
        result.push(bashExecutionToUserMessage(msg));
        break;
      default:
        // Unknown custom message — skip
        break;
    }
  }

  return result;
}

function bashExecutionToUserMessage(msg: BashExecutionMessage): UserMessage {
  const parts: string[] = [];
  parts.push(`Command: ${msg.command}`);

  if (msg.output) {
    parts.push(`Output:\n${msg.output}`);
  }

  if (msg.exitCode !== undefined) {
    parts.push(`Exit code: ${msg.exitCode}`);
  }

  if (msg.cancelled) {
    parts.push('(cancelled)');
  }

  if (msg.truncated) {
    parts.push('(output truncated)');
  }

  return {
    role: 'user',
    content: parts.join('\n'),
    timestamp: msg.timestamp,
  };
}
