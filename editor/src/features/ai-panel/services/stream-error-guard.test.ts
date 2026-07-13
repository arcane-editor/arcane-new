import { describe, it, expect } from 'bun:test';
import { withStreamErrorGuard } from './stream-error-guard';
import { AssistantMessageEventStream } from './vendor/event-stream';
import type { Context, StreamOptions, StreamFn } from './vendor/types';

function context(): Context {
  return { systemPrompt: '', messages: [], tools: [] };
}

function options(): StreamOptions {
  return { model: { id: 'x', name: 'x', provider: 'x' } };
}

describe('withStreamErrorGuard', () => {
  it('converts a synchronous throw from the inner StreamFn into an error-stop assistant message', async () => {
    const throwing: StreamFn = () => {
      throw new Error('boom');
    };
    const guarded = withStreamErrorGuard(throwing);

    const stream = guarded(context(), options());
    const result = await stream.result();

    expect(result.role).toBe('assistant');
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('boom');
  });

  it('wraps a non-Error synchronous throw in an Error', async () => {
    const throwing: StreamFn = () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'plain string failure';
    };
    const guarded = withStreamErrorGuard(throwing);

    const result = await guarded(context(), options()).result();

    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('plain string failure');
  });

  it('passes through the exact same stream instance when the inner fn does not throw', () => {
    const innerStream = new AssistantMessageEventStream();
    const passthrough: StreamFn = () => innerStream;
    const guarded = withStreamErrorGuard(passthrough);

    const result = guarded(context(), options());

    expect(result).toBe(innerStream);
  });
});
