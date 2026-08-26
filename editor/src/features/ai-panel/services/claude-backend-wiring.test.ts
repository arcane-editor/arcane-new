import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// `claude-backend.ts` reaches the stores (and through them `document`), so it
// cannot be imported under Bun. Its wiring is asserted against source text —
// the same convention as `agent-service-wiring.test.ts`.
const SRC = readFileSync(path.resolve(import.meta.dir, './claude-backend.ts'), 'utf8');
const LIST = readFileSync(
  path.resolve(import.meta.dir, '../components/MessageList.tsx'),
  'utf8',
);

/**
 * From a real 2026-08-24 trace: one Claude Code turn delivered 27 `tool_call`
 * and 108 `tool_call_update` notifications with zero errors, and the panel
 * showed a single sentence for minutes while the agent edited files.
 *
 * The chain that renders a tool call is: a `toolCall` CONTENT BLOCK inside an
 * assistant message → `AssistantMessage` maps it to `ToolCallBlock` →
 * `ToolCallBlock` looks its live status up in the `toolCalls` Map by id.
 *
 * The ACP path only ever emitted `tool_execution_start`, which fills the Map
 * and nothing else, and then CLOSED the assistant bubble — so the calls had no
 * content block to render from and vanished. UnityIDE's own loop gets this right
 * because `agent-loop.ts` puts `toolCall` blocks in the assistant message.
 */
describe('claude-backend — tool calls must become assistant content blocks', () => {
  const startToolCall = SRC.slice(
    SRC.indexOf('private startToolCall('),
    SRC.indexOf('private updateToolCall('),
  );

  it('has a startToolCall to inspect', () => {
    expect(startToolCall.length).toBeGreaterThan(0);
  });

  it('still fills the toolCalls Map, which is where live status lives', () => {
    expect(startToolCall).toContain("type: 'tool_execution_start'");
  });

  // The regression guard.
  it('puts the call into the assistant message as a toolCall block', () => {
    expect(startToolCall).toMatch(/upsertStreamingToolCall/);
  });

  it('does NOT close the assistant bubble on a tool call', () => {
    // Closing it was the original bug's other half: it ended the only message
    // that could have carried the tool block, so nothing rendered at all.
    // Matches a CALL, not the word — the code comments explain what changed.
    expect(startToolCall).not.toMatch(/this\.finalizeStreaming\(/);
  });

  it('re-announces a late title onto the SAME block instead of adding another', () => {
    const upsert = SRC.slice(
      SRC.indexOf('private upsertStreamingToolCall('),
      SRC.indexOf('private emitToolResult('),
    );
    // Shell calls open as a generic "Terminal" with empty input and only get
    // their real command once the model finishes streaming the arguments.
    expect(upsert).toMatch(/find\(/);
    expect(upsert).toMatch(/toolCall/);
  });

  it('starts the bubble lazily, the same way streaming text does', () => {
    const upsert = SRC.slice(
      SRC.indexOf('private upsertStreamingToolCall('),
      SRC.indexOf('private emitToolResult('),
    );
    expect(upsert).toMatch(/message_start/);
    expect(upsert).toMatch(/message_update/);
  });
});

describe('MessageList — the role that renders nothing', () => {
  it('still has no toolResult case, so a toolResult message would render null', () => {
    // Pins WHY the fix targets content blocks rather than a toolResult message:
    // that role falls through to `default: node = null`.
    const sw = LIST.slice(LIST.indexOf("case 'user'"), LIST.indexOf('if (withPlanActions)'));
    expect(sw).not.toMatch(/case 'toolResult'/);
  });
});
