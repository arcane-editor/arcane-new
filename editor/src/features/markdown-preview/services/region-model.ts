/**
 * The editable regions of a plan document.
 *
 * A plan is rendered as chrome (a spine, step markers, a progress rule) around
 * a handful of spans that are actually TEXT the user types into. This module
 * names those spans and puts them in document order, so the view can mount one
 * editor per region and hand the caret between them.
 *
 * It adds no parsing of its own: every range here comes straight out of
 * `parsePlanDocument`, which already carries the two contracts this depends on
 * (see its header) — every byte lands in exactly one block, and blocks carry
 * OFFSETS into the original string rather than copies. So a region can be
 * sliced out, edited, and spliced back with `block-edit.ts`'s `replaceBlock`.
 *
 * Two ranges are deliberately narrower than the thing they belong to:
 *
 * - A step's TITLE region is `titleRange`, which the parser already trimmed of
 *   the `T<n>` id and the `[easy|hard]` tag. The executor routes on both, and
 *   they are not on screen — a region that included them could type them away.
 * - A step's GUIDE region is the guide entry's body, NOT its `### T<n>`
 *   heading. The heading is how `parsePlanDocument` pairs a guide back to its
 *   todo; editing it would break the pairing silently.
 *
 * Ids are keyed on STRUCTURE (which step, which prose block), never on
 * offsets: a caret hand-off or a focus restore happens across a re-parse of an
 * edited document, where every offset after the edit has moved.
 */

import type { PlanDocument, PlanRange } from './plan-document';

export type PlanRegionKind = 'prose' | 'title' | 'guide';

export interface PlanRegion {
  /** Stable across edits to the text; changes only when steps/blocks do. */
  id: string;
  kind: PlanRegionKind;
  range: PlanRange;
  /** 0-based index into `PlanDocument.steps`, or null for prose. */
  stepIndex: number | null;
}

/**
 * Every editable span of `doc`, in document order.
 *
 * Never throws — it backs a live view of a file the user is editing by hand,
 * the same rule `parsePlanDocument` and `plan-todos.ts` follow.
 */
export function planRegions(doc: PlanDocument): PlanRegion[] {
  const regions: PlanRegion[] = [];
  let prose = 0;
  let step = 0;

  for (const block of doc.blocks) {
    if (block.kind === 'markdown') {
      regions.push({ id: `prose-${prose++}`, kind: 'prose', range: block.range, stepIndex: null });
      continue;
    }
    for (const s of block.steps) {
      const index = step++;
      regions.push({
        id: `step-${index}-title`,
        kind: 'title',
        range: s.titleRange,
        stepIndex: index,
      });
      if (s.guide) {
        regions.push({
          id: `step-${index}-guide`,
          kind: 'guide',
          range: s.guide,
          stepIndex: index,
        });
      }
    }
  }

  return regions;
}

/**
 * The regions either side of `id` — what an ArrowUp off the top line or a
 * Backspace at offset 0 hands the caret to.
 *
 * An id that is no longer present (the step it named was deleted while the
 * keystroke was in flight) reports no neighbours rather than guessing at one.
 */
export function regionsInOrder(
  regions: readonly PlanRegion[],
  id: string,
): { previous: PlanRegion | null; next: PlanRegion | null } {
  const at = regions.findIndex((r) => r.id === id);
  if (at === -1) return { previous: null, next: null };
  return {
    previous: at > 0 ? regions[at - 1] : null,
    next: at < regions.length - 1 ? regions[at + 1] : null,
  };
}
