import { describe, it, expect } from 'bun:test';
import {
  createGroup,
  addPane,
  removePane,
  focusPane,
  focusGroup,
  focusSibling,
  groupOf,
  type GroupsState,
} from './terminal-groups';

const EMPTY: GroupsState = { groups: [], activeGroupId: null, activeTerminalId: null };

/**
 * Invariant that must hold after EVERY op (per the brief): the active
 * group's `focusedId` equals the top-level `activeTerminalId`, and terminal
 * ids are unique across all groups. Called after every mutating step below.
 */
function assertInvariant(s: GroupsState): void {
  if (s.activeGroupId !== null) {
    const active = s.groups.find((g) => g.id === s.activeGroupId);
    expect(active).toBeDefined();
    expect(active!.focusedId).toBe(s.activeTerminalId as number);
  } else {
    expect(s.activeTerminalId).toBeNull();
  }
  const allIds = s.groups.flatMap((g) => g.terminalIds);
  expect(new Set(allIds).size).toBe(allIds.length);
}

/** Cheap structural clone for plain data (no functions/dates in this model). */
function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    Object.getOwnPropertyNames(obj).forEach((key) => {
      const value = (obj as Record<string, unknown>)[key];
      if (value && typeof value === 'object') deepFreeze(value);
    });
    Object.freeze(obj);
  }
  return obj;
}

