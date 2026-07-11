/**
 * Pending-reveal slot for "reveal active file in explorer" (mirrors the
 * pattern in `utils/editor-navigation.ts`).
 *
 * `ExplorerPanel` is switched in/out of the sidebar by `SidebarPanel`'s
 * view-based `switch` — it is NOT always mounted. `view.revealInExplorer`
 * (App.tsx) flips `activeSidebarView` to `'explorer'` and dispatches a
 * `reveal-in-tree` DOM event in the same synchronous handler; if the
 * sidebar wasn't already showing the explorer, React hasn't mounted a
 * fresh `ExplorerPanel` (and therefore hasn't attached its event listener)
 * by the time the event fires, and the request is lost.
 *
 * Callers stash the target path here immediately before dispatching the
 * event; `ExplorerPanel` consumes it once on mount, and its own
 * `reveal-in-tree` listener also consumes it for the already-mounted case
 * (rather than trusting the event's `detail`, so both paths share one
 * source of truth and a stale slot can't leak into a later, unrelated
 * mount).
 */
let pendingRevealPath: string | null = null;

export function setPendingReveal(path: string | null): void {
  pendingRevealPath = path;
}

/** Reads and clears the pending reveal path in one step. */
export function consumePendingReveal(): string | null {
  const path = pendingRevealPath;
  pendingRevealPath = null;
  return path;
}

/**
 * Ancestor directory paths strictly between `root` and `filePath`, in
 * top-down order — e.g. `root = "/proj/Assets"`,
 * `filePath = "/proj/Assets/Scripts/Foo/Bar.cs"` returns
 * `["/proj/Assets/Scripts", "/proj/Assets/Scripts/Foo"]`.
 *
 * Returns an empty array when `filePath` sits directly under `root` (no
 * ancestor directories to open). Returns `null` when `filePath` is neither
 * `root` itself nor nested under it — the caller should bail, there is
 * nothing in this tree to reveal.
 */
export function ancestorDirs(root: string, filePath: string): string[] | null {
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  if (filePath === normalizedRoot) return [];

  const prefix = `${normalizedRoot}/`;
  if (!filePath.startsWith(prefix)) return null;

  const relative = filePath.slice(prefix.length);
  const segments = relative.split('/');
  segments.pop(); // drop the file's own name — the rest are ancestor dirs

  const dirs: string[] = [];
  let current = normalizedRoot;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    dirs.push(current);
  }
  return dirs;
}
