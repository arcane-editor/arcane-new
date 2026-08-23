import { describe, it, expect } from 'bun:test';
import { isReplayableContent, SESSION_STATE_UPDATES } from './replay-filter';

describe('isReplayableContent', () => {
  /**
   * `session/load` makes the agent replay the whole thread as `session/update`
   * notifications. We already have the transcript on screen from our own
   * session file, so those must be dropped — otherwise every message appears
   * twice.
   */
  it('treats conversation content as replayable, so a resume does not duplicate it', () => {
    for (const kind of [
      'agent_message_chunk',
      'agent_thought_chunk',
      'user_message_chunk',
      'tool_call',
      'tool_call_update',
      'plan',
    ]) {
      expect(isReplayableContent(kind)).toBe(true);
    }
  });

  /**
   * The bug this exists for: suppressing EVERYTHING during a load also dropped
   * `config_option_update`, which is not replayed history — it is the agent
   * stating the loaded session's model, mode and effort. `session/load`
   * returns no config options of its own, so that notification was the only
   * source, and losing it left `agentConfigOptions` empty. `AgentConfigBar`
   * renders null when empty, so every control vanished on a resumed session.
   */
  it('treats session state as NOT replayable, so a resume keeps its controls', () => {
    for (const kind of SESSION_STATE_UPDATES) {
      expect(isReplayableContent(kind)).toBe(false);
    }
    expect(SESSION_STATE_UPDATES).toContain('config_option_update');
    expect(SESSION_STATE_UPDATES).toContain('available_commands_update');
    expect(SESSION_STATE_UPDATES).toContain('current_mode_update');
  });

  it('fails safe on an update kind it has never seen', () => {
    // A future agent release can add kinds. Treating an unknown one as content
    // means the worst case during a replay is a missing line, not a duplicated
    // transcript — and outside a replay nothing is suppressed at all.
    expect(isReplayableContent('something_new')).toBe(true);
  });

  it('does not suppress usage, which describes the session and not the thread', () => {
    expect(isReplayableContent('usage_update')).toBe(false);
  });
});
