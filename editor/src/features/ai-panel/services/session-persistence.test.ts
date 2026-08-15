import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSessionData, parseSessionData } from './session-persistence';
import type { SaveSessionInput, SessionData } from './session-persistence';
import type { AiMessage, ArcanePlanEntry } from '../../../stores/ai';

const MESSAGES: AiMessage[] = [{ id: 'm1', role: 'user', text: 'hello', timestamp: 1000 }];

const PLAN: ArcanePlanEntry[] = [
  { text: 'Add CoinPickup component', status: 'done' },
  { text: 'Wire pickup to scene', status: 'in_progress' },
  { text: 'Write EditMode test', status: 'pending' },
];

const INPUT: SaveSessionInput = {
  id: 'session-1',
  mode: 'agent',
  effort: 'high',
  messages: MESSAGES,
  agentKind: 'arcane',
  workspacePath: '/proj',
  arcanePlan: PLAN,
};

describe('buildSessionData / parseSessionData — arcanePlan round-trip (T9)', () => {
  it('round-trips a full arcanePlan through save + load', () => {
    const data = buildSessionData(INPUT);
    const json = JSON.stringify(data, null, 2);
    const parsed = parseSessionData(json);
    expect(parsed.arcanePlan).toEqual(PLAN);
  });

  it('round-trips an explicit null arcanePlan (no plan yet this session)', () => {
    const data = buildSessionData({ ...INPUT, arcanePlan: null });
    const json = JSON.stringify(data);
    expect(parseSessionData(json).arcanePlan).toBeNull();
  });

  it('defaults arcanePlan to null when the save input omits it entirely', () => {
    const { arcanePlan: _omit, ...rest } = INPUT;
    const data = buildSessionData(rest as SaveSessionInput);
    expect(data.arcanePlan).toBeNull();
  });

  it('restores arcanePlan as undefined for a legacy file that never wrote the key', () => {
    // Simulates a session JSON written before T9 — no "arcanePlan" key at all.
    const legacyJson = JSON.stringify({
      id: 'session-1',
      createdAt: 1000,
      updatedAt: 1000,
      mode: 'agent',
      effort: 'high',
      messages: MESSAGES,
      agentKind: 'arcane',
      workspacePath: '/proj',
      title: 'legacy chat',
    } satisfies Omit<SessionData, 'arcanePlan'>);

    const parsed = parseSessionData(legacyJson);
    expect(parsed.arcanePlan).toBeUndefined();
    // stores/ai.ts's loadSessionIntoStore coerces this the same way:
    expect(parsed.arcanePlan ?? null).toBeNull();
  });

  it('produces valid, human-readable JSON containing the arcanePlan items', () => {
    const json = JSON.stringify(buildSessionData(INPUT), null, 2);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).toContain('"arcanePlan"');
    expect(json).toContain('Add CoinPickup component');
  });
});

// `stores/ai.ts` can't be imported here to assert on its live state: its
// module graph (the ai-panel barrel's `AiChatPanel`/`MaximizedAiOverlay`
// exports, plus `stores/workspace.ts`) transitively touches `document` at
// module-eval time, fatal under plain `bun test` (see arcane-stream.test.ts's
// header for the same chain). Worse, `arcane-stream.test.ts` (same directory,
// loaded in the same process) permanently `mock.module`'s `stores/ai` itself
// with no restore, and Bun's module mocks are process-global — so once that
// file has run, EVERY later `import('../../../stores/ai')` anywhere in the
// suite silently resolves to that file's stub instead of the real store,
// regardless of load order tricks. A source-text assertion sidesteps both
// problems entirely (same technique `keybinding-parity.test.ts` uses for a
// similarly import-hostile cross-cutting check) and is exactly as precise:
// it fails the instant the literal default or the coercion call site changes.
const AI_STORE_SRC = readFileSync(path.resolve(import.meta.dir, '../../../stores/ai.ts'), 'utf8');

