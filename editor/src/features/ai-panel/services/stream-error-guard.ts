/**
 * Stream-error guard (T5) — a `StreamFn` decorator that catches a
 * SYNCHRONOUS throw from the wrapped `StreamFn` (or any decorator
 * composed inside it — `withTurnGovernor`/`withTurnEscalation` build a
 * modified request before calling through) and converts it into a stream
 * that has already been pushed an `{type:'error', error}` event, mirroring
 * how `arcane-stream.ts` reports failures encountered mid-stream (it never
 * throws synchronously itself — `doStream` runs as a detached promise whose
 * rejection is caught and pushed as an error event — but a decorator ABOVE
 * it could still throw before ever reaching that point).
 *
 * Without this guard, a synchronous throw here would propagate as an
 * uncaught exception out of `agent-loop.ts`'s call site instead of resolving
 * to an error-stop `AssistantMessage` — the shape `detectTurnOutcome`
 * (agent-service.ts's outcome-detection choke point) expects to classify.
 *
 * Composed OUTERMOST at the `Agent`'s `streamFn` construction site in
 * `agent-service.ts`: `withStreamErrorGuard(withTurnGovernor(withTurnEscalation(arcaneStream)))`,
 * so it catches a throw from any layer beneath it.
 */

import type { Context, StreamFn, StreamOptions } from './vendor/types';
import { AssistantMessageEventStream } from './vendor/event-stream';

export function withStreamErrorGuard(streamFn: StreamFn): StreamFn {
  return (context: Context, options: StreamOptions) => {
    try {
      return streamFn(context, options);
    } catch (error) {
      const stream = new AssistantMessageEventStream();
      stream.push({
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return stream;
    }
  };
}
