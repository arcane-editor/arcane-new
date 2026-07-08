import { describe, it, expect } from 'bun:test';
import { lintAnswer, buildReviseMessage } from './grounding-lint';
import type { ContrastFacts } from './prompts/unity-contrast';

const URP_NEW: ContrastFacts = { renderPipeline: 'URP', inputSystem: 'New' };
const NULL_FACTS: ContrastFacts = { renderPipeline: null, inputSystem: null };

describe('lintAnswer — fenced code blocks', () => {
  it('flags wrong-pipeline code inside a fenced block', () => {
    const text = [
      "Here's how to tint the material:",
      '',
      '```csharp',
      'material.SetColor("_Color", Color.red);',
      '```',
    ].join('\n');
    const violations = lintAnswer(text, URP_NEW);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rowId).toBe('urp-color');
    expect(violations[0]!.correction).toContain('_BaseColor');
  });

  it('strips // negation comments before matching, so a comment-only mention inside the block is clean', () => {
    const text = [
      '```csharp',
      '// Don\'t use _Color here — this project uses URP, so use _BaseColor instead.',
      'material.SetColor("_BaseColor", Color.red);',
      '```',
    ].join('\n');
    expect(lintAnswer(text, URP_NEW)).toHaveLength(0);
  });

  it('strips /* block */ negation comments before matching', () => {
    const text = [
      '```csharp',
      '/* Wrong for this project: _Color. Use _BaseColor. */',
      'material.SetColor("_BaseColor", Color.red);',
      '```',
    ].join('\n');
    expect(lintAnswer(text, URP_NEW)).toHaveLength(0);
  });

  it('correct URP code (SetColor("_BaseColor"...)) stays clean', () => {
    const text = ['```csharp', 'material.SetColor("_BaseColor", Color.red);', '```'].join('\n');
    expect(lintAnswer(text, URP_NEW)).toHaveLength(0);
  });

  it('dedupes multiple occurrences of the same row into a single violation', () => {
    const text = [
      '```csharp',
      'material.SetColor("_Color", Color.red);',
      'material.SetColor("_Color", Color.blue);',
      '```',
      '',
      '```csharp',
      'material2.SetColor("_Color", Color.green);',
      '```',
    ].join('\n');
    const violations = lintAnswer(text, URP_NEW);
    expect(violations.filter((v) => v.rowId === 'urp-color')).toHaveLength(1);
  });
});

describe('lintAnswer — inline code spans (prose scoping)', () => {
  it('a prose negation with a bare inline `_Color` span stays clean (no call/usage syntax in the span)', () => {
    const text = "Don't use `_Color` in this project — it's a Built-in-only shader property.";
    expect(lintAnswer(text, URP_NEW)).toHaveLength(0);
  });

  it('an inline span with real call syntax (`Input.GetAxis(...)`) is flagged as a usage form', () => {
    const text = 'You can read movement with `Input.GetAxis("Horizontal")` each frame.';
    const violations = lintAnswer(text, { renderPipeline: null, inputSystem: 'New' });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rowId).toBe('input-new');
  });

  it('a bare inline `InputAction` mention (no call syntax) stays clean under Legacy facts', () => {
    const text = 'This project does not use `InputAction` — it is on the legacy Input Manager.';
    expect(lintAnswer(text, { renderPipeline: null, inputSystem: 'Legacy' })).toHaveLength(0);
  });

  it('prose outside any fence/span is never matched, even if it contains a wrong token verbatim', () => {
    const text = 'material.SetColor("_Color", Color.red) is what you should NOT write for this project.';
    expect(lintAnswer(text, URP_NEW)).toHaveLength(0);
  });
});

describe('lintAnswer — facts gating', () => {
  it('null facts: only the version-independent deprecation rows can ever fire', () => {
    const text = ['```csharp', 'var www = new WWW(url);', '```'].join('\n');
    const violations = lintAnswer(text, NULL_FACTS);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rowId).toBe('deprecated-www');
  });

  it('null facts: a pipeline-specific wrong token never fires (no applicable row)', () => {
    const text = ['```csharp', 'material.SetColor("_Color", Color.red);', '```'].join('\n');
    expect(lintAnswer(text, NULL_FACTS)).toHaveLength(0);
  });
});

describe('buildReviseMessage', () => {
  it('renders the exact expected wording, prefixed with the [grounding-check] marker', () => {
    const message = buildReviseMessage([
      { rowId: 'urp-color', matchedText: '"_Color"', correction: 'Use `_BaseColor` instead of `_Color`.' },
    ]);
    expect(message).toBe(
      '[grounding-check] Your answer uses APIs that are wrong for this project:\n' +
        '- "_Color": Use `_BaseColor` instead of `_Color`.\n' +
        'Rewrite the affected code/answer using the corrections. Keep everything else unchanged.',
    );
  });

  it('renders one bullet per violation', () => {
    const message = buildReviseMessage([
      { rowId: 'urp-color', matchedText: '"_Color"', correction: 'Use `_BaseColor`.' },
      { rowId: 'input-new', matchedText: 'Input.GetAxis', correction: 'Use InputAction/PlayerInput.' },
    ]);
    expect(message).toContain('- "_Color": Use `_BaseColor`.');
    expect(message).toContain('- Input.GetAxis: Use InputAction/PlayerInput.');
  });
});
