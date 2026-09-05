import { describe, it, expect } from 'bun:test';
import { EXTERNAL_STARTERS, STARTERS, groundingLabel, startersFor, type GroundingInput, externalAgentBrief } from './empty-state';
import { MODES, MODE_LADDER, DESIGN_MODE } from './modes';

const base: GroundingInput = {
  workspaceName: 'UnityIDE Demo',
  isUnityProject: true,
  unityVersion: '6000.3.5f2',
  indexStatus: 'ready',
  assetCount: 1284,
};

describe('groundingLabel', () => {
  it('invites the user to open a folder when there is no workspace', () => {
    expect(groundingLabel({ ...base, workspaceName: null })).toBe('Open a folder to start');
  });

  it('names the folder for a project that is not a Unity project', () => {
    expect(groundingLabel({ ...base, isUnityProject: false })).toBe('UnityIDE Demo');
  });

  it('reports the asset count and Unity version once the index is ready', () => {
    expect(groundingLabel(base)).toBe('1,284 assets indexed · Unity 6000.3.5f2');
  });

  it('says it is still indexing rather than showing a stale count', () => {
    expect(groundingLabel({ ...base, indexStatus: 'building' })).toBe('Indexing UnityIDE Demo…');
  });

  /**
   * The whole job of this line is to answer "does it actually know my
   * project?", so it must never imply an index that is not there. A count is
   * claimed only for a ready index with something in it; every other state
   * falls back to naming the project.
   */
  it('never claims a count unless the index is ready and non-empty', () => {
    const claims: string[] = [];
    for (const indexStatus of ['idle', 'building', 'ready', 'error'] as const) {
      for (const assetCount of [null, 0, 1284]) {
        const label = groundingLabel({ ...base, indexStatus, assetCount });
        if (label.includes('indexed')) claims.push(`${indexStatus}/${assetCount}`);
      }
    }
    expect(claims).toEqual(['ready/1284']);
  });

  it('falls back to a plain Unity label when the version is unknown', () => {
    expect(groundingLabel({ ...base, unityVersion: null, indexStatus: 'idle' })).toBe(
      'UnityIDE Demo · Unity project',
    );
  });
});

describe('STARTERS', () => {
  it('covers every mode the composer can be in', () => {
    // Design is a real composer mode that is deliberately absent from the
    // pickable menu, so the empty state still owes it starters.
    const every = [...MODES.map((m) => m.value), DESIGN_MODE.value];
    expect(Object.keys(STARTERS).sort()).toEqual(every.sort());
  });

  it('gives every mode usable, distinct prompts', () => {
    const all: string[] = [];
    const empty: string[] = [];
    for (const [mode, prompts] of Object.entries(STARTERS)) {
      if (prompts.length === 0) empty.push(mode);
      for (const p of prompts) {
        if (p.trim().length === 0) empty.push(`${mode}: blank prompt`);
      }
      all.push(...prompts);
    }
    expect(empty).toEqual([]);
    // Duplicates across modes would make the list look padded and teach the
    // wrong thing — the prompts are how each mode advertises what it is for.
    expect(all.length - new Set(all).size).toBe(0);
  });
});

describe('MODE_LADDER', () => {
  it('is the same three modes, ordered by how much they may touch', () => {
    expect(MODE_LADDER.map((m) => m.value)).toEqual(['ask', 'plan', 'agent']);
    expect(MODE_LADDER.length).toBe(MODES.length);
  });

  /**
   * `ModeSelector` resolves an unknown stored mode to `MODES[1]`. If the menu
   * order is ever resequenced, that fallback silently becomes a different
   * mode — and the one it must be is the app's default, agent.
   */
  it('leaves the menu order alone, since ModeSelector falls back to MODES[1]', () => {
    expect(MODES[1].value).toBe('agent');
  });
});

describe('startersFor', () => {
  it('gives the UnityIDE agent the starters written for its current mode', () => {
    for (const mode of ['ask', 'plan', 'agent'] as const) {
      expect(startersFor('hosted', mode)).toEqual(STARTERS[mode]);
    }
  });

  /**
   * The reported bug: with Claude Code selected the empty state still offered
   * UnityIDE's PLAN starters under an "On send / Plan" ladder Claude does not
   * read. An external agent has one set of starters, because UnityIDE's mode is
   * not part of the request it receives.
   */
  it('gives an external agent one mode-independent set', () => {
    const seen = (['ask', 'plan', 'agent'] as const).map((mode) => startersFor('claude', mode));
    for (const set of seen) expect(set).toEqual(EXTERNAL_STARTERS);
    expect(EXTERNAL_STARTERS.length).toBeGreaterThan(0);
  });

  it('does not hand an external agent starters phrased for a UnityIDE mode', () => {
    const hostedOnly = new Set(Object.values(STARTERS).flat());
    for (const text of EXTERNAL_STARTERS) expect(hostedOnly.has(text)).toBe(false);
  });
});

describe('externalAgentBrief', () => {
  it('is null for UnityIDE — its own loop answers with the mode ladder', () => {
    expect(externalAgentBrief('hosted')).toBeNull();
  });

  it('names the agent, so the block cannot go stale against the picker', () => {
    expect(externalAgentBrief('claude')?.name).toBe('Claude Code');
  });

  // The slot the mode ladder used to fill answers "what will pressing Enter
  // do?". For an external agent the two things that actually change the answer
  // are whose account it spends and where its controls are — not a description
  // of our agent loop, which the user does not operate.
  it('says whose account the send spends', () => {
    const facts = externalAgentBrief('claude')?.facts ?? [];
    expect(facts.some((f) => /your Anthropic account/i.test(f))).toBe(true);
  });

  it('points at the toolbar, in words the toolbar itself uses', () => {
    const facts = externalAgentBrief('claude')?.facts ?? [];
    const pointer = facts.find((f) => /toolbar/i.test(f)) ?? '';
    expect(pointer).toMatch(/mode/i);
    expect(pointer).toMatch(/model/i);
    expect(pointer).toMatch(/effort/i);
  });

  it('keeps each fact to one line-length clause', () => {
    for (const fact of externalAgentBrief('claude')?.facts ?? []) {
      expect(fact.length).toBeLessThanOrEqual(72);
      expect(fact.endsWith('.')).toBe(true);
    }
  });

  it('never claims a control UnityIDE owns — no Ask/Plan/Agent ladder here', () => {
    const all = (externalAgentBrief('claude')?.facts ?? []).join(' ');
    expect(all).not.toMatch(/\b(Ask|Plan mode|Agent mode)\b/);
  });
});
