import { describe, it, expect } from 'bun:test';
import { fuzzyFindText, applyEdits } from './edit-diff';

describe('fuzzy whitespace matching', () => {
  it('tab-indented file + space-indented oldText edits only the target (regression: deleted rest of file)', () => {
    const content =
      'class A\n{\n\tvoid M1()\n\t{\n\t\tint x = 1;\n\t}\n\n\tvoid M2()\n\t{\n\t\tint y = 2;\n\t}\n}\n';
    const res = applyEdits(content, [
      {
        oldText: '    void M1()\n    {\n        int x = 1;\n    }',
        newText: '\tvoid M1()\n\t{\n\t\tint x = 2;\n\t}',
      },
    ]);
    expect(res.applied).toBe(true);
    expect(res.content).toContain('int x = 2;');
    expect(res.content).toContain('void M2()'); // the rest of the file survives
    expect(res.content).toContain('int y = 2;');
    expect(res.content.endsWith('}\n')).toBe(true);
  });

  it('maps the matched span over collapsed whitespace runs', () => {
    const m = fuzzyFindText('a\t\tb cd', 'a  b');
    expect(m.found).toBe(true);
    expect(m.startIndex).toBe(0);
    expect(m.endIndex).toBe(4); // "a\t\tb"
    expect(m.matchedText).toBe('a\t\tb');
  });

  it('maps CRLF content against LF oldText', () => {
    const m = fuzzyFindText('foo\r\nbar\r\nbaz', 'bar\nbaz');
    expect(m.found).toBe(true);
    expect(m.matchedText).toBe('bar\r\nbaz');
  });

  it('fuzzy match at end of content does not run past EOF', () => {
    const m = fuzzyFindText('x\n\tend', '    end');
    expect(m.found).toBe(true);
    expect(m.matchedText).toBe('\tend');
    expect(m.endIndex).toBe(6);
  });

  it('exact match still wins untouched', () => {
    const m = fuzzyFindText('alpha beta', 'beta');
    expect(m.startIndex).toBe(6);
    expect(m.matchedText).toBe('beta');
  });

  it('no match reports applied:false', () => {
    expect(applyEdits('abc', [{ oldText: 'zzz', newText: 'y' }]).applied).toBe(false);
  });
});