describe('stores/ai — default effort + restore coercion', () => {
  it('defaults effort to "low" (Standard) — the only tier every plan can use, including Free', () => {
    expect(AI_STORE_SRC).toMatch(/\beffort:\s*'low',/);
  });

  it('restores a persisted effort through coerceEffort, never passing the raw value through', () => {
    expect(AI_STORE_SRC).toMatch(/effort:\s*coerceEffort\(session\.effort\)/);
  });
});

// coerceEffort itself (services/types.ts) is unit-tested directly in
// types.test.ts, including `coerceEffort('super') === 'low'` — the exact
// migration case this restore call site depends on.

// ---------------------------------------------------------------------------
// Plan-state persistence (agent-reliability fix): planPhase/activePlanPath
// used to be in-memory only, so an app reload forgot a mid-flight plan and
// the composer re-planned instead of resuming.
// ---------------------------------------------------------------------------
import { normalizePlanRestore } from './session-persistence';

describe('plan-state persistence', () => {
  const baseInput = {
    id: 's1',
    mode: 'plan',
    effort: 'low',
    messages: [{ id: 'm1', role: 'user', text: 'go', timestamp: 1 }],
    agentKind: 'arcane',
    workspacePath: '/ws',
  } as never;

  it('round-trips planPhase and activePlanPath through build + parse', () => {
    const data = parseSessionData(
      JSON.stringify(
        buildSessionData({
          ...(baseInput as object),
          planPhase: 'awaiting-execute',
          activePlanPath: '/ws/.arcane/plans/x.md',
        } as never),
      ),
    );
    expect(data.planPhase).toBe('awaiting-execute');
    expect(data.activePlanPath).toBe('/ws/.arcane/plans/x.md');
  });

  it('omits the keys entirely for a session with no plan (file shape unchanged)', () => {
    const data = buildSessionData({ ...(baseInput as object), planPhase: 'idle', activePlanPath: null } as never);
    expect('planPhase' in data).toBe(false);
    expect('activePlanPath' in data).toBe(false);
  });

  it('legacy records without the keys parse with them undefined', () => {
    const data = parseSessionData(JSON.stringify(buildSessionData(baseInput)));
    expect(data.planPhase).toBeUndefined();
    expect(data.activePlanPath).toBeUndefined();
  });
});

describe('normalizePlanRestore', () => {
  it('restores awaiting-execute as-is', () => {
    expect(normalizePlanRestore('awaiting-execute', '/p.md')).toEqual({
      planPhase: 'awaiting-execute',
      activePlanPath: '/p.md',
    });
  });

  it('normalizes a saved executing phase to awaiting-execute (no run is live after a reload)', () => {
    expect(normalizePlanRestore('executing', '/p.md')).toEqual({
      planPhase: 'awaiting-execute',
      activePlanPath: '/p.md',
    });
  });

  it('normalizes a saved planning phase to idle and drops the path', () => {
    expect(normalizePlanRestore('planning', '/p.md')).toEqual({ planPhase: 'idle', activePlanPath: null });
  });

  it('defaults a legacy record to idle', () => {
    expect(normalizePlanRestore(undefined, undefined)).toEqual({ planPhase: 'idle', activePlanPath: null });
  });

  it('a pending phase with no path degrades to idle (nothing to resume)', () => {
    expect(normalizePlanRestore('awaiting-execute', null)).toEqual({ planPhase: 'idle', activePlanPath: null });
  });
});

describe('stores/ai — plan-state save/restore wiring', () => {
  it('buildSaveInput passes planPhase and activePlanPath', () => {
    expect(AI_STORE_SRC).toMatch(/planPhase:\s*state\.planPhase/);
    expect(AI_STORE_SRC).toMatch(/activePlanPath:\s*state\.activePlanPath/);
  });

  it('loadSessionIntoStore restores through normalizePlanRestore, never raw', () => {
    expect(AI_STORE_SRC).toMatch(/normalizePlanRestore\(session\.planPhase,\s*session\.activePlanPath\)/);
  });
});
