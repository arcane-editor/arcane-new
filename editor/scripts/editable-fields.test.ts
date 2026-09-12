import { describe, it, expect } from 'bun:test';
import { findUnguardedFields } from './editable-fields.mjs';

const GUARDED = `
  <input
    className="search-input"
    type="text"
    value={q}
    onChange={(e) => set(e.target.value)}
    spellCheck={false}
    autoComplete="off"
    autoCorrect="off"
    autoCapitalize="off"
  />
`;

describe('findUnguardedFields', () => {
  it('passes a field that states all four attributes', () => {
    expect(findUnguardedFields('Ok.tsx', GUARDED)).toEqual([]);
  });

  it('reports a field that states none of them', () => {
    const src = '<input className="filter" value={q} onChange={(e) => set(e.target.value)} />';
    const [hit] = findUnguardedFields('Filter.tsx', src);
    expect(hit.missing).toEqual(['spellCheck', 'autoCorrect', 'autoComplete', 'autoCapitalize']);
  });

  it('reports the exact attributes a half-guarded field is missing', () => {
    // The real shape of the bug: SearchQueryBar's include/exclude boxes had
    // spellCheck and autoComplete but not autoCorrect, so macOS still silently
    // rewrote a glob.
    const src = GUARDED.replace(/\s*autoCorrect="off"/, '').replace(/\s*autoCapitalize="off"/, '');
    expect(findUnguardedFields('Half.tsx', src)[0].missing).toEqual(['autoCorrect', 'autoCapitalize']);
  });

  it('covers textarea, not just input', () => {
    const src = '<textarea value={draft} onChange={(e) => setDraft(e.target.value)} />';
    expect(findUnguardedFields('Edit.tsx', src)).toHaveLength(1);
  });

  it('ignores inputs that hold no free text', () => {
    for (const type of ['checkbox', 'radio', 'range', 'color', 'file', 'number']) {
      expect(findUnguardedFields('T.tsx', `<input type="${type}" checked={on} />`)).toEqual([]);
    }
  });

  it('does not mistake a tag described in a comment for one that exists', () => {
    // KeyboardShortcutManager explains xterm's helper <textarea> in prose and
    // was reported as an unguarded field because of it.
    const src = `
      // xterm's helper element is a <textarea>, so every app chord fires.
      /* Monaco's find widget renders an <input> of its own. */
      const x = 1;
    `;
    expect(findUnguardedFields('Comment.tsx', src)).toEqual([]);
  });

  it('survives a prop whose value contains a > of its own', () => {
    // `onChange={(e) => ...}` closes nothing; scanning to the first ">" would
    // end the tag early and miss the attributes below it.
    const src = `
      <input
        onChange={(e) => set(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
    `;
    expect(findUnguardedFields('Arrow.tsx', src)).toEqual([]);
  });

  it('lets a field opt out deliberately', () => {
    const src = '<textarea data-allow-autocorrect value={prose} />';
    expect(findUnguardedFields('Prose.tsx', src)).toEqual([]);
  });
});

describe('findUnguardedFields — comment stripping does not eat source', () => {
  it('does not treat a glob in a placeholder as a block comment', () => {
    // The bug this check was written to find, hiding inside the check itself:
    // "Assets/**" opens what looks like a block comment and "**/Editor/**"
    // closes it, blanking the input between them. SearchQueryBar's exclude box
    // was invisible to the scan for exactly this reason.
    const src = [
      '<input placeholder="Assets/**, *.cs" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off"',
      '/>',
      '<input',
      '  placeholder="**/Editor/**"',
      '  value={x}',
      '/>',
    ].join('\n');
    const hits = findUnguardedFields('Glob.tsx', src);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
  });

  it('still strips a real JSX block comment', () => {
    const src = '{/* a <textarea> lives here in prose only */}\nconst x = 1;';
    expect(findUnguardedFields('Jsx.tsx', src)).toEqual([]);
  });
});
