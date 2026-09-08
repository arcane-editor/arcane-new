import { describe, expect, it } from 'bun:test';
import { ALL_RULES, RETIRED_CODES } from './index';

// What this protects: a diagnostic code is a user-facing identifier. People
// write `#pragma warning disable UNITY0201`, and quick-fixes look up by code.
// Two rules sharing one makes both of those ambiguous — and this repo HAD that
// bug: `project-settings-literals` and five separate correctness rules all
// claimed UNITY0301 through UNITY0305, so suppressing a tag-name warning would
// also have silenced the check that catches UnityEditor APIs in a player
// build.

describe('diagnostic codes', () => {
  it('are unique across every rule', () => {
    const owners = new Map<string, string[]>();
    for (const rule of ALL_RULES) {
      for (const code of rule.codes) {
        owners.set(code, [...(owners.get(code) ?? []), rule.id]);
      }
    }
    const collisions = [...owners.entries()].filter(([, ids]) => ids.length > 1);
    expect(collisions).toEqual([]);
  });

  it('follow the UNITY#### shape', () => {
    for (const rule of ALL_RULES) {
      expect(rule.codes.length).toBeGreaterThan(0);
      for (const code of rule.codes) {
        expect(code).toMatch(/^UNITY\d{4}$/);
      }
    }
  });

  it('never borrow a prefix that belongs to someone else', () => {
    // UNT/USP are Microsoft.Unity.Analyzers, CS is the C# compiler, IDE is
    // Roslyn's code style. All three arrive in the same Problems panel, and a
    // rule here claiming one of those codes would make a finding untraceable
    // to the engine that produced it.
    for (const rule of ALL_RULES) {
      for (const code of rule.codes) {
        expect(code).not.toMatch(/^(UNT|USP|CS|IDE)/);
      }
    }
  });

  it('never reuse a retired code', () => {
    // A user may still hold a suppression comment naming one, from a version
    // where it meant something else.
    const live = new Set(ALL_RULES.flatMap((r) => r.codes));
    for (const retired of RETIRED_CODES) {
      expect(live.has(retired)).toBe(false);
    }
  });

  it('name only real UNT diagnostics as superseding them', () => {
    for (const rule of ALL_RULES) {
      for (const code of rule.supersededBy ?? []) {
        expect(code).toMatch(/^UNT\d{4}$/);
      }
    }
  });

  it('keep the hot-path rules unsuperseded', () => {
    // These are the reason the TypeScript engine still exists.
    // Microsoft.Unity.Analyzers reports what is semantically wrong for Unity;
    // it has nothing for "this is ruinous to call sixty times a second". If a
    // future edit marks one of these superseded, the editor silently stops
    // reporting the single class of problem it was best at.
    const hotPath = ALL_RULES.filter((r) =>
      ['unity/getcomponent-in-update', 'unity/camera-main-in-update', 'unity/alloc-in-update'].includes(
        r.id,
      ),
    );
    expect(hotPath).toHaveLength(3);
    for (const rule of hotPath) {
      expect(rule.supersededBy ?? []).toEqual([]);
    }
  });

  it('give every rule a stable id', () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^unity\//);
  });
});
