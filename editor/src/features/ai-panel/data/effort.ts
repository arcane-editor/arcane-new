/**
 * Reasoning-effort levels as an ordered scale.
 *
 * Pure so the stepping rules can be tested without a DOM, the same reason
 * `empty-state.ts` and `layout-sizes.ts` are.
 */

import type { Effort } from '../services/types';

/** Standard → Max. Index in this array IS the level. */
export const EFFORT_ORDER: Effort[] = ['low', 'mid', 'high'];

/**
 * The level `delta` steps from `current`, clamped at both ends.
 *
 * Clamped rather than wrapping: this is a scale, not a carousel, and a
 * held-down arrow that silently rolled Max back to Standard would spend a
 * lot of somebody's money. An unrecognised current level resolves to the
 * bottom of the scale rather than throwing.
 */
export function nextEffort(current: Effort, delta: number): Effort {
  const index = EFFORT_ORDER.indexOf(current);
  const from = index === -1 ? 0 : index;
  const target = Math.min(EFFORT_ORDER.length - 1, Math.max(0, from + delta));
  return EFFORT_ORDER[target];
}
