import { describe, it, expect, beforeEach } from 'bun:test';
import {
  useNavigationStore,
  sameLocation,
  JUMP_HISTORY_LIMIT,
  type NavEntry,
} from './navigation';

const at = (path: string, line: number, column = 1): NavEntry => ({ path, line, column });

describe('jump history', () => {
  beforeEach(() => {
    useNavigationStore.getState().reset();
  });

  it('records where you left and walks back to it', () => {
    const store = useNavigationStore.getState();
    store.push(at('/a.cs', 10));

    expect(useNavigationStore.getState().goBack(at('/b.cs', 3))).toEqual(at('/a.cs', 10));
    expect(useNavigationStore.getState().back).toEqual([]);
  });

  it('walks forward again to where Back was pressed from', () => {
    const store = useNavigationStore.getState();
    store.push(at('/a.cs', 10));
    useNavigationStore.getState().goBack(at('/b.cs', 3));

    expect(useNavigationStore.getState().goForward(at('/a.cs', 10))).toEqual(at('/b.cs', 3));
  });

  it('returns null rather than throwing at either end of the history', () => {
    expect(useNavigationStore.getState().goBack(at('/a.cs', 1))).toBeNull();
    expect(useNavigationStore.getState().goForward(at('/a.cs', 1))).toBeNull();
  });

  it('drops the forward tail once you navigate somewhere new', () => {
    const store = useNavigationStore.getState();
    store.push(at('/a.cs', 10));
    useNavigationStore.getState().goBack(at('/b.cs', 3));
    expect(useNavigationStore.getState().forward).toHaveLength(1);

    useNavigationStore.getState().push(at('/c.cs', 7));
    expect(useNavigationStore.getState().forward).toEqual([]);
  });

  it('ignores pushes while a Back/Forward jump is being applied', () => {
    // Without this the replayed jump records itself and Back only ever
    // toggles between two locations.
    const store = useNavigationStore.getState();
    store.setReplaying(true);
    store.push(at('/a.cs', 10));
    expect(useNavigationStore.getState().back).toEqual([]);

    useNavigationStore.getState().setReplaying(false);
    useNavigationStore.getState().push(at('/a.cs', 10));
    expect(useNavigationStore.getState().back).toHaveLength(1);
  });

  it('never records a virtual tab', () => {
    const store = useNavigationStore.getState();
    for (const path of ['search://1', 'diff://staged/x.cs', 'auth://callback']) {
      store.push(at(path, 4));
    }
    expect(useNavigationStore.getState().back).toEqual([]);
  });

  it('collapses a repeat push of the line already on top', () => {
    const store = useNavigationStore.getState();
    store.push(at('/a.cs', 10));
    useNavigationStore.getState().push(at('/a.cs', 10, 40));
    expect(useNavigationStore.getState().back).toHaveLength(1);
  });

  it('drops the oldest entries past the cap instead of growing without bound', () => {
    const store = useNavigationStore.getState();
    for (let i = 1; i <= JUMP_HISTORY_LIMIT + 10; i++) store.push(at('/a.cs', i));

    const { back } = useNavigationStore.getState();
    expect(back).toHaveLength(JUMP_HISTORY_LIMIT);
    // The most recent survives; the first ten are gone.
    expect(back[back.length - 1]).toEqual(at('/a.cs', JUMP_HISTORY_LIMIT + 10));
    expect(back[0]).toEqual(at('/a.cs', 11));
  });

  it('does not push an unrecordable current location onto the other stack', () => {
    const store = useNavigationStore.getState();
    store.push(at('/a.cs', 10));
    // Back pressed while a search tab is active: still navigates, but there is
    // nothing meaningful to come Forward to.
    useNavigationStore.getState().goBack(at('search://1', 1));
    expect(useNavigationStore.getState().forward).toEqual([]);
  });
});

describe('sameLocation', () => {
  it('ignores the column, so a jump within one line is not a new location', () => {
    expect(sameLocation(at('/a.cs', 3, 1), at('/a.cs', 3, 80))).toBe(true);
  });

  it('separates different files and different lines', () => {
    expect(sameLocation(at('/a.cs', 3), at('/b.cs', 3))).toBe(false);
    expect(sameLocation(at('/a.cs', 3), at('/a.cs', 4))).toBe(false);
  });

  it('is false when either side is missing', () => {
    expect(sameLocation(null, at('/a.cs', 3))).toBe(false);
    expect(sameLocation(at('/a.cs', 3), null)).toBe(false);
  });
});
