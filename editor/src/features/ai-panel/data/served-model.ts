/**
 * Turns a wire model id into the short name shown in the served-model footer
 * (`AssistantMessage.tsx`). Pure, so the stripping rules can be tested without
 * a DOM, the same reason `effort.ts`/`empty-state.ts` are.
 */

const CF_PREFIX = '@cf/';

/**
 * Strips the provider prefix before the first `/` — `xai/grok-4.6` →
 * `grok-4.6`. `@cf/`-prefixed ids (Cloudflare Workers AI) are the exception:
 * only the literal `@cf/` is stripped, since the remainder (e.g. `qwen/x`) is
 * the model's own namespaced name, not a second provider prefix to peel off.
 * An id with no `/` at all passes through unchanged.
 */
export function modelShortName(servedModel: string): string {
  if (servedModel.startsWith(CF_PREFIX)) return servedModel.slice(CF_PREFIX.length);
  const slash = servedModel.indexOf('/');
  return slash === -1 ? servedModel : servedModel.slice(slash + 1);
}
