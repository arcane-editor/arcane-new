/**
 * Out-of-band request extras carried on a vendor `Context` object without
 * modifying vendor types (vendor/ is frozen — everything composes from
 * outside). Decorators like the turn governor attach extras to the COPY of
 * the context they pass down; `hosted-stream.ts` reads them off and folds
 * them into the wire request.
 *
 * Motivation (cache activation §1): the governor used to strip `tools: []`
 * at the call cap, which changed the tools block — the very front of the
 * provider's cached prompt prefix — and re-billed the whole conversation.
 * `toolChoice: 'none'` keeps the tools block byte-identical while still
 * making the model answer without tool calls.
 */

import type { Context } from './vendor/types';

export interface StreamExtras {
  /** Sent as OpenAI-style `tool_choice` on the wire when set. */
  toolChoice?: 'none';
}

const EXTRAS_FIELD = '__hostedStreamExtras';

type ContextWithExtras = Context & { [EXTRAS_FIELD]?: StreamExtras };

/** Return a copy of `ctx` carrying `extras` (never mutates the original). */
export function withStreamExtras(ctx: Context, extras: StreamExtras): Context {
  return { ...ctx, [EXTRAS_FIELD]: extras } as ContextWithExtras;
}

export function getStreamExtras(ctx: Context): StreamExtras | undefined {
  return (ctx as ContextWithExtras)[EXTRAS_FIELD];
}
