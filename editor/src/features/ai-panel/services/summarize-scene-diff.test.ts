import { describe, it, expect } from 'bun:test';
import { buildSummarizePrompt } from './summarize-scene-diff';

describe('buildSummarizePrompt', () => {
  it('assembles task framing + file path + the pre-formatted diff text, verbatim', () => {
    const prompt = buildSummarizePrompt({
      filePath: 'Assets/Scenes/Main.unity',
      promptText: '1 modified\nModified \'Player\' (Player): m_IsActive: False → True',
    });

    expect(prompt).toBe(
      [
        'Summarize this Unity scene/prefab change for a code review — what changed, what it likely affects, anything risky:',
        '',
        'File: Assets/Scenes/Main.unity',
        '',
        "1 modified\nModified 'Player' (Player): m_IsActive: False → True",
      ].join('\n'),
    );
  });

  it('never mutates or reformats the passed-in diff text (structured diff text, never raw YAML)', () => {
    const promptText = 'No changes';
    const prompt = buildSummarizePrompt({ filePath: 'Assets/Prefabs/Enemy.prefab', promptText });

    expect(prompt).toContain(promptText);
    expect(prompt.endsWith(promptText)).toBe(true);
  });

  it('is pure — same args produce an identical string every time', () => {
    const args = { filePath: 'Assets/Scenes/Main.unity', promptText: 'No changes' };
    expect(buildSummarizePrompt(args)).toBe(buildSummarizePrompt(args));
  });
});
