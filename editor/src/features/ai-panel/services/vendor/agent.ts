/**
 * Agent class - adapted from PI coding agent (github.com/badlogic/pi-mono)
 * packages/agent/src/agent.ts
 *
 * Stateful wrapper around the agent loop with event dispatch and lifecycle management.
 *
 * LOCAL CHANGES (vs upstream):
 *  - `setReasoning(reasoning)` setter so the agent service can swap effort
 *    levels per send without reconstructing the agent.
 *  - `promptStructured(content)` accepts multi-part user content
 *    (text + image blocks) for OpenAI-style vision support. Required because
 *    upstream `prompt(text)` only supports a string body.
 */

import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentLoopConfig,
  AgentState,
  Model,
  Message,
  StreamFn,
  TextContent,
  ImageContent,
} from './types';
import { agentLoop } from './agent-loop';

export type AgentEventListener = (event: AgentEvent, signal: AbortSignal) => void | Promise<void>;

export interface AgentOptions {
  systemPrompt?: string;
  model: Model;
  tools?: AgentTool[];
  streamFn: StreamFn;
  convertToLlm?: (messages: AgentMessage[]) => Message[];
  getApiKey?: () => Promise<string | undefined> | string | undefined;
  reasoning?: string;
  /** Token budget for no-LLM context compaction (defaults to the smallest tier). */
  contextWindow?: number;
}

export class Agent {
  private _state: AgentState;
  private listeners: AgentEventListener[] = [];
  private abortController: AbortController | null = null;
  private activePromise: Promise<void> | null = null;
  private streamFn: StreamFn;
  private convertToLlmFn: (messages: AgentMessage[]) => Message[];
  private getApiKey?: () => Promise<string | undefined> | string | undefined;
  private reasoning?: string;
  private contextWindow?: number;

  constructor(options: AgentOptions) {
    this._state = {
      systemPrompt: options.systemPrompt ?? '',
      model: options.model,
      tools: options.tools ?? [],
      messages: [],
      isStreaming: false,
      pendingToolCalls: new Set(),
    };
    this.streamFn = options.streamFn;
    this.convertToLlmFn = options.convertToLlm ?? defaultConvertToLlm;
    this.getApiKey = options.getApiKey;
    this.reasoning = options.reasoning;
    this.contextWindow = options.contextWindow;
  }

  get state(): AgentState {
    return this._state;
  }

  get isRunning(): boolean {
    return this._state.isStreaming;
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  subscribe(listener: AgentEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Send a user prompt and run the agent loop until completion. */
  async prompt(text: string): Promise<AgentMessage[]> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    const userMessage: AgentMessage = {
      role: 'user' as const,
      content: text,
      timestamp: Date.now(),
    };

    return this.runPrompt([userMessage]);
  }

  /**
   * LOCAL: Send a user prompt with multi-part content (text + image blocks).
   * Required for OpenAI-style vision input. The streamFn (arcaneStream) is
   * responsible for emitting the OpenAI multi-part `content` array shape.
   */
  async promptStructured(
    content: (TextContent | ImageContent)[],
  ): Promise<AgentMessage[]> {
    if (this.isRunning) {
      throw new Error('Agent is already running');
    }

    const userMessage: AgentMessage = {
      role: 'user' as const,
      content,
      timestamp: Date.now(),
    };

    return this.runPrompt([userMessage]);
  }

  /** Abort the currently running agent loop. */
  abort(): void {
    this.abortController?.abort();
  }

  /** Wait for the current agent run to complete. */
  async waitForIdle(): Promise<void> {
    if (this.activePromise) {
      await this.activePromise;
    }
  }

  setModel(model: Model): void {
    this._state.model = model;
  }

  setSystemPrompt(prompt: string): void {
    this._state.systemPrompt = prompt;
  }

  setTools(tools: AgentTool[]): void {
    this._state.tools = tools;
  }

  setReasoning(reasoning: string | undefined): void {
    this.reasoning = reasoning;
  }

  /**
   * LOCAL: seed the conversation history (for resuming a saved session). The
   * next prompt() continues the conversation — runPrompt reads _state.messages
   * at the start of every turn. There is no upstream setter; reset() clears.
   */
  setMessages(messages: AgentMessage[]): void {
    this._state.messages = messages;
  }

  getMessages(): AgentMessage[] {
    return this._state.messages;
  }

  /** Reset the agent — clears all messages and stops any active run. */
  reset(): void {
    this.abort();
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set();
    this._state.errorMessage = undefined;
  }

  private async runPrompt(prompts: AgentMessage[]): Promise<AgentMessage[]> {
    this.abortController = new AbortController();
    this._state.isStreaming = true;
    this._state.errorMessage = undefined;

    const config: AgentLoopConfig = {
      model: this._state.model,
      streamFn: this.streamFn,
      convertToLlm: this.convertToLlmFn,
      getApiKey: this.getApiKey,
      signal: this.abortController.signal,
      reasoning: this.reasoning,
      contextWindow: this.contextWindow,
    };

    const eventStream = agentLoop(
      config,
      {
        systemPrompt: this._state.systemPrompt,
        messages: [...this._state.messages],
        tools: this._state.tools,
      },
      prompts,
    );

    this.activePromise = this.processEvents(eventStream);

    try {
      await this.activePromise;
    } finally {
      this._state.isStreaming = false;
      this._state.streamingMessage = undefined;
      this._state.pendingToolCalls = new Set();
      this.abortController = null;
      this.activePromise = null;
    }

    return this._state.messages;
  }

  private async processEvents(eventStream: AsyncIterable<AgentEvent>): Promise<void> {
    for await (const event of eventStream) {
      this.updateState(event);

      for (const listener of this.listeners) {
        try {
          await listener(event, this.abortController!.signal);
        } catch (error) {
          console.error('Agent event listener error:', error);
        }
      }
    }
  }

  private updateState(event: AgentEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') {
          this._state.streamingMessage = event.message as any;
        }
        break;
      case 'message_update':
        if (event.message.role === 'assistant') {
          this._state.streamingMessage = event.message as any;
        }
        break;
      case 'message_end':
        this._state.messages = [...this._state.messages, event.message];
        this._state.streamingMessage = undefined;
        break;
      case 'tool_execution_start': {
        const pending = new Set(this._state.pendingToolCalls);
        pending.add(event.toolCallId);
        this._state.pendingToolCalls = pending;
        break;
      }
      case 'tool_execution_end': {
        const pending = new Set(this._state.pendingToolCalls);
        pending.delete(event.toolCallId);
        this._state.pendingToolCalls = pending;
        break;
      }
      case 'agent_end':
        this._state.messages = event.messages;
        this._state.streamingMessage = undefined;
        break;
    }
  }
}

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m): m is Message =>
      m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult',
  );
}
