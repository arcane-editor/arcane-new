# AI Sidebar Agent — Design Spec

## Context

Arcane IDE is a VS Code-like desktop IDE targeting Unity developers, built with Tauri v2 + React 19. The IDE already has a scaffold AI panel in the right sidebar (`src/features/ai-panel/`) with a placeholder chat UI but no backend integration.

The goal is to build a full AI coding agent into this sidebar by vendoring the core source code from the [PI coding agent](https://github.com/badlogic/pi-mono) — an open-source, minimal agentic framework — and connecting it to the existing Arcane Cloudflare Workers server (`https://api.arcaneai.org`) for LLM completions.

**Why PI?** PI's architecture is intentionally minimal: a simple agent loop (stream → tool calls → execute → repeat), 4 core tools (read, write, edit, bash), TypeBox-based schemas, and an operations interface pattern that makes I/O swappable. This makes it ideal for embedding inside a Tauri app where filesystem/shell access goes through Tauri APIs rather than Node.js.

**Why not use PI as an npm dependency?** Full control over modifications. The tool operations need to be rewritten for Tauri, the streaming layer needs to point at the Arcane server instead of direct providers, and future Unity-specific tools will extend the tool set.

---

## Architecture Overview

Three layers:

```
┌─────────────────────────────────────┐
│  Chat UI (React components)         │  src/features/ai-panel/components/
│  Zustand Store (ai.ts)              │  src/stores/ai.ts
├─────────────────────────────────────┤
│  Agent Service                      │  src/features/ai-panel/services/
│  ├── agent-service.ts               │  Orchestrates PI's agent loop
│  ├── arcane-stream.ts               │  Custom StreamFn → Arcane server SSE
│  └── tool-operations.ts             │  Tauri API-backed tool I/O
├─────────────────────────────────────┤
│  Vendored PI Core                   │  src/features/ai-panel/services/vendor/
│  ├── agent-loop.ts                  │  Stream → tool calls → execute → repeat
│  ├── agent.ts                       │  Stateful agent, event dispatch, queues
│  ├── types.ts                       │  Message, AgentEvent, Tool types
│  └── tools/ (read, write, edit, bash)│ Tool schemas + logic
├─────────────────────────────────────┤
│  Arcane Server (existing)           │  https://api.arcaneai.org
│  POST /v1/chat/completions (SSE)    │  Routes to Anthropic/OpenAI/Z.AI
└─────────────────────────────────────┘
```

**Data flow:** User types message → `useAiStore.sendMessage()` → `AgentService.sendMessage()` → PI agent loop calls `arcane-stream.ts` → `fetch POST /v1/chat/completions` with SSE → agent loop receives response → if tool calls, executes via `tool-operations.ts` (Tauri APIs) → feeds results back → repeats until no tool calls → agent events update Zustand store → React UI re-renders.

---

## 1. Vendored PI Code

### Source

Repository: `github.com/badlogic/pi-mono`

### Files to Copy

From `packages/agent/src/` (agent runtime):
- `agent-loop.ts` — core loop: streams LLM response, detects tool calls, executes them sequentially, feeds results back, repeats
- `agent.ts` — `Agent` class: stateful wrapper with message queues (`steer`, `followUp`), lifecycle management, event dispatch
- `types.ts` — `AgentEvent`, `AgentMessage`, `AgentTool`, `AgentContext`, `AgentLoopConfig`

From `packages/ai/src/` (LLM types + event stream):
- `types.ts` — `Message`, `AssistantMessage`, `UserMessage`, `ToolResultMessage`, `TextContent`, `ImageContent`, `ToolCall`, `Tool`, `StopReason`, `AssistantMessageEvent`
- `utils/event-stream.ts` — `EventStream` and `AssistantMessageEventStream` classes

From `packages/coding-agent/src/core/tools/` (tool implementations):
- `read.ts`, `write.ts`, `edit.ts`, `bash.ts` — tool definitions with TypeBox schemas and operations interfaces
- `edit-diff.ts` — search/replace algorithm (pure TS, no I/O)
- `path-utils.ts` — path resolution helpers
- `truncate.ts` — output truncation utilities
- `index.ts` — `codingTools` factory

From `packages/coding-agent/src/core/`:
- `messages.ts` — `convertToLlm` function and custom message types

### Target Structure

```
src/features/ai-panel/services/vendor/
  types.ts              ← Merged pi-ai types + agent types
  event-stream.ts       ← EventStream classes
  agent-loop.ts         ← Core loop (rewritten imports)
  agent.ts              ← Agent class (rewritten imports)
  messages.ts           ← convertToLlm, custom message types
  tools/
    schemas.ts          ← TypeBox schemas for all 4 tools
    read.ts             ← Read tool (operations swapped for Tauri)
    write.ts            ← Write tool (operations swapped for Tauri)
    edit.ts             ← Edit tool + edit-diff logic
    bash.ts             ← Bash tool (operations swapped for Tauri)
    path-utils.ts       ← Simplified path resolution
    truncate.ts         ← Output truncation
    index.ts            ← codingTools factory export
```

### Modifications Required

1. **Rewrite all `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` imports** to local relative paths within the vendor directory
2. **Replace `streamFn`**: The agent loop's default `streamSimple` is replaced with our custom `arcane-stream.ts` StreamFn
3. **Remove Node.js dependencies from tools**: PI tools import `fs/promises`, `child_process`, `path`. These are replaced by injecting Tauri-backed operation implementations (PI already supports this via its operations interface pattern)
4. **Strip unused code**: Remove PI's TUI mode, RPC mode, print mode, extension system, and session persistence (we implement our own simpler version)

### New Dependency

- `@sinclair/typebox` — zero-dep, ~45KB. PI uses it for tool argument schemas and validation. Keeping it preserves type safety and eases future syncs with PI updates.
- `diff` — for generating unified diffs in the edit tool

---

## 2. Agent Service

**File:** `src/features/ai-panel/services/agent-service.ts`

Singleton service that creates a PI `Agent` instance configured with:

1. **Custom `StreamFn`** — `arcane-stream.ts` replaces PI's `streamSimple`. This is the single integration point where PI's provider layer is replaced with the Arcane server.

2. **Tool registration** — creates the 4 tools with Tauri-backed operations and assigns them to the agent.

3. **Event subscription** — subscribes to agent events and routes them to `useAiStore.getState().handleAgentEvent(event)`.

### Interface

```typescript
class AgentService {
  private agent: Agent;
  private abortController: AbortController | null;

  constructor(workspacePath: string)
  sendMessage(text: string): void    // Starts agent loop
  abort(): void                       // Cancels current run
  setModel(modelId: string): void     // Switch model
  reset(): void                       // Clear conversation
}
```

### System Prompt

The agent service configures a system prompt for the coding agent context. This includes: the workspace path, available tools, and instructions for how to use them. The system prompt is assembled in the agent service constructor and passed as part of the context to each agent loop iteration. Unity-specific instructions can be added later when Unity tools are introduced.

### Execution Model

The agent loop runs entirely in the renderer process (browser/webview). Tool calls invoke Tauri commands via `invoke()` which execute in the Rust backend. This matches how the existing terminal and workspace stores already work — the loop itself is async/await driven and non-blocking.

---

## 3. Arcane Server Integration

**File:** `src/features/ai-panel/services/arcane-stream.ts`

Implements the `StreamFn` signature: `(model, context, options) => AssistantMessageEventStream`

### Request

```
POST https://api.arcaneai.org/v1/chat/completions
Authorization: Bearer <jwt from useAuthStore>
Content-Type: application/json

{
  "model": "<selected model>",
  "messages": [<OpenAI-compatible format>],
  "tools": [<function definitions>],
  "stream": true,
  "metadata": {
    "taskType": "coding-agent",
    "mode": "agent",
    "sessionId": "<session id>"
  }
}
```

### SSE Response Parsing

Server responds with Server-Sent Events:
```
data: {"type":"text","content":"Here"}
data: {"type":"tool_call","id":"tc_1","name":"read","arguments":"{...}","finished":true}
data: {"type":"thinking","content":"Let me analyze..."}
data: {"type":"usage","input_tokens":100,"output_tokens":50}
data: {"type":"error","message":"..."}
data: [DONE]
```

The stream function:
1. Creates an `AssistantMessageEventStream`
2. Calls `fetch()` with the request
3. Reads the response body as a `ReadableStream`
4. Parses SSE lines (`data: ...`)
5. Converts each Arcane event to PI's `AssistantMessageEvent` format
6. Pushes to the stream
7. On `[DONE]`, pushes a `done` event

### Auth

Reads JWT from `useAuthStore.getState().token` before each request. If token is null, surfaces a "Please log in" error in the chat.

### Error Handling

- 401/403 → token expired, prompt re-login
- 429 → rate limited, surface to user
- Network failure → show error in chat, allow retry
- Malformed SSE → log warning, skip

---

## 4. Tool Implementations

**File:** `src/features/ai-panel/services/tool-operations.ts`

PI's tools use an operations interface pattern. We implement these interfaces using Tauri APIs.

### Read Tool

| PI Operation | Tauri Implementation |
|---|---|
| `readFile(path)` | `invoke<string>('read_file', { path })` (existing command) |
| `access(path)` | Try `invoke('read_file', { path })`, catch → not found |

Image support deferred (Unity projects are text-heavy).

### Write Tool

| PI Operation | Tauri Implementation |
|---|---|
| `writeFile(path, content)` | `invoke('write_file', { path, contents: content })` (existing) |
| `mkdir(path)` | New Rust command: `create_directory_recursive` using `std::fs::create_dir_all` |

After write: call `useWorkspaceStore.getState().refreshTree()` and update open file buffers.

### Edit Tool

| PI Operation | Tauri Implementation |
|---|---|
| `readFile(path)` | Same as read tool |
| `writeFile(path, content)` | Same as write tool |

The edit-diff algorithm (`fuzzyFindText`, `applyEditsToNormalizedContent`) is pure TypeScript — vendored as-is, no I/O changes needed.

After edit: sync workspace store; if edited file is open in Monaco, update its content.

### Bash Tool

| PI Operation | Tauri Implementation |
|---|---|
| `exec(command, cwd)` | New Rust command: `execute_command` |

**New Tauri command: `execute_command`**

```rust
#[tauri::command]
async fn execute_command(
    command: String,
    cwd: String,
    timeout_ms: Option<u64>
) -> Result<CommandOutput, String> {
    // Uses tokio::process::Command
    // Returns { stdout: String, stderr: String, exit_code: i32 }
    // Default timeout: 30 seconds
}
```

This is separate from the existing PTY terminals (which are for interactive user sessions). Agent bash calls are non-interactive command executions.

---

## 5. Zustand Store

**File:** `src/stores/ai.ts`

### State Shape

```typescript
interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'toolResult' | 'system';
  text?: string;                    // For user messages
  content?: ContentBlock[];         // For assistant (text, thinking, tool calls)
  toolCallId?: string;              // For tool results
  toolName?: string;
  toolResult?: { content: string; isError: boolean };
  timestamp: number;
  stopReason?: StopReason;
  isStreaming?: boolean;
}

interface ToolCallStatus {
  id: string;
  name: string;
  args: Record<string, any>;
  status: 'pending' | 'running' | 'complete' | 'error';
  result?: string;
  isError?: boolean;
}

interface AiState {
  messages: AiMessage[];
  streamingMessageId: string | null;
  isAgentRunning: boolean;
  pendingToolCalls: Map<string, ToolCallStatus>;
  errorMessage: string | null;
  selectedModel: string;
  sessionId: string | null;

  // Actions
  handleAgentEvent: (event: AgentEvent) => void;
  sendMessage: (text: string) => void;
  abortAgent: () => void;
  resetConversation: () => void;
  setModel: (modelId: string) => void;
}
```

### Event → Store Mapping

| Agent Event | Store Mutation |
|---|---|
| `agent_start` | `isAgentRunning = true`, clear error |
| `message_start` (assistant) | Add new `AiMessage` with `isStreaming: true` |
| `message_update` | Append text/thinking/toolcall deltas to streaming message |
| `message_end` (assistant) | Finalize message, `isStreaming = false` |
| `tool_execution_start` | Add to `pendingToolCalls` |
| `tool_execution_end` | Update tool status to complete/error |
| `agent_end` | `isAgentRunning = false` |

The store does not hold a reference to `AgentService`. `sendMessage` creates/accesses the singleton service. This keeps the store serializable.

---

## 6. Chat UI Components

**All in `src/features/ai-panel/components/`.** Barrel export from `index.ts` exposes only `AiChatPanel`.

```
AiChatPanel.tsx              ← Container: header + messages + input
  ├── MessageList.tsx         ← Scrollable message list with auto-scroll
  │   ├── UserMessage.tsx          ← User message bubble
  │   └── AssistantMessage.tsx     ← Markdown rendered + inline tool calls
  │       ├── ToolCallBlock.tsx    ← Collapsible: tool name, args, result, spinner
  │       └── ThinkingBlock.tsx    ← Collapsible reasoning display
  ├── ChatInput.tsx           ← Textarea + send/abort + model selector
  └── StreamingIndicator.tsx  ← Animated indicator during streaming
```

### Markdown Rendering

Use `react-markdown` + `remark-gfm` for assistant text. Code blocks get syntax highlighting via `highlight.js` or similar lightweight highlighter.

### Tool Call Rendering

| Tool | Display |
|---|---|
| **read** | File path + collapsible code preview |
| **write** | File path + byte count + collapsible content |
| **edit** | File path + collapsible unified diff |
| **bash** | Command + collapsible terminal-styled output (monospace) |

### Theming

All components use the existing CSS variable system (`--bg-primary`, `--bg-input`, `--text-primary`, `--accent`, `--border`, etc.). Existing `.ai-panel-*` CSS classes in `App.css` are updated/extended.

---

## 7. Session Persistence

### V1: Simple JSON Files

Location: `~/.arcane/sessions/<sessionId>.json`

```json
{
  "id": "uuid",
  "createdAt": 1712400000,
  "updatedAt": 1712401000,
  "model": "claude-sonnet-4-20250514",
  "messages": [...]
}
```

- Auto-saved after each agent turn completes (debounced)
- Read/write via existing Tauri `read_file`/`write_file` commands
- "New Chat" button resets conversation, creates new session
- Session listing/switching deferred to later iteration

### Future: PI's JSONL DAG

Can migrate to PI's append-only JSONL format later if branching, compaction, or session tree navigation is needed.

---

## 8. New Rust Commands

Two new commands to add to `src-tauri/src/lib.rs`:

### `create_directory_recursive`

```rust
#[tauri::command]
fn create_directory_recursive(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}
```

### `execute_command`

```rust
#[tauri::command]
async fn execute_command(
    command: String,
    cwd: String,
    timeout_ms: Option<u64>,
) -> Result<CommandOutput, String> {
    // tokio::process::Command with timeout
    // Returns { stdout, stderr, exit_code }
}
```

Both registered in the `invoke_handler` macro.

---

## 9. New Dependencies

| Package | Purpose | Size |
|---|---|---|
| `@sinclair/typebox` | Tool argument schemas (used by PI) | ~45KB, zero-dep |
| `diff` | Unified diff generation for edit tool | ~10KB |
| `react-markdown` | Markdown rendering in chat | ~15KB |
| `remark-gfm` | GFM support (tables, strikethrough) | ~5KB |

---

## Verification Plan

### Unit Testing
- Agent loop processes a mock stream with tool calls correctly
- SSE parser handles all event types (text, tool_call, thinking, usage, error, [DONE])
- Tool operations correctly invoke Tauri commands
- Edit-diff algorithm produces correct diffs

### Integration Testing
- Send a message through the full flow: UI → store → agent → server → streaming response
- Tool calls execute and results appear in chat
- Abort cancels an in-progress agent run
- Auth failure surfaces login prompt
- File modifications sync to workspace store (explorer tree + open editors)

### Manual Testing
- Open AI panel (Ctrl+Shift+A or right activity bar icon)
- Send "read the file src/App.tsx" → agent calls read tool, shows file content
- Send "add a comment to line 1 of src/App.tsx" → agent calls edit tool, diff shown
- Send "run ls in the project root" → agent calls bash tool, output shown
- Switch models via dropdown
- Abort mid-stream with stop button
- Theme switching still works with new components
- Session persists across panel close/reopen

---

## Files Modified

| File | Change |
|---|---|
| `src/features/ai-panel/components/AiChatPanel.tsx` | Complete rewrite |
| `src/features/ai-panel/index.ts` | Updated exports |
| `src/stores/ai.ts` | New file |
| `src/features/ai-panel/services/` | New directory with agent service, stream, tools, vendor |
| `src/features/ai-panel/components/` | New files: MessageList, UserMessage, AssistantMessage, ToolCallBlock, ThinkingBlock, ChatInput, StreamingIndicator |
| `src-tauri/src/lib.rs` | Add `execute_command`, `create_directory_recursive` to invoke handler |
| `src/App.css` | Update/extend `.ai-panel-*` styles |
| `package.json` | Add `@sinclair/typebox`, `diff`, `react-markdown`, `remark-gfm` |