describe('terminal-groups (pure reducers)', () => {
  it('1. createGroup on empty state creates the active group with the focused pane; ids unique across groups', () => {
    const s1 = createGroup(EMPTY, 100, 1);
    assertInvariant(s1);
    expect(s1.groups).toEqual([{ id: 100, terminalIds: [1], focusedId: 1 }]);
    expect(s1.activeGroupId).toBe(100);
    expect(s1.activeTerminalId).toBe(1);

    const s2 = createGroup(s1, 200, 10);
    assertInvariant(s2);
    expect(s2.groups.map((g) => g.id)).toEqual([100, 200]);
    expect(s2.activeGroupId).toBe(200);
    expect(s2.activeTerminalId).toBe(10);

    // input untouched by the second call
    expect(s1.groups.map((g) => g.id)).toEqual([100]);
  });

  it('2. addPane inserts immediately after source (not just appended) and focuses the new pane', () => {
    let s = createGroup(EMPTY, 100, 1);
    s = addPane(s, 1, 2); // [1, 2], focused 2
    assertInvariant(s);
    expect(groupOf(s, 1)!.terminalIds).toEqual([1, 2]);
    expect(groupOf(s, 1)!.focusedId).toBe(2);
    expect(s.activeTerminalId).toBe(2);

    // Insert after the FIRST pane (not the last) — must land in the middle,
    // proving it's positional (after source) and not just appended.
    s = addPane(s, 1, 3);
    assertInvariant(s);
    expect(groupOf(s, 1)!.terminalIds).toEqual([1, 3, 2]);
    expect(s.activeTerminalId).toBe(3);
  });

  it('3. removePane of a focused MIDDLE pane focuses the LEFT neighbor', () => {
    let s = createGroup(EMPTY, 100, 1);
    s = addPane(s, 1, 2); // [1, 2] focused 2
    s = addPane(s, 1, 3); // [1, 3, 2] focused 3 (middle, index 1)
    s = removePane(s, 3);
    assertInvariant(s);
    const g = groupOf(s, 1)!;
    expect(g.terminalIds).toEqual([1, 2]);
    expect(g.focusedId).toBe(1); // left neighbor of the removed index
    expect(s.activeTerminalId).toBe(1);
  });

  it('4. removePane of focused pane 0 (with siblings) focuses the new pane 0 (clamped)', () => {
    let s = createGroup(EMPTY, 100, 1);
    s = addPane(s, 1, 2); // [1, 2] focused 2
    s = focusPane(s, 1); // focus pane 0 -> [1, 2] focused 1
    s = removePane(s, 1);
    assertInvariant(s);
    const g = groupOf(s, 2)!;
    expect(g.terminalIds).toEqual([2]);
    expect(g.focusedId).toBe(2); // index -1 clamped to 0
    expect(s.activeTerminalId).toBe(2);
  });

  it('5. removePane of the last pane in the ACTIVE group removes the group and activates the previous group in tab order with ITS remembered focusedId', () => {
    let s = createGroup(EMPTY, 100, 1); // tab 1
    s = createGroup(s, 200, 10); // tab 2, active
    s = createGroup(s, 300, 20); // tab 3, active

    // Give tab 2 (group 200) a remembered focus different from its creation
    // default, so we can prove the RESTORED value is the remembered one.
    s = addPane(s, 10, 11); // group 200: [10, 11] focused 11; active switches to 200
    s = focusPane(s, 10); // group 200 remembered focusedId becomes 10
    s = focusGroup(s, 300); // back to tab 3 as active

    s = removePane(s, 20); // group 300's only pane -> group 300 closes
    assertInvariant(s);
    expect(s.groups.map((g) => g.id)).toEqual([100, 200]);
    expect(s.activeGroupId).toBe(200); // previous group in tab order (index 2 -> 1)
    expect(s.activeTerminalId).toBe(10); // its remembered focusedId, not a fresh default
  });

  it('5b. removePane of the last pane in the FIRST group clamps the "previous group" index to 0', () => {
    let s = createGroup(EMPTY, 100, 1);
    s = createGroup(s, 200, 10);
    s = focusGroup(s, 100); // make the first group active
    s = removePane(s, 1); // its only pane -> group 100 closes while active
    assertInvariant(s);
    expect(s.groups.map((g) => g.id)).toEqual([200]);
    expect(s.activeGroupId).toBe(200);
    expect(s.activeTerminalId).toBe(10);
  });

  it('6. removePane in a NON-active group leaves the top-level actives untouched (even removing that group\'s own focused pane)', () => {
    let s = createGroup(EMPTY, 100, 1);
    s = addPane(s, 1, 2); // group 100: [1, 2] focused 2, active = 100
    s = createGroup(s, 200, 10); // active switches to 200; group 100 now inactive

    s = removePane(s, 2); // removes group 100's OWN focused pane, but group 100 isn't active
    assertInvariant(s);
    const g = groupOf(s, 1)!;
    expect(g.terminalIds).toEqual([1]);
    expect(g.focusedId).toBe(1); // recomputed internally regardless of active-ness
    // top-level actives are completely untouched
    expect(s.activeGroupId).toBe(200);
    expect(s.activeTerminalId).toBe(10);
  });

  it('7. removing the very last pane overall empties groups and nulls both actives', () => {
    let s = createGroup(EMPTY, 100, 1);
    s = removePane(s, 1);
    assertInvariant(s);
    expect(s.groups).toEqual([]);
    expect(s.activeGroupId).toBeNull();
    expect(s.activeTerminalId).toBeNull();
  });

  it('8. focusSibling wraps within the active group only; a single-pane group is a no-op (identity)', () => {
    const single = createGroup(EMPTY, 100, 1);
    const identity = focusSibling(single, 1);
    assertInvariant(identity);
    expect(identity).toBe(single); // strict identity, not just deep-equal

    let s = createGroup(EMPTY, 100, 1);
    s = addPane(s, 1, 2); // [1, 2] focused 2
    s = addPane(s, 2, 3); // [1, 2, 3] focused 3

    const next = focusSibling(s, 1); // wraps 2 -> 0
    assertInvariant(next);
    expect(groupOf(next, 1)!.focusedId).toBe(1);
    expect(next.activeTerminalId).toBe(1);

    const prev = focusSibling(s, -1); // 2 -> 1
    assertInvariant(prev);
    expect(groupOf(prev, 2)!.focusedId).toBe(2);
    expect(prev.activeTerminalId).toBe(2);

    // A second group's panes are never touched by sibling-cycling the active one.
    let s2 = createGroup(s, 200, 10);
    s2 = addPane(s2, 10, 11); // group 200 active, [10, 11] focused 11
    s2 = focusGroup(s2, 100); // back to group 100 as active
    const cycled = focusSibling(s2, 1);
    expect(groupOf(cycled, 10)!.focusedId).toBe(11); // untouched
  });

  it('9. focusPane on another group\'s pane switches activeGroupId and updates that group\'s focusedId', () => {
    let s = createGroup(EMPTY, 100, 1);
    s = createGroup(s, 200, 10); // active = 200
    s = addPane(s, 10, 11); // group 200: [10, 11] focused 11, active = 200

    s = focusPane(s, 1); // pane in the (currently inactive) group 100
    assertInvariant(s);
    expect(s.activeGroupId).toBe(100);
    expect(s.activeTerminalId).toBe(1);
    expect(groupOf(s, 1)!.focusedId).toBe(1);
    // group 200's own focus is untouched by switching away from it
    expect(groupOf(s, 10)!.focusedId).toBe(11);
  });

  it('10. all ops are immutable — a frozen input state is never mutated by any reducer', () => {
    let s = createGroup(EMPTY, 100, 1);
    s = addPane(s, 1, 2);
    s = addPane(s, 1, 3);
    s = createGroup(s, 200, 10);

    const snapshot = clone(s);
    const frozen = deepFreeze(clone(s));

    expect(() => addPane(frozen, 3, 4)).not.toThrow();
    expect(() => removePane(frozen, 2)).not.toThrow();
    expect(() => focusPane(frozen, 1)).not.toThrow();
    expect(() => focusGroup(frozen, 100)).not.toThrow();
    expect(() => focusSibling(frozen, 1)).not.toThrow();
    expect(() => focusSibling(frozen, -1)).not.toThrow();
    expect(() => createGroup(frozen, 999, 50)).not.toThrow();
    expect(() => removePane(frozen, 10)).not.toThrow(); // last-pane-of-group path
    expect(() => groupOf(frozen, 1)).not.toThrow();

    // The frozen object must be byte-for-byte the same as before any of the
    // above calls ran — none of them may have mutated it in place.
    expect(frozen).toEqual(snapshot);
  });
});
