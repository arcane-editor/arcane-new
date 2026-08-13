import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { buildExcerpts, applyExpansion } from '../services/excerpt-model';
import { readFileLines } from '../services/file-lines';
import FileExcerptBlock from './FileExcerptBlock';

const LINE_HEIGHT = 18;
const HEADER_HEIGHT = 26;
const EXPANDER_HEIGHT = 10;
/** Real lines revealed per ⌃/⌄ click. */
const EXPAND_STEP = 5;

interface ExcerptListProps {
  sessionId: string;
}

function ExcerptList({ sessionId }: ExcerptListProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  const update = useSearchStore((s) => s.update);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [fileLines, setFileLines] = useState<Record<string, string[]>>({});

  // This component-local cache shadows the module-level one `search()`
  // clears via `clearFileLineCache()` (stores/search.ts) — that call alone
  // does NOT reach here, so without this effect an excerpt expanded before a
  // re-search (or a tab switch) would keep rendering the pre-edit/pre-switch
  // lines forever (Fix round 1, Finding 1). `session?.activeSearchId` only
  // changes at the instant a NEW search actually starts (`search()` sets it
  // once, synchronously, before the invoke) — not per streamed batch, not
  // per expand click — so this cannot fire mid-expansion of the search
  // currently on screen. `sessionId` is included too so switching to a
  // DIFFERENT tab also drops the cache, even in the edge case where neither
  // session has searched yet and both have `activeSearchId: null`.
  useEffect(() => {
    setFileLines({});
  }, [sessionId, session?.activeSearchId]);

  const blocks = useMemo(
    () =>
      (session?.results ?? []).map((file) => ({
        file,
        excerpts: buildExcerpts(file).map((excerpt) => {
          const expansion = session?.expanded[excerpt.id];
          const lines = fileLines[file.path];
          return expansion && lines ? applyExpansion(excerpt, lines, expansion) : excerpt;
        }),
        collapsed: (session?.collapsedFiles ?? []).includes(file.path),
      })),
    [session?.results, session?.collapsedFiles, fileLines, session?.expanded],
  );

  // Estimated from the excerpt shape rather than a constant: blocks differ by
  // an order of magnitude in height, and measureElement corrects the rest.
  const estimateSize = useCallback(
    (index: number) => {
      const block = blocks[index];
      if (!block) return HEADER_HEIGHT;
      if (block.collapsed) return HEADER_HEIGHT;
      const lines = block.excerpts.reduce((sum, e) => sum + e.lines.length, 0);
      return HEADER_HEIGHT + lines * LINE_HEIGHT + block.excerpts.length * EXPANDER_HEIGHT * 2;
    },
    [blocks],
  );

  // Keyed on the block's file path, not the default (index): `search()`
  // REPLACES `results` wholesale on a new query's first batch, so index 0
  // goes from one file to a completely different one between queries. The
  // virtualizer's measurement cache is keyed by whatever getItemKey returns
  // (index by default), so an index-keyed cache would serve the PREVIOUS
  // query's measured height for every off-screen row at that index until it
  // happens to scroll into view and get remeasured.
  const getItemKey = useCallback(
    (index: number) => blocks[index]?.file.path ?? index,
    [blocks],
  );

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: 4,
  });

  const toggleCollapse = useCallback(
    (filePath: string) => {
      const current = session?.collapsedFiles ?? [];
      update(sessionId, {
        collapsedFiles: current.includes(filePath)
          ? current.filter((p) => p !== filePath)
          : [...current, filePath],
      });
    },
    [session?.collapsedFiles, sessionId, update],
  );

  const openExcerpt = useCallback(async (filePath: string, lineNumber: number, column: number) => {
    const fileName = filePath.split('/').pop() || '';
    await useWorkspaceStore.getState().openFile(filePath, fileName);
    window.dispatchEvent(
      new CustomEvent('navigate-to-line', { detail: { line: lineNumber, column } }),
    );
  }, []);

  const focusExcerpt = useCallback(
    (excerptId: string) => update(sessionId, { activeExcerptId: excerptId }),
    [sessionId, update],
  );

  // Scrolls the already-mounted (or just-scrolled-to) block for `excerptId`'s
  // file until that exact excerpt is in view. The virtualizer only knows how
  // to scroll to a block INDEX (one file = one virtualized row), not to a
  // sub-element inside one, so this is a second, DOM-level pass on top of it:
  // it waits a couple of frames for `scrollToIndex`'s own scroll (and any
  // collapse-state re-render growing the block) to land, then finds the
  // element `FileExcerptBlock` tags with `data-excerpt-id` and centers it.
  // Silently no-ops if the element still isn't there (e.g. the file scrolled
  // past overscan) — the file-level scroll from `scrollToIndex` already put
  // the user in the right neighbourhood.
  //
  // `excerptId` is `${filePath}:${startLine}` — a real filesystem path, not
  // a token this code controls — so it's run through `CSS.escape` before
  // being interpolated into the attribute selector (M2, final re-review): an
  // unescaped double quote in the path would throw inside this rAF, and a
  // literal backslash (any Windows path) would silently fail to match,
  // degrading to the file-level `scrollToIndex` above with no sign why.
  const scrollToExcerptElement = useCallback((excerptId: string) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(
          `[data-excerpt-id="${CSS.escape(excerptId)}"]`,
        );
        el?.scrollIntoView({ block: 'center' });
      });
    });
  }, []);

  // The outline panel (sidebar) dispatches this to scroll the tab to an
  // excerpt the user clicked there. `onFocusExcerpt` (above) is the reverse
  // direction: it writes `activeExcerptId`, which the outline reads back to
  // style the matching row — so this listener only needs to handle scroll.
  useEffect(() => {
    function onReveal(event: Event) {
      const detail = (event as CustomEvent<{ sessionId: string; excerptId: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      const filePath = detail.excerptId.slice(0, detail.excerptId.lastIndexOf(':'));
      // A collapsed file's block renders only its header — scrolling to it
      // would land on a header with nothing highlighted underneath, reading
      // as broken outline sync. Un-collapse it as part of the reveal.
      const collapsedFiles = session?.collapsedFiles ?? [];
      if (collapsedFiles.includes(filePath)) {
        update(sessionId, { collapsedFiles: collapsedFiles.filter((p) => p !== filePath) });
      }
      const index = blocks.findIndex((b) => b.file.path === filePath);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
      scrollToExcerptElement(detail.excerptId);
    }
    window.addEventListener('search-reveal-excerpt', onReveal);
    return () => window.removeEventListener('search-reveal-excerpt', onReveal);
  }, [blocks, scrollToExcerptElement, session?.collapsedFiles, sessionId, update, virtualizer]);

  // Belt-and-suspenders for the listener above: when the outline panel
  // reveals an excerpt in a tab that ISN'T the active editor tab yet, that
  // reveal has to activate the tab first — which mounts this component for
  // the FIRST time on a later render. `SearchOutlinePanel.reveal()` uses
  // `flushSync` around the activation so the 'search-reveal-excerpt' listener
  // above is registered before the event dispatches, but `activeExcerptId` is
  // already sitting in the store (set synchronously, before activation) even
  // if that ordering were ever wrong for some other caller — so on mount,
  // reconcile the scroll position with whatever excerpt is already marked
  // active. Runs once per mount (not on every `activeExcerptId` change, which
  // would re-center the view on every ordinary click inside an already-open
  // tab, fighting the user's own scrolling).
  //
  // Deliberately does NOT un-collapse the target file, unlike the listener
  // above (M1, final re-review): this path also fires on an ORDINARY remount
  // — switching to a file tab and back — because A3 preserves
  // `activeExcerptId` across it. Before A3, a remount always re-searched and
  // wiped `activeExcerptId`, so this branch could only ever fire right after
  // a genuine cross-tab reveal, when un-collapsing was exactly what was
  // wanted. Now it fires on every ordinary remount too, and unconditionally
  // un-collapsing here would silently re-expand a file the user deliberately
  // collapsed after clicking an excerpt inside it. Scrolling to the
  // (possibly collapsed) file block is still correct either way; only the
  // sub-element scroll silently no-ops if the file is collapsed and the
  // excerpt isn't actually rendered.
  const didRevealOnMount = useRef(false);
  useEffect(() => {
    if (didRevealOnMount.current) return;
    didRevealOnMount.current = true;
    const activeId = session?.activeExcerptId;
    if (!activeId) return;
    const filePath = activeId.slice(0, activeId.lastIndexOf(':'));
    const index = blocks.findIndex((b) => b.file.path === filePath);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
    scrollToExcerptElement(activeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only, see comment above
  }, [blocks, session?.activeExcerptId, virtualizer]);

  // Excerpt ids are `${filePath}:${startLine}`; `lastIndexOf(':')` finds the
  // right split regardless of how many colons the path itself contains — a
  // Windows drive letter (`D:/...`), a UNC/NTFS alternate-data-stream colon,
  // or even a literal `:` in a POSIX filename. `startLine` is always
  // digits-only, so the colon `excerptId` appends is always the RIGHTMOST
  // colon in the string, no matter what came before it.
  const expand = useCallback(
    async (excerptId: string, direction: 'up' | 'down') => {
      const filePath = excerptId.slice(0, excerptId.lastIndexOf(':'));
      // Snapshot taken from the LIVE store, not from the `session` variable
      // closed over by this callback: `useCallback`'s deps below don't list
      // `activeSearchId`, and at least one store transition (`clearResults`)
      // changes `activeSearchId` without touching `expanded` — the one dep
      // that IS listed — so a closure that hasn't been recreated could read a
      // `session.activeSearchId` that was already stale before this function
      // even started. `useSearchStore.getState()` sidesteps that: it reflects
      // the actual current store regardless of which render created this
      // closure.
      const searchIdAtRequest = useSearchStore.getState().sessions[sessionId]?.activeSearchId;
      const lines = fileLines[filePath] ?? (await readFileLines(filePath));
      // If a NEW search started (or the session was cleared) while
      // `readFileLines` was in flight, the reset effect above already wiped
      // `fileLines` for this reason. `lines` here was read against content as
      // of the PREVIOUS search's file-line cache and must not repopulate
      // `fileLines[filePath]` after that wipe: if the new results reuse this
      // same file path, the NEXT `expand()` call would see a truthy
      // `fileLines[filePath]`, skip `readFileLines` entirely, and silently
      // serve stale content — the original staleness bug reopened through
      // this narrower window. Bailing out of the whole call (not just the
      // cache write) also skips the `expanded` patch below: the `excerptId`
      // this call was for almost certainly doesn't exist in the new result
      // set, and even in the coincidental case it does (same file, same
      // start line, different match), applying an "already expanded" flag
      // with no matching `fileLines` entry to back it would just leave a
      // silently inert entry until the user re-triggers expand — better to
      // discard the stale request outright.
      if (useSearchStore.getState().sessions[sessionId]?.activeSearchId !== searchIdAtRequest) {
        return;
      }
      setFileLines((prev) => (prev[filePath] ? prev : { ...prev, [filePath]: lines }));

      const current = session?.expanded[excerptId] ?? { up: 0, down: 0 };
      update(sessionId, {
        expanded: {
          ...(session?.expanded ?? {}),
          [excerptId]: {
            up: current.up + (direction === 'up' ? EXPAND_STEP : 0),
            down: current.down + (direction === 'down' ? EXPAND_STEP : 0),
          },
        },
      });
    },
    [fileLines, session?.expanded, sessionId, update],
  );

  // Shared by plain Enter and alt+enter — both open the active excerpt at its
  // match start; there is no click point for either path.
  const openActiveExcerpt = useCallback(() => {
    const activeId = session?.activeExcerptId;
    if (!activeId) return;
    const filePath = activeId.slice(0, activeId.lastIndexOf(':'));
    const block = blocks.find((b) => b.file.path === filePath);
    const excerpt = block?.excerpts.find((ex) => ex.id === activeId);
    const line = excerpt?.lines.find((l) => l.matches.length > 0);
    // Column mirrors the double-click handler in FileExcerptBlock:
    // `lineStart + match.start`, not `match.start` alone — a long line is
    // preview-trimmed around its match, so `match.start` by itself is an
    // offset into the TRIMMED text this row renders, not the real file line.
    if (line) {
      openExcerpt(filePath, line.lineNumber, line.lineStart + (line.matches[0]?.start ?? 0) + 1);
    }
  }, [blocks, openExcerpt, session?.activeExcerptId]);

  // These act on the active excerpt, so they belong to the tab rather than
  // the global command registry — a document-level hotkey would fire while
  // the user is typing in the query input above. Never `stopPropagation`
  // here: React listens on `#root`, below the `document` listener
  // react-hotkeys-hook uses, so doing that would kill every app hotkey for
  // as long as this container holds focus.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const activeId = session?.activeExcerptId;
      if (!activeId) return;

      if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openActiveExcerpt();
        return;
      }

      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
        openActiveExcerpt();
        return;
      }

      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        void expand(activeId, 'down');
      }
    },
    [expand, openActiveExcerpt, session?.activeExcerptId],
  );

  if (!session) return null;

  // An empty results list is two different situations, and a blank tab reads
  // as broken in both. Distinguish "nothing typed yet" from "searched, no
  // hits" — the store only assigns an activeSearchId once a search has run.
  if (blocks.length === 0 && !session.isSearching) {
    const searched = session.activeSearchId !== null;
    return (
      <div className="search-tab-body" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
        <div className="search-empty">
          {searched && session.query ? (
            <>
              <p className="search-empty-title">No matches for “{session.query}”</p>
              <p className="search-empty-hint">
                Try a different term, or widen the search with the ignored-files and path filters.
              </p>
            </>
          ) : (
            <>
              <p className="search-empty-title">Search across every file in this project</p>
              <p className="search-empty-hint">
                Results appear as you type. Press <kbd>⇧⏎</kbd> on a result for more context,
                or <kbd>⌥⏎</kbd> to open it.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="search-tab-body" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const block = blocks[item.index];
          if (!block) return null;
          const relativePath = workspacePath
            ? block.file.path.replace(workspacePath + '/', '')
            : block.file.path;
          return (
            <div
              key={block.file.path}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
              }}
            >
              <FileExcerptBlock
                filePath={block.file.path}
                relativePath={relativePath}
                excerpts={block.excerpts}
                matchCount={block.file.matches.length}
                collapsed={block.collapsed}
                activeExcerptId={session.activeExcerptId}
                onToggleCollapse={toggleCollapse}
                onOpenExcerpt={openExcerpt}
                onFocusExcerpt={focusExcerpt}
                onExpand={expand}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ExcerptList;
