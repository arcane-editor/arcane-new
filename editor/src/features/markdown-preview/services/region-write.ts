/**
 * Put an edited region back into the plan file.
 *
 * This is the whole write path of in-place editing, in one pure function: the
 * editor hands over the region's new BODY text, and this decides where in the
 * file it goes and what the file becomes. It lives here rather than in the
 * view so it can be tested against real plan documents — the guarantees below
 * are the ones a user notices only when they break.
 *
 * - The file is re-parsed from the text passed in, so the caller can hand over
 *   the freshest content rather than whatever a React render captured.
 * - Only the region's own span is replaced; the blank lines around it are
 *   re-attached verbatim (`joinRegionText`), so nothing outside the span
 *   moves — not one byte, not the `T<n>` ids, not the `### T<n>` headings.
 * - A body that matches what the file already says returns `null` rather than
 *   an identical string, so re-serializing a region nobody touched can never
 *   mark the document dirty.
 */

import { replaceBlock } from './block-edit';
import { parsePlanDocument } from './plan-document';
import { planRegions } from './region-model';
import { joinRegionText, splitRegionText } from './region-markdown';

/**
 * `source` with `regionId`'s body replaced by `body`, or `null` when there is
 * nothing to write (unknown region, or no actual change).
 */
export function spliceRegion(source: string, regionId: string, body: string): string | null {
  const region = planRegions(parsePlanDocument(source)).find((r) => r.id === regionId);
  if (!region) return null;

  const raw = source.slice(region.range.start, region.range.end);
  const next = joinRegionText(splitRegionText(raw), body);
  if (next === raw) return null;

  return replaceBlock(source, region.range.start, region.range.end, next);
}
