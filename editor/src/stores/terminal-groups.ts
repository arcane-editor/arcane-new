// Pure, framework-free terminal-group model (VS Code "tab = group of split
// panes" semantics). Zero imports — bun-testable with no DOM/Tauri mocking,
// see terminal-groups.test.ts. `stores/terminal.ts` is the sole consumer: it
// spreads `GroupsState` into the zustand store and calls these reducers
// after each backend invoke (spawn/kill) to keep the group bookkeeping in
// sync with the flat `terminals` list.
//
// Invariant maintained by every function below: whenever `activeGroupId` is
// non-null, `activeTerminalId` equals that group's `focusedId`. Terminal ids
// are assumed unique across all groups (the caller sources them from the
// backend's PTY id allocator).

export interface TerminalGroup {
  id: number;
  terminalIds: number[];
  focusedId: number;
}

export interface GroupsState {
  groups: TerminalGroup[];
  activeGroupId: number | null;
  activeTerminalId: number | null;
}

/** Find the group that owns `terminalId`, if any. */
export function groupOf(s: GroupsState, terminalId: number): TerminalGroup | undefined {
  return s.groups.find((g) => g.terminalIds.includes(terminalId));
}

/** New tab: a fresh single-pane group. Always becomes the active group. */
export function createGroup(s: GroupsState, groupId: number, terminalId: number): GroupsState {
  const group: TerminalGroup = { id: groupId, terminalIds: [terminalId], focusedId: terminalId };
  return {
    groups: [...s.groups, group],
    activeGroupId: groupId,
    activeTerminalId: terminalId,
  };
}

/**
 * Split: insert `newTerminalId` immediately to the right of
 * `sourceTerminalId` within its group, and focus it. Focusing always brings
 * the owning group to the front (mirrors `focusPane`) — in practice
 * `sourceTerminalId` is always the currently-focused pane (split acts on
 * `activeTerminalId`), so this is a same-group no-op switch in the common
 * case. No-ops if `sourceTerminalId` doesn't belong to any group.
 */
export function addPane(s: GroupsState, sourceTerminalId: number, newTerminalId: number): GroupsState {
  const group = groupOf(s, sourceTerminalId);
  if (!group) return s;

  const idx = group.terminalIds.indexOf(sourceTerminalId);
  const terminalIds = [
    ...group.terminalIds.slice(0, idx + 1),
    newTerminalId,
    ...group.terminalIds.slice(idx + 1),
  ];
  const newGroup: TerminalGroup = { ...group, terminalIds, focusedId: newTerminalId };

  return {
    groups: s.groups.map((g) => (g.id === group.id ? newGroup : g)),
    activeGroupId: group.id,
    activeTerminalId: newTerminalId,
  };
}

/**
 * Close a pane. If it's the last pane in its group, the whole group (tab)
 * closes; if that group was active, the previous group in tab order (array
 * index, clamped into range) becomes active, restoring ITS remembered
 * `focusedId` — never a fresh default. If panes remain, the removed pane's
 * LEFT neighbor (index - 1, clamped to 0) is focused, but only when the
 * removed pane was the focused one. A non-active group's removal never
 * changes the top-level actives. No-ops if `terminalId` doesn't belong to
 * any group.
 */
export function removePane(s: GroupsState, terminalId: number): GroupsState {
  const group = groupOf(s, terminalId);
  if (!group) return s;

  const idx = group.terminalIds.indexOf(terminalId);
  const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
  const wasActiveGroup = s.activeGroupId === group.id;

  if (terminalIds.length === 0) {
    const groupIdx = s.groups.findIndex((g) => g.id === group.id);
    const groups = s.groups.filter((g) => g.id !== group.id);

    if (!wasActiveGroup) {
      return { groups, activeGroupId: s.activeGroupId, activeTerminalId: s.activeTerminalId };
    }
    if (groups.length === 0) {
      return { groups, activeGroupId: null, activeTerminalId: null };
    }
    const prevIdx = Math.min(Math.max(groupIdx - 1, 0), groups.length - 1);
    const nextActive = groups[prevIdx];
    return { groups, activeGroupId: nextActive.id, activeTerminalId: nextActive.focusedId };
  }

  const focusedId =
    group.focusedId === terminalId ? terminalIds[Math.max(idx - 1, 0)] : group.focusedId;
  const newGroup: TerminalGroup = { ...group, terminalIds, focusedId };
  const groups = s.groups.map((g) => (g.id === group.id ? newGroup : g));

  return {
    groups,
    activeGroupId: s.activeGroupId,
    activeTerminalId: wasActiveGroup ? focusedId : s.activeTerminalId,
  };
}

/**
 * Bring a specific pane's group to the front and focus that pane. May
 * switch `activeGroupId` when the pane lives in a different group. No-op
 * if `terminalId` doesn't belong to any group.
 */
export function focusPane(s: GroupsState, terminalId: number): GroupsState {
  const group = groupOf(s, terminalId);
  if (!group) return s;

  const newGroup: TerminalGroup = { ...group, focusedId: terminalId };
  return {
    groups: s.groups.map((g) => (g.id === group.id ? newGroup : g)),
    activeGroupId: group.id,
    activeTerminalId: terminalId,
  };
}

/**
 * Switch tabs, restoring that group's remembered focused pane. No-op if
 * `groupId` doesn't exist.
 */
export function focusGroup(s: GroupsState, groupId: number): GroupsState {
  const group = s.groups.find((g) => g.id === groupId);
  if (!group) return s;
  return { groups: s.groups, activeGroupId: group.id, activeTerminalId: group.focusedId };
}

/**
 * Cycle focus within the active group only, wrapping at the ends. No-op
 * when there's no active group or the active group has a single pane.
 */
export function focusSibling(s: GroupsState, dir: 1 | -1): GroupsState {
  if (s.activeGroupId === null) return s;
  const group = s.groups.find((g) => g.id === s.activeGroupId);
  if (!group || group.terminalIds.length <= 1) return s;

  const idx = group.terminalIds.indexOf(group.focusedId);
  const n = group.terminalIds.length;
  const focusedId = group.terminalIds[(idx + dir + n) % n];
  const newGroup: TerminalGroup = { ...group, focusedId };

  return {
    groups: s.groups.map((g) => (g.id === group.id ? newGroup : g)),
    activeGroupId: s.activeGroupId,
    activeTerminalId: focusedId,
  };
}
