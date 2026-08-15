import { describe, it, expect } from 'bun:test';
import { replaceBlock, toggleTaskAt } from './block-edit';

const DOC = `# Title

## Steps

- [ ] **Step 1: Do the thing** — details here
- [x] **Step 2: Done already** — more details

Some closing paragraph.
`;

describe('replaceBlock', () => {
  it('splices a mid-document range and preserves everything around it', () => {
    const start = DOC.indexOf('Some closing paragraph.');
    const end = start + 'Some closing paragraph.'.length;
    const out = replaceBlock(DOC, start, end, 'A rewritten paragraph.');
    expect(out).toBe(DOC.replace('Some closing paragraph.', 'A rewritten paragraph.'));
  });

  it('replaces the heading block exactly', () => {
    const out = replaceBlock(DOC, 0, '# Title'.length, '# Better Title');
    expect(out.startsWith('# Better Title\n\n## Steps')).toBe(true);
  });

  it('handles a final block with no trailing newline', () => {
    const doc = '# A\n\nlast line';
    const start = doc.indexOf('last line');
    const out = replaceBlock(doc, start, doc.length, 'new last line');
    expect(out).toBe('# A\n\nnew last line');
  });

  it('round-trips multi-byte content — offsets are UTF-16 code units from the AST', () => {
    const doc = '# 🚀 Launch\n\nBody with emoji 🎉 inside.\n';
    const start = doc.indexOf('Body');
    const end = doc.indexOf('inside.') + 'inside.'.length;
    const out = replaceBlock(doc, start, end, 'Body with emoji 🎉 replaced.');
    expect(out).toBe('# 🚀 Launch\n\nBody with emoji 🎉 replaced.\n');
  });

  it('no-ops on an inverted or out-of-bounds range', () => {
    expect(replaceBlock(DOC, 50, 10, 'x')).toBe(DOC);
    expect(replaceBlock(DOC, -1, 5, 'x')).toBe(DOC);
    expect(replaceBlock(DOC, 0, DOC.length + 1, 'x')).toBe(DOC);
  });
});

describe('toggleTaskAt', () => {
  it('ticks an unchecked task', () => {
    const offset = DOC.indexOf('- [ ] **Step 1');
    const out = toggleTaskAt(DOC, offset);
    expect(out).toContain('- [x] **Step 1: Do the thing**');
    // The other task is untouched.
    expect(out).toContain('- [x] **Step 2: Done already**');
  });

  it('unticks a checked task (case-insensitive [X])', () => {
    const doc = '- [X] **Step 2: Done**\n';
    const out = toggleTaskAt(doc, 3);
    expect(out).toBe('- [ ] **Step 2: Done**\n');
  });

  it('works from any offset within the task line', () => {
    const offset = DOC.indexOf('Done already');
    const out = toggleTaskAt(DOC, offset);
    expect(out).toContain('- [ ] **Step 2: Done already**');
  });

  it('handles indented nested tasks and * bullets', () => {
    const doc = '  * [ ] nested task\n';
    const out = toggleTaskAt(doc, doc.indexOf('nested'));
    expect(out).toBe('  * [x] nested task\n');
  });

  it('returns null for a line with no task marker', () => {
    const offset = DOC.indexOf('Some closing paragraph.');
    expect(toggleTaskAt(DOC, offset)).toBeNull();
  });

  it('returns null for an out-of-bounds offset', () => {
    expect(toggleTaskAt(DOC, DOC.length + 10)).toBeNull();
    expect(toggleTaskAt(DOC, -1)).toBeNull();
  });
});
