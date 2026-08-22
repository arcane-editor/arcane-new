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

function rank(effort: Effort): number {
  const index = EFFORT_ORDER.indexOf(effort);
  return index === -1 ? 0 : index;
}

/**
 * `effort` clamped down to `max` if it exceeds it — never up. Used everywhere
 * a requested/persisted/stepped effort has to respect the account's current
 * ceiling (`maxAllowedEffort`, `stores/server-config.ts`): stepping past it,
 * restoring a session saved under a higher plan, etc. An unrecognised value on
 * either side resolves to the bottom of the scale, same as `nextEffort`.
 */
export function clampEffort(effort: Effort, max: Effort): Effort {
  return rank(effort) > rank(max) ? max : effort;
}

/**
 * Tooltip / aria-label text for an effort bar the account's plan cannot
 * currently request (`EffortSelector`). `'low'` is never locked — every plan,
 * including signed-out/unknown, may request it — so it has no case here.
 */
export function effortLockMessage(effort: Effort): string {
  switch (effort) {
    case 'mid':
      return 'Deep Think — available on the Pro plan. Upgrade in Settings → Account.';
    case 'high':
      return 'Max — available on the Max plan. Upgrade in Settings → Account.';
    default:
      return '';
  }
}

/**
 * Effort to restore for a session's persisted value (already run through
 * `coerceEffort` by the caller), given the account's current ceiling —
 * `null` when server-config hasn't landed yet.
 *
 * `null` leaves the persisted value UNCLAMPED rather than clamping against
 * the conservative offline-fallback ceiling: at cold start `/v1/config` has
 * not landed, and clamping a Pro/Max account's persisted 'mid'/'high' down to
 * 'low' for the split second before the real config arrives would be a
 * needless downgrade. `EffortSelector` fails closed on unknown config in that
 * same window (only 'low' selectable), and the server's 403 remains the
 * authoritative gate on send regardless of what gets restored here.
 */
export function restoreEffort(persisted: Effort, maxAllowed: Effort | null): Effort {
  return maxAllowed === null ? persisted : clampEffort(persisted, maxAllowed);
}
