// Local alias for the ai-panel `Effort` type. Deep-modules boundary check
// forbids importing ai-panel internals from graphify (only the ai-panel
// barrel is a valid import target, and importing the barrel here would be a
// cross-feature cycle), so the tier union is duplicated here instead.
// keep in sync with Effort in ai-panel/services/types.ts
type Tier = 'low' | 'mid' | 'high' | 'super';

const MAX_CHARS = 1024;

/** Higher-effort tiers get a bigger graph-snapshot slice of the prompt budget. */
export function graphSnapshotBudget(effort: Tier): number {
  return effort === 'high' || effort === 'super' ? 4096 : MAX_CHARS;
}

/** Truncate `text` to `maxChars`, appending an ellipsis when it overflows. */
export function capSnapshot(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}

export { MAX_CHARS };
