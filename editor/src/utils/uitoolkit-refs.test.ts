import { describe, it, expect } from 'bun:test';
import {
  extractQuerySites,
  extractCsUiRefs,
  resolveQueryName,
  nearestName,
  type LadderContext,
} from './uitoolkit-refs';

/**
 * Stand-in for `CSharpScan.code`: comments and string bodies blanked to spaces,
 * length and every offset preserved. The real one comes from `csharp-scan.ts`;
 * mimicking it here keeps this module a leaf with no feature imports, and
 * proves the functions match on `code` while reading values from `text`.
 */
function blankComments(text: string): string {
  return text.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const sites = (text: string) => extractQuerySites(blankComments(text), text);

describe('extractQuerySites — argument shapes', () => {
  it('reads a generic query with one literal', () => {
    const got = sites('root.Q<Button>("play-btn");');
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe('play-btn');
  });

  it('reads a non-generic query', () => {
    expect(sites('root.Q("play-btn");')[0].name).toBe('play-btn');
  });

  it('reads Query as well as Q', () => {
    expect(sites('root.Query<Label>("title");')[0].name).toBe('title');
  });

  it('treats the SECOND positional argument as a class, not a name', () => {
    const got = sites('root.Q<Button>("play-btn", "primary");')[0];
    expect(got.name).toBe('play-btn');
    expect(got.className).toBe('primary');
  });

  it('reads a named `name:` argument', () => {
    expect(sites('root.Q<Button>(name: "play-btn");')[0].name).toBe('play-btn');
  });

  it('yields NO name for a className-only query', () => {
    // The single easiest way to get this check wrong: `Q(className: "primary")`
    // names no element, so treating the literal as a name would report every
    // class-based query as a missing element.
    const got = sites('root.Q<Button>(className: "primary");')[0];
    expect(got.name).toBe(null);
    expect(got.className).toBe('primary');
  });

  it('yields no name for a null first argument', () => {
    expect(sites('root.Q(null, "primary");')[0].name).toBe(null);
  });

  it('yields no name for a type-only query', () => {
    // 18.4% of real call sites. Nothing to check, and that is correct.
    expect(sites('root.Q<ScrollView>();')[0].name).toBe(null);
  });

  it('yields no name when the argument is not a literal', () => {
    expect(sites('root.Q<Button>(buttonName);')[0].name).toBe(null);
  });

  it('spans the literal including its quotes, for the squiggle', () => {
    const text = 'var b = root.Q<Button>("play-btn");';
    const got = sites(text)[0];
    expect(text.slice(got.nameStart, got.nameEnd)).toBe('"play-btn"');
  });

  it('ignores a query inside a comment', () => {
    // Matching runs on the blanked view, so a call that is commented out never
    // produces a finding. This is the whole reason the technique exists.
    expect(sites('// root.Q<Button>("ghost");\nroot.Q<Button>("real");'))
      .toHaveLength(1);
    expect(sites('// root.Q<Button>("ghost");\nroot.Q<Button>("real");')[0].name).toBe('real');
  });
});

describe('extractCsUiRefs', () => {
  const refs = (text: string) => extractCsUiRefs(blankComments(text), text);

  it('finds a name assigned by property', () => {
    expect(refs('el.name = "runtime-made";').assignedNames).toContain('runtime-made');
  });

  it('finds a name assigned in an object initialiser', () => {
    expect(refs('var b = new Button { name = "init-made" };').assignedNames)
      .toContain('init-made');
  });

  it('finds classes added behaviourally', () => {
    const r = refs(`
      el.AddToClassList("added");
      el.RemoveFromClassList("removed");
      el.EnableInClassList("toggled", true);
      if (el.ClassListContains("probed")) { }
      root.Q<Button>(className: "queried");
    `);
    for (const c of ['added', 'removed', 'toggled', 'probed', 'queried']) {
      expect(r.referencedClasses).toContain(c);
    }
  });

  it('ignores an assignment inside a comment', () => {
    expect(refs('// el.name = "ghost";').assignedNames).toEqual([]);
  });
});

describe('nearestName', () => {
  it('suggests play-button for play-btn', () => {
    // The distance here is 3, so a fixed max-distance-of-2 bound would find
    // nothing. The bound has to scale with the length of the name.
    expect(nearestName(['play-button', 'quit-btn', 'menu-card'], 'play-btn')).toBe('play-button');
  });

  it('prefers a case-only difference over an edit-distance match', () => {
    expect(nearestName(['PlayButton', 'play-buttons'], 'playbutton')).toBe('PlayButton');
  });

  it('returns null when nothing is close', () => {
    expect(nearestName(['alpha', 'beta'], 'play-button')).toBe(null);
  });

  it('returns null for an empty pool', () => {
    expect(nearestName([], 'play-button')).toBe(null);
  });
});

// ── The ladder ───────────────────────────────────────────────────────────────

function ctx(over: Partial<LadderContext> = {}): LadderContext {
  return {
    associatedPath: null,
    associatedNames: null,
    projectNames: new Set(['play-button', 'quit-btn', 'menu-card']),
    csAssignedNames: new Set<string>(),
    allNames: ['play-button', 'quit-btn', 'menu-card'],
    ...over,
  };
}

describe('resolveQueryName — the confidence ladder', () => {
  it('rung 1: the associated UXML declares it', () => {
    const v = resolveQueryName('play-button', ctx({
      associatedPath: 'Assets/UI/MainMenu.uxml',
      associatedNames: new Set(['play-button']),
    }));
    expect(v.kind).toBe('resolved-associated');
    expect(v.rung).toBe(1);
  });

  it('rung 2: some UXML in the project declares it, association unknown', () => {
    const v = resolveQueryName('play-button', ctx());
    expect(v.kind).toBe('resolved-project');
    expect(v.rung).toBe(2);
  });

  it('rung 2 also catches a name the ASSOCIATED doc lacks but another has', () => {
    // A wrong association must never turn a project-wide hit into a report.
    const v = resolveQueryName('quit-btn', ctx({
      associatedPath: 'Assets/UI/MainMenu.uxml',
      associatedNames: new Set(['play-button']),
    }));
    expect(v.kind).toBe('resolved-project');
  });

  it('rung 3: a built-in control part, declared in no UXML anywhere', () => {
    // The measured false-positive class: all 21 unmatched names in the corpus
    // were of exactly this kind.
    for (const name of ['unity-content-container', 'unity-checkmark', 'unity-drag-container']) {
      const v = resolveQueryName(name, ctx());
      expect(v.kind).toBe('builtin-part');
      expect(v.rung).toBe(3);
    }
  });

  it('rung 4: something assigns the name from C#', () => {
    const v = resolveQueryName('runtime-made', ctx({
      csAssignedNames: new Set(['runtime-made']),
    }));
    expect(v.kind).toBe('assigned-in-code');
    expect(v.rung).toBe(4);
  });

  it('reports only when every rung has cleared', () => {
    const v = resolveQueryName('play-btn', ctx());
    expect(v.kind).toBe('unresolved');
    expect(v.suggestion).toBe('play-button');
  });

  it('stays silent while the C# walk is still running', () => {
    // Rung 4 is a SUPPRESSOR. Reporting before it has loaded means reporting
    // names we have not finished checking, so the answer is "not yet", never
    // "unresolved".
    const v = resolveQueryName('play-btn', ctx({ csAssignedNames: null }));
    expect(v.kind).toBe('insufficient-data');
  });

  it('stays silent when the project has no UXML at all', () => {
    // A project with no .uxml does not use UI Toolkit; there is nothing to
    // validate against and every verdict would be a guess.
    const v = resolveQueryName('play-btn', ctx({ projectNames: new Set(), allNames: [] }));
    expect(v.kind).toBe('insufficient-data');
  });

  it('carries the associated document through, for the message wording', () => {
    const v = resolveQueryName('play-btn', ctx({
      associatedPath: 'Assets/UI/MainMenu.uxml',
      associatedNames: new Set(['play-button']),
    }));
    expect(v.kind).toBe('unresolved');
    expect(v.associatedPath).toBe('Assets/UI/MainMenu.uxml');
  });

  it('never reports an empty name', () => {
    expect(resolveQueryName('', ctx()).kind).toBe('insufficient-data');
  });
});
