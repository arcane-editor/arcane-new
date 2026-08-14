/**
 * Is the caret in the AI chat composer right now?
 *
 * The gate for the composer-scoped chords (`ai.effortUp` / `ai.effortDown`,
 * and mode cycling on the Cmd+M route). Those chords take keys the rest of the
 * app has real uses for — Cmd+←/→ is line-start/line-end in every other text
 * surface — so they must be inert everywhere except the one box they belong
 * to.
 *
 * Asks the live DOM rather than tracking focus in a store: focus moves without
 * React rendering (clicking the editor, Escape out of a popover, a Monaco
 * widget taking over), and a mirrored copy of it would be wrong exactly when
 * it mattered. `.lexical-chat-input` wraps the contenteditable in
 * `LexicalChatInput`, so this covers the sidebar composer and the maximized
 * overlay's without either having to register itself.
 */
export function isAiComposerFocused(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active) return false;
  return !!active.closest('.lexical-chat-input');
}
