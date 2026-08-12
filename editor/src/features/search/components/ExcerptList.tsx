import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { buildExcerpts, applyExpansion } from '../services/excerpt-model';
import { readFileLines } from '../services/file-lines';
import FileExcerptBlock from './FileExcerptBlock';

const LINE_HEIGHT = 18;
const HEADER_HEIGHT = 26;
const EXPANDER_HEIGHT = 12;
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

  // The outline panel (sidebar) dispatches this to scroll the tab to an
  // excerpt the user clicked there. `onFocusExcerpt` (above) is the reverse
  // direction: it writes `activeExcerptId`, which the outline reads back to
  // style the matching row — so this listener only needs to handle scroll.
  useEffect(() => {
    function onReveal(event: Event) {
      const detail = (event as CustomEvent<{ sessionId: string; excerptId: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      const filePath = detail.excerptId.slice(0, detail.excerptId.lastIndexOf(':'));
      const index = blocks.findIndex((b) => b.file.path === filePath);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
    }
    window.addEventListener('search-reveal-excerpt', onReveal);
    return () => window.removeEventListener('search-reveal-excerpt', onReveal);
  }, [blocks, sessionId, virtualizer]);

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
  const didRevealOnMount = useRef(false);
  useEffect(() => {
    if (didRevealOnMount.current) return;
    didRevealOnMount.current = true;
    const activeId = session?.activeExcerptId;
    if (!activeId) return;
    const filePath = activeId.slice(0, activeId.lastIndexOf(':'));
    const index = blocks.findIndex((b) => b.file.path === filePath);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'center' });
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
      const lines = fileLines[filePath] ?? (await readFileLines(filePath));
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

      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
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
        return;
      }

      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        void expand(activeId, 'down');
      }
    },
    [blocks, expand, openExcerpt, session?.activeExcerptId],
  );

  if (!session) return null;

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
