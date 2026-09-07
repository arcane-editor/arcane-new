/**
 * What a keystroke at the EDGE of a region means.
 *
 * Inside a region, Lexical already behaves like a document: Enter splits a
 * paragraph, Backspace joins one, the arrows walk the lines. This module owns
 * the other case — the caret is against an edge and the next thing it wants is
 * in a different editor, or is not a text edit at all but a change to the
 * plan's structure.
 *
 * It is pure and DOM-free on purpose (`region-nav.test.ts`): the plugin that
 * calls it reads the facts off the Lexical selection, and every RULE lives
 * here where it can be read and tested without an editor.
 *
 * The rules, as agreed:
 *
 * - **Enter on an empty trailing line of a guide** promotes: the empty line is
 *   the escape hatch that starts the next step, the same gesture that leaves a
 *   nested list in Notion. Anywhere else in a body, Enter is just a new line.
 * - **Enter in a title** never splits it — a title is the text of one checkbox
 *   line. It moves the caret into that step's guide, or is swallowed when the
 *   step has no guide yet.
 * - **Backspace at the very start** hands the caret to the end of the region
 *   above rather than merging text across the boundary: pulling a guide's prose
 *   up into a checkbox title is never what someone means. The one exception is
 *   an empty step, where Backspace deletes it.
 * - **ArrowUp on the first line / ArrowDown on the last** cross to the
 *   neighbouring region so the document reads as one surface.
 * - **Nothing crosses a boundary while text is selected** — then the key is
 *   editing the selection, not walking off an edge.
 *
 * Neighbours come from `region-model.ts`, in SCREEN order (a step's title and
 * guide are adjacent on screen though they sit far apart in the file).
 */

import { regionsInOrder, type PlanRegion } from './region-model';

export type NavIntent =
  /** Let Lexical handle the key normally. */
  | { kind: 'default' }
  /** Swallow the key: it would do something wrong, and nothing better exists. */
  | { kind: 'consume' }
  /** Move the caret to another region. */
  | { kind: 'focus'; regionId: string; caret: 'start' | 'end' }
  /** Insert a new step after this one and put the caret in its title. */
  | { kind: 'promote-step'; afterStepIndex: number }
  /** Delete this step; the caret lands in the region above. */
  | { kind: 'remove-step'; stepIndex: number };

export interface BoundaryInput {
  regions: readonly PlanRegion[];
  regionId: string;
  key: 'Enter' | 'Backspace' | 'ArrowUp' | 'ArrowDown';
  /** False when a range is selected — no boundary rule applies then. */
  collapsed: boolean;
  atStart: boolean;
  atEnd: boolean;
  atFirstLine: boolean;
  atLastLine: boolean;
  /** The caret is on a trailing line that has no text on it. */
  onEmptyTrailingLine: boolean;
  /** This region has no text at all. */
  regionIsEmpty: boolean;
  /** This region's whole STEP is empty — title and guide both. */
  stepIsEmpty: boolean;
}

const DEFAULT: NavIntent = { kind: 'default' };

export function resolveBoundary(i: BoundaryInput): NavIntent {
  if (!i.collapsed) return DEFAULT;

  const region = i.regions.find((r) => r.id === i.regionId);
  if (!region) return DEFAULT;
  const { previous, next } = regionsInOrder(i.regions, i.regionId);

  switch (i.key) {
    case 'Enter': {
      if (region.kind === 'title') {
        // Single-line by construction: it is the text of a checkbox line.
        return next && next.kind === 'guide'
          ? { kind: 'focus', regionId: next.id, caret: 'start' }
          : { kind: 'consume' };
      }
      if (region.kind === 'guide' && region.stepIndex !== null && i.atEnd && i.onEmptyTrailingLine) {
        return { kind: 'promote-step', afterStepIndex: region.stepIndex };
      }
      return DEFAULT;
    }

    case 'Backspace': {
      if (!i.atStart) return DEFAULT;
      if (region.kind === 'title' && region.stepIndex !== null && i.regionIsEmpty && i.stepIsEmpty) {
        return { kind: 'remove-step', stepIndex: region.stepIndex };
      }
      return previous ? { kind: 'focus', regionId: previous.id, caret: 'end' } : DEFAULT;
    }

    case 'ArrowUp':
      return i.atFirstLine && previous
        ? { kind: 'focus', regionId: previous.id, caret: 'end' }
        : DEFAULT;

    case 'ArrowDown':
      return i.atLastLine && next ? { kind: 'focus', regionId: next.id, caret: 'start' } : DEFAULT;

    default:
      return DEFAULT;
  }
}
