/**
 * Generic async iterable event stream — adapted from PI coding agent
 * (github.com/badlogic/pi-mono) packages/ai/src/utils/event-stream.ts
 *
 * Provides a push-based stream that consumers read via `for await...of`.
 * Includes a `result()` promise that resolves when the stream completes.
 */

import type { AssistantMessage, AssistantMessageEvent } from './types';

// =========================================================================
// Generic EventStream
// =========================================================================

export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;
  private _result: R | undefined;
  private resultResolve: ((value: R) => void) | null = null;
  private resultPromise: Promise<R>;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(
    isComplete: (event: T) => boolean,
    extractResult: (event: T) => R,
  ) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.resultPromise = new Promise<R>((resolve) => {
      this.resultResolve = resolve;
    });
  }

  /** Push an event into the stream. Consumers receive it via the async iterator. */
  push(event: T): void {
    const completing = this.isComplete(event);

    if (completing) {
      this._result = this.extractResult(event);
      this.resultResolve?.(this._result);
    }

    if (this.resolve) {
      // A consumer is already waiting — deliver the event directly.
      this.resolve({ value: event, done: false });
      this.resolve = null;
    } else {
      // No consumer waiting — buffer the event.
      this.queue.push(event);
    }

    if (completing) {
      this.done = true;
    }
  }

  /** Signal that no more events will be pushed. Optionally provide a final result. */
  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this._result = result;
      this.resultResolve?.(result);
    }
    if (this.resolve) {
      this.resolve({ value: undefined as unknown as T, done: true });
      this.resolve = null;
    }
  }

  /** Returns a promise that resolves to the final result once the stream completes. */
  result(): Promise<R> {
    return this.resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({
            value: undefined as unknown as T,
            done: true,
          });
        }
        return new Promise((resolve) => {
          this.resolve = resolve;
        });
      },
    };
  }
}

// =========================================================================
// AssistantMessageEventStream — specialized for LLM responses
// =========================================================================

export class AssistantMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  constructor() {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => {
        if (event.type === 'done') return event.message;
        if (event.type === 'error' && event.partial) return event.partial;
        return {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage:
            event.type === 'error' ? event.error.message : 'Unknown error',
          timestamp: Date.now(),
        };
      },
    );
  }
}

/** Convenience factory. */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}
