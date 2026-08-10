/**
 * One-time, event-triggered hints.
 *
 * Deliberately not a tour. A walkthrough on first launch interrupts before the
 * user has any reason to care about what it is showing, and is dismissed
 * reflexively. These fire when a capability first becomes *relevant* — Unity
 * connects, the first C# file opens, the first compile error arrives — which is
 * the moment the answer is worth something.
 *
 * Rules, all of which exist so this can never become nagging:
 *   - at most one visible at a time;
 *   - each shown at most once, ever, persisted across restarts;
 *   - never during the first few seconds of a session, so nothing competes
 *     with the app finishing its own startup;
 *   - a global off switch, and a way to see them again.
 */

export interface CoachMark {
  id: string;
  /** Selector for the element to point at. Skipped if it is not on screen. */
  anchor: string;
  message: string;
  /** Command whose chord is shown alongside, if any. */
  commandId?: string;
}

export const COACH_MARKS: Record<string, CoachMark> = {
  unityConnected: {
    id: 'unityConnected',
    anchor: '[data-coach="hierarchy"]',
    message: 'Unity is connected — your live scene hierarchy is here.',
    commandId: 'view.hierarchy',
  },
  firstCsharpFile: {
    id: 'firstCsharpFile',
    anchor: '[data-coach="ai-panel"]',
    message: 'Ask about this script, or have it edited for you.',
    commandId: 'view.aiPanel',
  },
  firstCompileError: {
    id: 'firstCompileError',
    anchor: '[data-coach="problems"]',
    message: 'Unity reported a compile error. Arcane can read it and propose a fix.',
  },
  firstPlanReady: {
    id: 'firstPlanReady',
    anchor: '[data-coach="ai-panel"]',
    message: 'Select any text in a plan to suggest a change before running it.',
  },
};

const STORAGE_KEY = 'arcane.coachMarks.seen';

function readSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // A corrupt value must not resurrect every hint; treat it as "all seen".
    return new Set(Object.keys(COACH_MARKS));
  }
}

function writeSeen(seen: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...seen]));
  } catch {
    // Private mode / quota. Losing the record means a hint may show twice,
    // which is survivable; throwing here would not be.
  }
}

export function hasSeen(id: string): boolean {
  return readSeen().has(id);
}

export function markSeen(id: string): void {
  const seen = readSeen();
  seen.add(id);
  writeSeen(seen);
}

/** Show every hint again. Surfaced in Settings. */
export function resetSeen(): void {
  writeSeen(new Set());
}

/**
 * Whether `id` should be shown now.
 *
 * `enabled` is the user's global preference; `elapsedMs` is how long this
 * session has been running, so nothing appears while the app is still
 * assembling itself.
 */
const SETTLE_MS = 4000;

export function shouldShow(id: string, enabled: boolean, elapsedMs: number): boolean {
  if (!enabled) return false;
  if (elapsedMs < SETTLE_MS) return false;
  if (!COACH_MARKS[id]) return false;
  return !hasSeen(id);
}
