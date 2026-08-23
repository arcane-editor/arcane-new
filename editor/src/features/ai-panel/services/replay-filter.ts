/**
 * Which `session/update` notifications are replayed history, and which are not.
 *
 * `session/load` asks the agent to resume a thread, and the agent answers by
 * replaying that thread as ordinary `session/update` notifications. We already
 * have the transcript on screen from our own session file, so those have to be
 * dropped or every message appears twice.
 *
 * The trap — and the bug this module exists for — is that the replay is NOT
 * the only thing arriving on that channel. The agent also states the loaded
 * session's model, mode, effort and slash commands, as `config_option_update`
 * and `available_commands_update`. Those are session state, not history.
 * Suppressing the whole channel therefore threw them away, and because
 * `session/load` returns no config options of its own (unlike `session/new`,
 * whose result carries them), that notification was the ONLY source. The result
 * was `agentConfigOptions: []` on every resumed session, and `AgentConfigBar`
 * renders `null` when empty — so opening an old chat lost every control.
 */

/**
 * Updates that describe the SESSION rather than the conversation, and must
 * survive a replay.
 */
export const SESSION_STATE_UPDATES: readonly string[] = [
  'config_option_update',
  'available_commands_update',
  'current_mode_update',
  // Usage is a fact about the live session's context window, not a line in the
  // thread — and dropping it leaves the context meter stuck at its last value.
  'usage_update',
];

/**
 * True when an update is conversation content, and so should be suppressed
 * while a `session/load` replays a thread we are already rendering.
 *
 * Fails safe toward `true`: an update kind a future agent release adds is
 * treated as content, so the worst case during a replay is one missing line
 * rather than a duplicated transcript. Outside a replay nothing is suppressed,
 * so an unknown kind still reaches its handler normally.
 */
export function isReplayableContent(sessionUpdate: string): boolean {
  return !SESSION_STATE_UPDATES.includes(sessionUpdate);
}
