import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { useSearchStore } from '../../../stores/search';
import { useWorkspaceStore } from '../../../stores/workspace';
import { disposeModelForPath } from '../../editor';
import { buildExcerpts, matchStartPosition, positionWithinExcerpt } from '../services/excerpt-model';
import { hotSet } from '../services/hot-blocks';
import { SearchModelRegistry } from '../services/model-ownership';
import { openExcerptAt } from '../services/open-excerpt';
import FileExcerptBlock from './FileExcerptBlock';

export const LINE_HEIGHT = 18;
const HEADER_HEIGHT = 26;
/** Blocks kept as live Monaco editors at once: the visible set plus enough
 *  recently-visible ones that scrolling back a few rows doesn't re-mount.
 *  See `hotSet`. */
const HOT_BLOCK_CAP = 8;

interface ExcerptListProps {
  sessionId: string;
}

function ExcerptList({ sessionId }: ExcerptListProps) {
  const session = useSearchStore((s) => s.sessions[sessionId]);
  const update = useSearchStore((s) => s.update);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const scrollRef = useRef<HTMLDivElement>(null);
  // One registry per mounted results tab, tracking which file models THIS
  // tab's hydration created (vs. ones a real editor tab already owns) — see
  // `SearchModelRegistry`. `useRef` (not `useMemo`) so identity never changes
  // across renders even under strict-mode double-invoke.
  const registryRef = useRef(new SearchModelRegistry());
  // File paths currently hydrated as live Monaco editors. Keyed by path, not
  // excerpt id, because a model belongs to a file and eviction disposes at
  // that granularity — every excerpt of a hot file is hot.
  const [hot, setHot] = useState<string[]>([]);
  // Live Monaco editor instances for currently-hydrated excerpts, keyed by
  // excerpt id. `HydratedExcerpt` registers itself here on mount and clears
  // itself on unmount (Task B1) — this is what lets `openActiveExcerpt` read
  // the REAL editor cursor instead of falling back to a caret probe. Plain
  // `useRef`, not store state: this is imperative, per-mount wiring with no
  // reason to trigger a render of its own.
  const hydratedEditorsRef = useRef(new Map<string, MonacoEditorNs.IStandaloneCodeEditor>());
  const registerHydratedEditor = useCallback(
    (excerptId: string, editorInstance: MonacoEditorNs.IStandaloneCodeEditor) => {
      hydratedEditorsRef.current.set(excerptId, editorInstance);
    },
    [],
  );
  const unregisterHydratedEditor = useCallback((excerptId: string) => {
    hydratedEditorsRef.current.delete(excerptId);
  }, []);

  const blocks = useMemo(
    () =>
      (session?.results ?? []).map((file) => ({
        file,
        excerpts: buildExcerpts(file),
        collapsed: (session?.collapsedFiles ?? []).includes(file.path),
      })),
    [session?.results, session?.collapsedFiles],
  );

  // Estimated from the excerpt shape rather than a constant: blocks differ by
  // an order of magnitude in height, and measureElement corrects the rest.
  const estimateSize = useCallback(
    (index: number) => {
      const block = blocks[index];
      if (!block) return HEADER_HEIGHT;
      if (block.collapsed) return HEADER_HEIGHT;
      const lines = block.excerpts.reduce((sum, e) => sum + e.lines.length, 0);
      return HEADER_HEIGHT + lines * LINE_HEIGHT;
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

  // Recomputed every render off the virtualizer's own (already memoized by
  // the library) item list, so the hot-set effect below and the render below
  // that both see the identical set of currently-visible rows.
  const virtualItems = virtualizer.getVirtualItems();

  // Promotes newly-visible file blocks to "hot" (live Monaco editor) and
  // evicts whatever `hotSet` decides has aged out, disposing only the models
  // THIS tab's hydration created — `registry.release` returns false, and
  // this correctly skips disposal, for a path an open editor tab owns.
  useEffect(() => {
    const keys = blocks.map((block) => block.file.path);
    const { hot: nextHot, evicted } = hotSet(
      virtualItems.map((item) => item.index),
      hot,
      keys,
      HOT_BLOCK_CAP,
    );
    if (evicted.length) {
      for (const path of evicted) {
        if (registryRef.current.release(path)) disposeModelForPath(path);
      }
    }
    if (nextHot.length !== hot.length || nextHot.some((key, i) => key !== hot[i])) {
      setHot(nextHot);
    }
    // `hot` is intentionally absent: this effect writes it, and listing it
    // would re-run on its own write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualItems, blocks]);

  // Dispose every model search still owns when this list unmounts — the tab
  // is closed, or (since `EditorPanel` renders only the active tab) the user
  // just switched away from it. `[]` deps, deliberately NOT
  // `session?.activeSearchId`: `search()` bumps that at the START of a new
  // run while deliberately KEEPING the previous results (and every currently
  // hydrated editor) on screen until the first batch arrives
  // (`stores/search.ts`) — an effect keyed on it would tear down every model
  // search still owns out from under those still-mounted editors, well
  // before `blocks` (memoised on `session.results`) has any reason to
  // change, and nothing would ever remount them afterwards (same file path,
  // same excerpt id, same primitive start/end lines survive a refined query
  // unchanged, so `HydratedExcerpt`'s effect deps never invalidate). A new
  // search is not itself a reason to destroy a model a still-visible excerpt
  // is displaying. Disposal for a file the refined query actually DROPS is
  // already covered by the hot-set effect above once the batch replaces
  // `blocks` and evicts it. Never disposes a model a real editor tab owns —
  // `release` (via `releaseAll`) only returns paths search itself claimed.
  useEffect(() => {
    const registry = registryRef.current;
    return () => {
      for (const path of registry.releaseAll()) disposeModelForPath(path);
    };
  }, []);

  // Routes the first real edit to an excerpt into the same dirty/save/LSP
  // path an ordinary editor tab uses — see the design note in the task brief.
  // Fires for ANY writer of the shared Monaco model (this excerpt, a sibling
  // excerpt of the same file, or the file's own already-open tab), not just
  // the excerpt whose editor instance is reporting it — `openFiles.some(...)`
  // is what makes that safe: once the file is a tab, every subsequent event
  // (regardless of which editor produced it) just routes through the
  // existing `updateFileContent`, and `registryRef.current.transfer` /
  // `openFileInBackground` only run once, on the transition into "is a tab".
  // `[sessionId]` deps: reads nothing else from the render, so identity only
  // needs to change if the tab itself changes — and it must otherwise stay
  // stable, since `HydratedExcerpt`'s mount effect (Task 8) depends on it and
  // would otherwise remount every hot editor on unrelated re-renders.
  const onFirstEdit = useCallback((filePath: string, content: string) => {
    const workspace = useWorkspaceStore.getState();
    if (workspace.openFiles.some((f) => f.path === filePath)) {
      // Already a tab — the existing dirty/LSP path owns it.
      workspace.updateFileContent(filePath, content);
    } else {
      // The tab now owns the model and its unsaved changes, so search must
      // stop treating it as disposable.
      registryRef.current.transfer(filePath);
      workspace.openFileInBackground(filePath, content);
    }

    // Record the edit regardless of which branch above ran — the "N
    // modified" badge and `mod+s`'s `saveAllEdited` both read `editedPaths`,
    // and neither branch above touches it on its own. Idempotent insert, so
    // a sibling excerpt or the file's own already-open tab re-firing this
    // for the same path is a no-op.
    const search = useSearchStore.getState();
    const edited = search.sessions[sessionId]?.editedPaths ?? [];
    if (!edited.includes(filePath)) {
      search.update(sessionId, { editedPaths: [...edited, filePath] });
    }
  }, [sessionId]);

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

  // `openExcerptAt` is a module-level function (never re-created), so
  // handing it straight to `FileExcerptBlock`/`HydratedExcerpt` gives them an
  // even more stable identity than a `useCallback([])` wrapper would — see
  // `HydratedExcerpt`'s mount effect for why identity churn on
  // `onOpenExcerpt` matters (it would remount every hot editor).
  const openExcerpt = openExcerptAt;

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

  // `App.tsx`'s `file.save` command dispatches this when `mod+s` fires while
  // this results tab is active — there is no single active file there to
  // save, so it saves exactly the files THIS tab edited instead. The actual
  // save/clear logic lives in the store (`saveAllEdited`, `stores/search.ts`)
  // so it reads `editedPaths` fresh at the moment the event fires rather than
  // a value closed over here at registration time, and so it's directly
  // testable in the isolated store harness without a mounted component.
  // `saveAllEdited` resolves once every save has settled and never rejects
  // itself (it awaits via `Promise.allSettled`, and writes any failed path
  // back into `editedPaths` rather than throwing) — `void` here is a
  // deliberate fire-and-forget, not a swallowed error path.
  useEffect(() => {
    function onSaveAll(event: Event) {
      const detail = (event as CustomEvent<{ sessionId: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      void useSearchStore.getState().saveAllEdited(sessionId);
    }
    window.addEventListener('search-save-all', onSaveAll);
    return () => window.removeEventListener('search-save-all', onSaveAll);
  }, [sessionId]);

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

  // Shared by plain Enter and alt+enter — both open the active excerpt.
  // Per the owner's ask ("go to the file and the location where the cursor
  // was"), a HYDRATED excerpt's real Monaco cursor is a better source of
  // truth than a caret probe over static text, so prefer it when one is
  // live; otherwise fall back to the match-start position the cold render
  // uses (there is no cursor to read when nothing is mounted).
  const openActiveExcerpt = useCallback(() => {
    const activeId = session?.activeExcerptId;
    if (!activeId) return;
    const filePath = activeId.slice(0, activeId.lastIndexOf(':'));
    const block = blocks.find((b) => b.file.path === filePath);
    const excerpt = block?.excerpts.find((ex) => ex.id === activeId);
    if (!excerpt) return;

    // Only trust a hydrated editor's real cursor when it actually falls
    // inside THIS excerpt's visible range. A freshly re-hydrated editor that
    // was never clicked into (e.g. switching to a file tab and back, which
    // preserves `activeExcerptId` across a remount) defaults its cursor to
    // the model's (1,1) — usually well outside the excerpt — so blindly
    // trusting `getPosition()` would open line 1 instead of the match.
    const hydrated = hydratedEditorsRef.current.get(activeId);
    const position = hydrated?.getPosition();
    if (position && positionWithinExcerpt(excerpt, position.lineNumber)) {
      openExcerpt(filePath, position.lineNumber, position.column);
      return;
    }

    const target = matchStartPosition(excerpt);
    if (target) {
      openExcerpt(filePath, target.lineNumber, target.column);
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
      // A hydrated excerpt is a real Monaco editor living inside this
      // container, so its native keydown bubbles up here exactly like any
      // other key would. Plain Enter has no binding on a bare Monaco
      // instance (no find/suggest widget open), so nothing upstream stops
      // it — without this guard `preventDefault` below wins the race and
      // opens the file instead of letting Monaco insert the newline the
      // user just typed. Alt+Enter gets the same guard even though it isn't
      // needed for typing (it never inserts anything): Monaco DOES bind
      // Alt+Enter itself when its own find widget is open (select all
      // matches), and even when it doesn't, "open the file" while the
      // user's focus and cursor are inside a live editor is that editor's
      // call, not this container's — `openActiveExcerpt` below already
      // reads the hydrated cursor for exactly this case when focus is on
      // the container instead.
      if ((e.target as HTMLElement).closest('.search-excerpt-hydrated')) return;

      const activeId = session?.activeExcerptId;
      if (!activeId) return;

      // Enter and Alt+Enter both just open the active excerpt — one branch
      // for both, since neither has a distinct meaning here.
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openActiveExcerpt();
      }
    },
    [openActiveExcerpt, session?.activeExcerptId],
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
                Results appear as you type. Press <kbd>⏎</kbd> on a result to open it.
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
        {virtualItems.map((item) => {
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
                hotExcerptIds={
                  hot.includes(block.file.path) ? block.excerpts.map((e) => e.id) : []
                }
                registry={registryRef.current}
                onFirstEdit={onFirstEdit}
                onEditorMount={registerHydratedEditor}
                onEditorUnmount={unregisterHydratedEditor}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ExcerptList;
