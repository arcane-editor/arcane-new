import { describe, it, expect } from 'bun:test';
import { splitRegionText, joinRegionText, roundTripRegion, roundTripTitle } from './region-markdown';

const GUIDE = `File: \`Assets/UI/InventoryPanel.uxml\`

Apply the **same** conditional guard, then:

- open \`InventoryPanel.uxml\`
- add the slot grid
- [ ] a nested todo
- [x] a done one

1. first
2. second

> a quote line

\`\`\`ts
const x = 1;
\`\`\`

See [the docs](https://example.com) for the rest.`;

describe('roundTripRegion — what survives a trip through the editor', () => {
  // This is the load-bearing property of the whole WYSIWYG surface: the text
  // the user sees is Lexical nodes, and what lands back in the .aplan file is
  // whatever those nodes serialize to. Anything this test does not pin down is
  // free to change under the user's hands.
  it('preserves a realistic guide body byte for byte', () => {
    expect(roundTripRegion(GUIDE)).toBe(GUIDE);
  });

  it('is idempotent — a second trip changes nothing more', () => {
    const once = roundTripRegion(GUIDE);
    expect(roundTripRegion(once)).toBe(once);
  });

  it('keeps task-list syntax, which the executor ticks off by hand', () => {
    const md = '- [ ] not yet\n- [x] done';
    expect(roundTripRegion(md)).toBe(md);
  });

  it('keeps fenced code blocks with their language tag', () => {
    const md = '```csharp\nvar go = new GameObject();\n```';
    expect(roundTripRegion(md)).toBe(md);
  });

  it('keeps headings, emphasis, inline code and links', () => {
    const md = '#### A heading\n\n**bold** and *italic* and `code` and [a link](https://x.dev)';
    expect(roundTripRegion(md)).toBe(md);
  });

  it('returns an empty string for an empty region rather than throwing', () => {
    expect(roundTripRegion('')).toBe('');
    expect(roundTripRegion('   ')).toBe('');
  });
});

describe('splitRegionText / joinRegionText — splice safety', () => {
  // A region's range includes the blank lines around it. Those bytes are not
  // the user's text and must never travel through the editor: re-attaching
  // them verbatim is what keeps a plan file's spacing (and the offsets of
  // every OTHER region) exactly as the model wrote them.
  it('round-trips an untouched region byte for byte, whitespace included', () => {
    const src = '\n\nFile: `a.ts`\n\n';
    const part = splitRegionText(src);
    expect(part.leading).toBe('\n\n');
    expect(part.body).toBe('File: `a.ts`');
    expect(part.trailing).toBe('\n\n');
    expect(joinRegionText(part, part.body)).toBe(src);
  });

  it('re-attaches the original padding around edited text', () => {
    const part = splitRegionText('\n\nold body\n\n');
    expect(joinRegionText(part, 'new body')).toBe('\n\nnew body\n\n');
  });

  it('detects CRLF and writes the edited body back with CRLF', () => {
    const src = '\r\nFirst line\r\nSecond line\r\n';
    const part = splitRegionText(src);
    expect(part.eol).toBe('\r\n');
    // The body handed to the editor is always LF — Lexical has no concept of
    // CRLF, so normalizing on the way in is what keeps the round trip clean.
    expect(part.body).toBe('First line\nSecond line');
    expect(joinRegionText(part, part.body)).toBe(src);
    expect(joinRegionText(part, 'First line\nEdited')).toBe('\r\nFirst line\r\nEdited\r\n');
  });

  it('reports LF for a region with no line break at all', () => {
    expect(splitRegionText('one line').eol).toBe('\n');
  });

  it('handles a region that is nothing but whitespace', () => {
    const part = splitRegionText('\n\n');
    expect(part.body).toBe('');
    expect(joinRegionText(part, '')).toBe('\n\n');
  });

  // The composition the caller actually performs: split, edit the body through
  // the editor, join. An untouched region must come back unchanged.
  it('composes with roundTripRegion without disturbing an untouched region', () => {
    const src = `\n${GUIDE}\n\n`;
    const part = splitRegionText(src);
    expect(joinRegionText(part, roundTripRegion(part.body))).toBe(src);
  });
});

describe('roundTripTitle — one line of a checkbox row', () => {
  it('keeps the identifiers plan titles are made of', () => {
    const md = 'Fix `GET /b2b/domain/:domainName` for **missing** domains';
    expect(roundTripTitle(md)).toBe(md);
  });

  // Block syntax in a title is text, not structure: a title that became a list
  // would be spliced back into the middle of its own `- [ ]` row.
  it('leaves block syntax literal', () => {
    expect(roundTripTitle('- not a list')).toBe('- not a list');
    expect(roundTripTitle('## not a heading')).toBe('## not a heading');
    expect(roundTripTitle('- [ ] not a checkbox')).toBe('- [ ] not a checkbox');
  });

  it('flattens pasted multi-line text onto one line', () => {
    expect(roundTripTitle('First half\n\nsecond half')).toBe('First half second half');
  });

  it('is idempotent, and empty stays empty', () => {
    const once = roundTripTitle('Wire the `InventoryPanel`');
    expect(roundTripTitle(once)).toBe(once);
    expect(roundTripTitle('')).toBe('');
  });
});
