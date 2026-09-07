import { describe, it, expect } from 'bun:test';
import { createEditor, $getRoot } from 'lexical';
import { spliceRegion } from './region-write';
import { parsePlanDocument } from './plan-document';
import { planRegions } from './region-model';
import {
  PLAN_EDITOR_NODES,
  importRegionMarkdown,
  exportRegionMarkdown,
  splitRegionText,
} from './region-markdown';

const PLAN = `# Add the inventory panel

## Todos
- [ ] T1 [easy] Wire the panel
- [x] T2 [hard] Fill the slot grid

## Guide

### T1: Wire the panel
File: \`Assets/UI/InventoryPanel.uxml\`

### T2: Fill the slot grid
Apply the same conditional guard.

## Risks
Nothing structural.
`;

/** Everything except the span that was supposed to change. */
function outsideOf(before: string, after: string): { before: string; after: string } {
  let head = 0;
  while (head < before.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    before: before.slice(0, head) + before.slice(before.length - tail),
    after: after.slice(0, head) + after.slice(after.length - tail),
  };
}

describe('spliceRegion', () => {
  it('rewrites one guide and leaves every other byte of the file alone', () => {
    const next = spliceRegion(PLAN, 'step-0-guide', 'File: `Assets/UI/Inventory.uxml`\n\nThen rebuild.')!;

    expect(next).toContain('File: `Assets/UI/Inventory.uxml`');
    expect(next).toContain('Then rebuild.');
    // The bookkeeping the executor reads is untouched.
    expect(next).toContain('- [ ] T1 [easy] Wire the panel');
    expect(next).toContain('### T1: Wire the panel');
    expect(next).toContain('### T2: Fill the slot grid');
    expect(next).toContain('Apply the same conditional guard.');
    expect(next).toContain('## Risks');
    // And the blank lines around the edited body survived it.
    expect(next).toContain('### T1: Wire the panel\nFile: `Assets/UI/Inventory.uxml`\n\nThen rebuild.\n\n### T2');
  });

  // The guard the whole region design exists for: a title edit must not be
  // able to reach the `T<n>` id or the difficulty tag sitting in front of it.
  it('keeps a step id and difficulty tag through a title rewrite', () => {
    const next = spliceRegion(PLAN, 'step-1-title', 'Fill the grid, then verify')!;
    expect(next).toContain('- [x] T2 [hard] Fill the grid, then verify');
    // The guide heading keeps the OLD wording: it is how `parsePlanDocument`
    // pairs a guide back to its todo, and renaming a step is not a licence to
    // rewrite it.
    expect(next).toContain('### T2: Fill the slot grid');
    expect(next).not.toContain('- [x] T2 [hard] Fill the slot grid');
  });

  it('changes nothing outside the edited region, byte for byte', () => {
    const next = spliceRegion(PLAN, 'prose-1', '## Risks\nThe grid may not exist yet.')!;
    const { before, after } = outsideOf(PLAN, next);
    expect(after).toBe(before);
  });

  it('returns null when the body is what the file already says', () => {
    expect(spliceRegion(PLAN, 'step-0-guide', 'File: `Assets/UI/InventoryPanel.uxml`')).toBeNull();
  });

  it('returns null for a region the document no longer has', () => {
    expect(spliceRegion(PLAN, 'step-9-guide', 'anything')).toBeNull();
  });

  it('preserves CRLF line endings', () => {
    const crlf = PLAN.replace(/\n/g, '\r\n');
    const next = spliceRegion(crlf, 'step-0-guide', 'One line\nTwo line')!;
    expect(next).toContain('One line\r\nTwo line');
    expect(next).not.toMatch(/[^\r]\n/);
  });

  it('accepts an emptied region without dropping the checkbox line it belongs to', () => {
    const next = spliceRegion(PLAN, 'step-0-title', '')!;
    expect(next).toContain('- [ ] T1 [easy] ');
    expect(next).toContain('- [x] T2 [hard] Fill the slot grid');
  });
});

// The whole pipeline the in-place editor rests on, with a REAL Lexical editor
// standing in for the one on screen: markdown in, a keystroke, markdown out,
// spliced back into the plan. Everything here except the DOM is what runs when
// someone types in a guide.
describe('typing in a region — end to end', () => {
  function editorFor(body: string) {
    const editor = createEditor({
      namespace: 'region-write-test',
      nodes: PLAN_EDITOR_NODES,
      onError: (e: Error) => {
        throw e;
      },
    });
    importRegionMarkdown(editor, body);
    return editor;
  }

  function bodyOf(doc: string, regionId: string): string {
    const region = planRegions(parsePlanDocument(doc)).find((r) => r.id === regionId)!;
    return splitRegionText(doc.slice(region.range.start, region.range.end)).body;
  }

  it('lands typed text in the file and leaves the plan skeleton alone', () => {
    const editor = editorFor(bodyOf(PLAN, 'step-0-guide'));

    editor.update(
      () => {
        $getRoot().selectEnd().insertText(' Rebuild after saving.');
      },
      { discrete: true },
    );

    const next = spliceRegion(PLAN, 'step-0-guide', exportRegionMarkdown(editor))!;

    expect(next).toContain('File: `Assets/UI/InventoryPanel.uxml` Rebuild after saving.');
    expect(next).toContain('- [ ] T1 [easy] Wire the panel');
    expect(next).toContain('- [x] T2 [hard] Fill the slot grid');
    expect(next).toContain('### T1: Wire the panel');
    expect(next).toContain('## Risks');
  });

  // Opening an editor is not always byte-identical: Lexical gives `## Risks`
  // back with the blank line after it that the file did not have. Two
  // properties keep that from rewriting a file nobody edited — it is stable
  // (a second open changes nothing more), and it never reaches outside the
  // region's own span. The third guard is in the component:
  // `PlanRegionEditor` compares edits against what the EDITOR serializes, not
  // against the file, so simply mounting one emits no change at all.
  it('serializes a freshly opened region stably, and only within that region', () => {
    for (const id of ['prose-0', 'step-0-guide', 'step-1-guide', 'prose-1']) {
      const first = exportRegionMarkdown(editorFor(bodyOf(PLAN, id)));
      expect(exportRegionMarkdown(editorFor(first))).toBe(first);

      const next = spliceRegion(PLAN, id, first);
      if (next === null) continue; // byte-identical: nothing to write
      const { before, after } = outsideOf(PLAN, next);
      expect(after).toBe(before);
    }
  });

  it('keeps a checkbox typed into a guide as a task-list line', () => {
    const editor = editorFor(bodyOf(PLAN, 'step-1-guide'));

    editor.update(
      () => {
        $getRoot().selectEnd().insertRawText('\n- [ ] verify the guard');
      },
      { discrete: true },
    );

    const next = spliceRegion(PLAN, 'step-1-guide', exportRegionMarkdown(editor))!;
    expect(next).toContain('- [ ] verify the guard');
    // The step's own checkbox line is untouched by an edit to its guide.
    expect(next).toContain('- [x] T2 [hard] Fill the slot grid');
  });
});
