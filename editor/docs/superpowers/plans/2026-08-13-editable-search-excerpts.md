# Editable Search Excerpts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the search results tab's read-only excerpts into real Monaco editors over each file's own model, and fix three defects raised against Phase 1 (non-Zed-like expand bars, missing open-at-position, unfiltered Unity noise).

**Architecture:** Each visible file block hydrates into a real Monaco editor bound to the file's model with `setHiddenAreas` revealing only the excerpt ranges; blocks outside the viewport keep today's HTML render at identical height. Editing routes through the existing `openFiles` machinery — the first keystroke opens the file as a background tab — rather than building a parallel buffer layer, because dirty state, saving, LSP sync and watcher protection are all keyed to `openFiles`.

**Tech Stack:** React 19, TypeScript, Zustand, Monaco 0.55.1 (`monaco.editor.create` directly, not `@monaco-editor/react`), `@tanstack/react-virtual`, Tauri v2, bun test.

**Spec:** `docs/superpowers/specs/2026-08-13-editable-search-excerpts-design.md`

## Global Constraints

- **Deep modules.** Import a feature only through its `index.ts` barrel from outside that feature. `bun run check:modules` enforces it.
- **Monaco access.** Never `import * as monaco from 'monaco-editor'` in the search feature — a static value import re-opens an unmocked module-eval path through the search barrel and crashes `bun run test:isolated`. Use `getMonacoInstance()` from `src/utils/monaco-instance.ts`, which returns the namespace or `null`.
- **Model URIs.** Always `fileUri(path)` from `features/lsp`, never a hand-built `file://` string. On Windows the latter parses the drive letter as the URI authority, so the model URI never matches what the language server was told at `didOpen`.
- **Model ownership** (from the spec, verbatim): a tab-owned model is disposed by the tab; a search-owned model is disposed on LRU eviction, on a new search, and on search-tab close; the first edit transfers ownership to the tab that first-edit opens. A search-owned model is always safe to dispose because it has no unsaved changes by construction.
- **`mod+s` changes meaning only while a results tab is active**, and saves only files that results tab actually edited.
- **CSS tokens.** Real tokens only — `--bg-sidebar`, `--surface-container-high`, `--bg-input`, `--border`, `--ghost-border`, `--accent`, `--hover`, `--selected`, `--hover-overlay`, `--text-primary`, `--text-secondary`, `--focus-ring`, `--error-text`, `--font-mono`. No raw colour literals, no invented tokens. `theme-contract.test.ts` enforces this.
- **No `stopPropagation` in a React key handler** — React listens on `#root`, below the `document` listener `react-hotkeys-hook` uses.
- **Test style:** `import { describe, it, expect } from 'bun:test';`, `*.test.ts` beside the module. No RTL in this repo; component-inline logic cannot be tested, so keep logic in pure services.
- **`bun run verify` must pass before any task is done** — tsc, check:modules, check:invoke, `bun test src`, `test:isolated`, `cargo test --lib`, `verify:intellisense`. A `SKIPPED` intellisense result is a skip, never a pass.
- **Do not launch the app.** The project owner performs all visual verification. Never substitute a Vite server or a type-check and describe it as verification of rendering.
- **Commit after every task.**

---

### Task 1: `unityNoiseExcludes` — the blocklist

**Files:**
- Create: `src/features/search/services/unity-scope.ts`
- Create: `src/features/search/services/unity-scope.test.ts`
- Modify: `src/features/search/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `unityNoiseExcludes(): string[]`, `UNITY_NOISE_EXTENSIONS: readonly string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/features/search/services/unity-scope.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { unityNoiseExcludes, UNITY_NOISE_EXTENSIONS } from './unity-scope';

describe('unityNoiseExcludes', () => {
  it('excludes .meta sidecars', () => {
    expect(unityNoiseExcludes()).toContain('**/*.meta');
  });

  it('excludes every YAML asset extension', () => {
    const globs = unityNoiseExcludes();
    for (const ext of UNITY_NOISE_EXTENSIONS) {
      expect(globs).toContain(`**/*.${ext}`);
    }
  });

  it('produces one glob per extension and nothing else', () => {
    expect(unityNoiseExcludes()).toHaveLength(UNITY_NOISE_EXTENSIONS.length);
  });

  it('does NOT exclude source files a Unity programmer searches', () => {
    const globs = unityNoiseExcludes();
    for (const ext of ['cs', 'shader', 'hlsl', 'cginc', 'compute', 'asmdef', 'asmref', 'uxml', 'uss', 'json', 'inputactions', 'md']) {
      expect(globs).not.toContain(`**/*.${ext}`);
    }
  });

  it('returns a fresh array so a caller cannot mutate the shared list', () => {
    const a = unityNoiseExcludes();
    a.push('**/*.cs');
    expect(unityNoiseExcludes()).not.toContain('**/*.cs');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/features/search/services/unity-scope.test.ts`
Expected: FAIL — cannot resolve `./unity-scope`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/unity-scope.ts`:

```ts
// Which files a Unity PROGRAMMER is not searching for.
//
// A blocklist, deliberately, not an allowlist. An earlier version of this
// feature sent `fileExtensions: ['cs']` for Unity projects, which made
// shaders, .asmdef, .uxml and every YAML asset unsearchable — and because the
// backend ANDs fileExtensions with the include glob, no include pattern could
// widen it back. A blocklist composes with the user's own patterns and leaves
// unknown file types searchable, including ones Unity has not invented yet.
//
// The list is short because the search root for a Unity project is already
// `assetsRootPath`: Library/, Temp/, obj/, *.csproj and *.sln sit outside it
// and were never being searched.

/** Unity's YAML asset formats, plus the .meta sidecar every asset carries.
 *  All are text, so the backend's binary detection does not skip them — they
 *  match a plain-text query and bury real code hits. */
export const UNITY_NOISE_EXTENSIONS = [
  'meta',
  'unity',
  'prefab',
  'asset',
  'mat',
  'anim',
  'controller',
  'overrideController',
  'playable',
  'mixer',
  'preset',
  'terrainlayer',
  'spriteatlas',
  'guiskin',
  'fontsettings',
  'physicMaterial',
  'physicsMaterial2D',
] as const;

/** Exclude globs for the above, in the form the backend's globset expects
 *  (matched against a path relative to the search root). A fresh array per
 *  call — these are appended to a caller's own exclude list. */
export function unityNoiseExcludes(): string[] {
  return UNITY_NOISE_EXTENSIONS.map((ext) => `**/*.${ext}`);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test src/features/search/services/unity-scope.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Export from the barrel**

Add to `src/features/search/index.ts`:

```ts
export { unityNoiseExcludes, UNITY_NOISE_EXTENSIONS } from './services/unity-scope';
```

- [ ] **Step 6: Verify and commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add src/features/search
git commit -m "feat(search): add the Unity noise blocklist"
```

---

### Task 2: Wire the blocklist and its toggle

**Files:**
- Modify: `src/features/search/services/search-session.ts`
- Modify: `src/features/search/services/search-model.ts` (`SearchSignatureInput`, `searchSignature`)
- Modify: `src/features/search/services/search-model.test.ts`
- Modify: `src/stores/search.ts`
- Modify: `src/features/search/components/SearchQueryBar.tsx`

**Interfaces:**
- Consumes: `unityNoiseExcludes()` (Task 1).
- Produces: `SearchSession.includeUnityAssets: boolean` (default `false`); `SearchSignatureInput.includeUnityAssets: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `src/features/search/services/search-model.test.ts`, inside the existing `searchSignature` describe block:

```ts
  it('changes when includeUnityAssets flips, so the toggle re-runs the search', () => {
    const base = {
      query: 'foo',
      isRegex: false,
      caseSensitive: false,
      wholeWord: false,
      includeIgnored: false,
      includePattern: '',
      excludePattern: '',
      useSmartcase: true,
      contextLines: 2,
      includeUnityAssets: false,
    };
    expect(searchSignature(base)).not.toBe(
      searchSignature({ ...base, includeUnityAssets: true }),
    );
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/features/search/services/search-model.test.ts`
Expected: FAIL — tsc/bun rejects the unknown `includeUnityAssets` property, or both calls return the same string.

- [ ] **Step 3: Add the field to the signature**

In `src/features/search/services/search-model.ts`, add to `SearchSignatureInput`:

```ts
  /** Whether Unity's YAML assets and .meta files are in scope. Included here
   *  because `search()` folds it into the exclude list on every call, exactly
   *  like the other scope options. */
  includeUnityAssets: boolean;
```

and add `input.includeUnityAssets,` to the array in `searchSignature`, immediately after `input.includeIgnored,`.

- [ ] **Step 4: Add the session field**

In `src/features/search/services/search-session.ts`, add to `SearchOptionsState`:

```ts
  /** Search Unity's YAML assets (.unity/.prefab/.asset/…) and .meta sidecars.
   *  Off by default: in a Unity project they bury code hits under walls of
   *  serialized YAML. Only consulted for Unity projects. */
  includeUnityAssets: boolean;
```

and `includeUnityAssets: false,` to the object returned by `createSession`.

- [ ] **Step 5: Run and watch it pass**

Run: `bun test src/features/search/services/search-model.test.ts`
Expected: PASS.

- [ ] **Step 6: Append the blocklist in the store**

In `src/stores/search.ts`'s `search` action, the payload currently builds `excludePatterns` from the user's field alone. Replace that line with a computed list, and add `includeUnityAssets` to the signature stamped on the session. `isUnity` is already read a few lines above as `useProjectContextStore.getState().isUnityProject`.

```ts
      // Unity's YAML assets and .meta sidecars are excluded unless the tab
      // asks for them. Appended to the user's own excludes rather than sent as
      // `fileExtensions`, which the backend ANDs with the include glob — that
      // form cannot be widened by any pattern the user types.
      const excludePatterns = [
        ...parseGlobList(session.excludePattern),
        ...(isUnity && !session.includeUnityAssets ? unityNoiseExcludes() : []),
      ];
```

Pass `excludePatterns` in the invoke payload in place of the inline `parseGlobList(session.excludePattern)`, and import `unityNoiseExcludes` from `'../features/search'` (barrel, not a deep path).

Then add `includeUnityAssets: session.includeUnityAssets,` to the `searchSignature({...})` call in the same action.

- [ ] **Step 7: Add the toggle to the query bar**

In `src/features/search/components/SearchQueryBar.tsx`, widen the `toggle` helper's key union to include `'includeUnityAssets'`, add `includeUnityAssets` to the `searchSignature({...})` call in the auto-search effect and to that effect's dependency array (`session?.includeUnityAssets`), and add the button immediately after the ignored-files button:

```tsx
            <button
              type="button"
              className={`search-toggle-btn${session.includeUnityAssets ? ' active' : ''}`}
              title="Search scenes, prefabs and .meta files"
              aria-pressed={session.includeUnityAssets}
              aria-label="Search Unity assets"
              onClick={() => toggle('includeUnityAssets')}
            >
              <Boxes size={13} />
            </button>
```

Add `Boxes` to the `lucide-react` import.

- [ ] **Step 8: Verify and commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add src/features/search src/stores/search.ts
git commit -m "feat(search): filter Unity asset noise, with a toggle to include it"
```

---

### Task 3: Expansion moves to the divider

**Files:**
- Modify: `src/features/search/components/FileExcerptBlock.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `onExpand(excerptId, 'up' | 'down')` (unchanged from Phase 1).
- Produces: no new exports; the `.search-excerpt-expand` button is replaced by `.search-excerpt-divider`.

- [ ] **Step 1: Replace the always-visible bars**

In `FileExcerptBlock.tsx`, the excerpt currently renders a full-width `<button className="search-excerpt-expand">` above its lines and another below. Replace both with divider-hosted controls that stay invisible until the excerpt is hovered or the control is focused:

```tsx
            <button
              type="button"
              className="search-excerpt-divider search-excerpt-divider-top"
              title="Expand context above"
              aria-label="Expand context above"
              onClick={() => onExpand(excerpt.id, 'up')}
            >
              <ChevronUp size={12} aria-hidden="true" />
            </button>
```

and, after the lines:

```tsx
            <button
              type="button"
              className="search-excerpt-divider search-excerpt-divider-bottom"
              title="Expand context below (Shift+Enter)"
              aria-label="Expand context below"
              onClick={() => onExpand(excerpt.id, 'down')}
            >
              <ChevronDown size={12} aria-hidden="true" />
            </button>
```

`ChevronUp` and `ChevronDown` come from `lucide-react`; `ChevronDown` is already imported for the file header.

- [ ] **Step 2: Style them as dividers**

In `src/App.css`, replace the `.search-excerpt-expand` rule with:

```css
/* Expansion lives on the boundary between excerpts, revealed on hover — a
   permanently visible control above AND below every excerpt added two rows of
   chrome per excerpt and buried the code the tab exists to show. */
.search-excerpt-divider {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 10px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease, background-color 120ms ease;
}

.search-excerpt:hover .search-excerpt-divider,
.search-excerpt-divider:focus-visible {
  opacity: 1;
}

.search-excerpt-divider:hover {
  background: var(--hover-overlay);
  color: var(--text-primary);
}

.search-excerpt-divider:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: -2px;
}
```

- [ ] **Step 3: Keep the height arithmetic honest**

`ExcerptList.tsx`'s `estimateSize` adds `EXPANDER_HEIGHT * 2` per excerpt, where `EXPANDER_HEIGHT` is 12. The dividers are 10px and always occupy their row (only their opacity changes, so layout is unaffected by hover). Change `EXPANDER_HEIGHT` to `10` and leave the formula otherwise intact.

- [ ] **Step 4: Verify and commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add src/features/search/components/FileExcerptBlock.tsx src/features/search/components/ExcerptList.tsx src/App.css
git commit -m "feat(search): move excerpt expansion onto the divider"
```

---

### Task 4: Caret offset from a click point

The pure half of open-at-position: turning "which text node, at which offset" into a column. The DOM call that produces those inputs is thin and stays untested; this is the part that can be.

**Files:**
- Create: `src/features/search/services/caret-offset.ts`
- Create: `src/features/search/services/caret-offset.test.ts`
- Modify: `src/features/search/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `offsetWithinLine(texts: string[], nodeIndex: number, nodeOffset: number): number`, `columnFor(lineStart: number, offset: number): number`.

- [ ] **Step 1: Write the failing test**

Create `src/features/search/services/caret-offset.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { offsetWithinLine, columnFor } from './caret-offset';

describe('offsetWithinLine', () => {
  // A result line renders as several text nodes: plain spans, <mark> for each
  // match, and Monaco's token spans on colourized context lines.
  const nodes = ['const ', 'transform', '.position'];

  it('sums the lengths of every node before the hit node', () => {
    expect(offsetWithinLine(nodes, 1, 4)).toBe(10);
  });

  it('returns the raw offset when the hit is in the first node', () => {
    expect(offsetWithinLine(nodes, 0, 3)).toBe(3);
  });

  it('handles a hit at the very start', () => {
    expect(offsetWithinLine(nodes, 0, 0)).toBe(0);
  });

  it('handles a hit at the end of the last node', () => {
    expect(offsetWithinLine(nodes, 2, 9)).toBe(24);
  });

  it('clamps a node index past the end rather than returning NaN', () => {
    expect(offsetWithinLine(nodes, 99, 0)).toBe(24);
  });

  it('clamps a negative offset to 0', () => {
    expect(offsetWithinLine(nodes, 1, -5)).toBe(6);
  });

  it('returns 0 for an empty line', () => {
    expect(offsetWithinLine([], 0, 0)).toBe(0);
  });
});

describe('columnFor', () => {
  it('is 1-based and adds the excerpt window origin', () => {
    expect(columnFor(0, 0)).toBe(1);
    expect(columnFor(0, 7)).toBe(8);
  });

  it('offsets by lineStart so a preview-trimmed line lands correctly', () => {
    // The backend trimmed this line to a window starting at char 400, so an
    // offset of 12 within the rendered text is column 413 in the real file.
    expect(columnFor(400, 12)).toBe(413);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/features/search/services/caret-offset.test.ts`
Expected: FAIL — cannot resolve `./caret-offset`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/caret-offset.ts`:

```ts
// Turns a caret hit inside a rendered result line into an editor column.
//
// A line is not one text node: it renders as alternating plain spans and
// <mark> elements, and a colourized context line is a run of Monaco token
// spans. The browser reports a caret as (node, offset-within-node), so the
// offset within the LINE is that offset plus the length of every node before
// it.

/**
 * Character offset within the line's full text for a caret at `nodeOffset`
 * inside the node at `nodeIndex`. Out-of-range inputs clamp rather than
 * producing NaN — the caret APIs can report a node this code did not expect.
 */
export function offsetWithinLine(
  texts: string[],
  nodeIndex: number,
  nodeOffset: number,
): number {
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  if (nodeIndex >= texts.length) return total;

  const safeIndex = Math.max(0, nodeIndex);
  let offset = 0;
  for (let i = 0; i < safeIndex; i++) {
    offset += texts[i].length;
  }
  const within = Math.min(Math.max(0, nodeOffset), texts[safeIndex]?.length ?? 0);
  return offset + within;
}

/**
 * The 1-based editor column for an offset within a rendered line.
 * `lineStart` is the excerpt line's window origin — non-zero only when the
 * backend preview-trimmed a very long line, in which case the rendered text
 * begins that many characters into the real line.
 */
export function columnFor(lineStart: number, offset: number): number {
  return lineStart + offset + 1;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `bun test src/features/search/services/caret-offset.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Export and commit**

Add to `src/features/search/index.ts`:

```ts
export { offsetWithinLine, columnFor } from './services/caret-offset';
```

Run: `bun run verify`

```bash
git add src/features/search
git commit -m "feat(search): map a caret hit to an editor column"
```

---

### Task 5: Mod+click and Enter open at the caret

**Files:**
- Modify: `src/features/search/components/FileExcerptBlock.tsx`
- Modify: `src/features/search/components/ExcerptList.tsx`

**Interfaces:**
- Consumes: `offsetWithinLine`, `columnFor` (Task 4); `onOpenExcerpt(filePath, lineNumber, column)` (Phase 1).
- Produces: no new exports.

- [ ] **Step 1: Add the DOM caret probe**

In `FileExcerptBlock.tsx`, above `ExcerptLineRow`, add the thin browser-API half. Both APIs exist because `caretRangeFromPoint` is WebKit's (what Tauri uses on macOS) and `caretPositionFromPoint` is the standard:

```tsx
/** Character offset within `lineEl`'s text for a viewport point, or null when
 *  the browser exposes neither caret API or reports a node outside the line.
 *  Callers fall back to the match start. */
function offsetFromPoint(lineEl: HTMLElement, x: number, y: number): number | null {
  const doc = lineEl.ownerDocument;
  let node: Node | null = null;
  let nodeOffset = 0;

  const withRange = (doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  }).caretRangeFromPoint;
  const withPosition = (doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  }).caretPositionFromPoint;

  if (typeof withRange === 'function') {
    const range = withRange.call(doc, x, y);
    if (range) {
      node = range.startContainer;
      nodeOffset = range.startOffset;
    }
  } else if (typeof withPosition === 'function') {
    const position = withPosition.call(doc, x, y);
    if (position) {
      node = position.offsetNode;
      nodeOffset = position.offset;
    }
  }
  if (!node || !lineEl.contains(node)) return null;

  // Text nodes in document order — the same order their lengths must be
  // summed in. `acceptNode` is not needed: the walker only yields text nodes.
  const walker = doc.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  let hitIndex = -1;
  let current = walker.nextNode();
  while (current) {
    if (current === node) hitIndex = texts.length;
    texts.push(current.textContent ?? '');
    current = walker.nextNode();
  }
  if (hitIndex === -1) return null;

  return offsetWithinLine(texts, hitIndex, nodeOffset);
}
```

Import `offsetWithinLine` and `columnFor` from `'../services/caret-offset'` (relative — this file is inside the feature).

- [ ] **Step 2: Handle mod+click on the row**

`ExcerptLineRow` currently opens on `onDoubleClick` at the match column. Keep that, and add a mod+click path that prefers the clicked character. Give the row a ref so the probe has an element:

```tsx
  const rowRef = useRef<HTMLDivElement>(null);

  function openAtPoint(e: React.MouseEvent<HTMLDivElement>) {
    const fallback = columnFor(lineStart, matches[0]?.start ?? 0);
    if (!rowRef.current) {
      onOpen(lineNumber, fallback);
      return;
    }
    const offset = offsetFromPoint(rowRef.current, e.clientX, e.clientY);
    onOpen(lineNumber, offset === null ? fallback : columnFor(lineStart, offset));
  }
```

On the row's outer `<div>`, add `ref={rowRef}` and:

```tsx
      onClick={(e) => {
        // Mod+click opens; a plain click still only selects the excerpt, so a
        // long result list stays scannable without bouncing to files.
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          openAtPoint(e);
        }
      }}
      onDoubleClick={(e) => openAtPoint(e)}
```

Add `useRef` to the React import.

- [ ] **Step 3: Open on Enter**

In `ExcerptList.tsx`'s `onKeyDown`, `alt+enter` already opens the active excerpt. Add plain Enter with the same behaviour — there is no click point, so it uses the match start. Insert before the existing `alt+enter` branch:

```tsx
      if (e.key === 'Enter' && !e.altKey && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        openActiveExcerpt();
        return;
      }
```

Extract the body of the existing `alt+enter` branch into an `openActiveExcerpt` callback so both paths share it rather than duplicating the lookup. Do NOT call `stopPropagation` — React listens on `#root`, below the `document` listener `react-hotkeys-hook` uses, so stopping propagation here would kill every app hotkey while the results list holds focus.

- [ ] **Step 4: Make the affordance discoverable**

In `src/App.css`, add to `.search-excerpt-line`:

```css
  cursor: text;
```

That is the whole CSS change. Do not add a hover rule: the affordance is
carried by the line's tooltip and by `cursor: text` reading as selectable
content, and a modifier-held underline would need document-level keydown and
keyup listeners that this task does not budget for.

- [ ] **Step 5: Verify and commit**

Run: `bun run verify`
Expected: PASS. Note this task's behaviour cannot be unit-tested (no RTL); state that plainly in the report rather than implying otherwise.

```bash
git add src/features/search src/App.css
git commit -m "feat(search): mod+click and Enter open a result at the caret"
```

---

### Task 6: The `setHiddenAreas` adapter

Isolates the one untyped internal Monaco API behind a probe, so a future Monaco bump degrades to read-only blocks instead of breaking the tab.

**Files:**
- Create: `src/features/search/services/hidden-areas.ts`
- Create: `src/features/search/services/hidden-areas.test.ts`
- Modify: `src/features/search/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `complementRanges(visible: Array<{start: number; end: number}>, lineCount: number): Array<{start: number; end: number}>`, `canHideAreas(editor: unknown): boolean`, `applyHiddenAreas(editor: unknown, visible: Array<{start: number; end: number}>, lineCount: number): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/features/search/services/hidden-areas.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { complementRanges, canHideAreas, applyHiddenAreas } from './hidden-areas';

describe('complementRanges', () => {
  it('hides everything outside a single excerpt', () => {
    expect(complementRanges([{ start: 10, end: 14 }], 100)).toEqual([
      { start: 1, end: 9 },
      { start: 15, end: 100 },
    ]);
  });

  it('hides the gap between two excerpts', () => {
    expect(complementRanges([{ start: 10, end: 12 }, { start: 40, end: 42 }], 50)).toEqual([
      { start: 1, end: 9 },
      { start: 13, end: 39 },
      { start: 43, end: 50 },
    ]);
  });

  it('emits no leading range when an excerpt starts at line 1', () => {
    expect(complementRanges([{ start: 1, end: 5 }], 20)).toEqual([{ start: 6, end: 20 }]);
  });

  it('emits no trailing range when an excerpt ends at the last line', () => {
    expect(complementRanges([{ start: 16, end: 20 }], 20)).toEqual([{ start: 1, end: 15 }]);
  });

  it('hides nothing when one excerpt covers the whole file', () => {
    expect(complementRanges([{ start: 1, end: 20 }], 20)).toEqual([]);
  });

  it('hides the whole file when there are no excerpts', () => {
    expect(complementRanges([], 20)).toEqual([{ start: 1, end: 20 }]);
  });

  it('merges touching excerpts rather than emitting an empty hidden range', () => {
    expect(complementRanges([{ start: 5, end: 9 }, { start: 10, end: 12 }], 20)).toEqual([
      { start: 1, end: 4 },
      { start: 13, end: 20 },
    ]);
  });
});

describe('canHideAreas', () => {
  it('is false for an editor without the internal API', () => {
    expect(canHideAreas({})).toBe(false);
  });

  it('is false for null', () => {
    expect(canHideAreas(null)).toBe(false);
  });

  it('is true when setHiddenAreas is callable', () => {
    expect(canHideAreas({ setHiddenAreas: () => {} })).toBe(true);
  });
});

describe('applyHiddenAreas', () => {
  it('passes Monaco range literals for the complement and reports success', () => {
    const calls: unknown[][] = [];
    const editor = { setHiddenAreas: (ranges: unknown[]) => calls.push(ranges) };
    expect(applyHiddenAreas(editor, [{ start: 10, end: 12 }], 20)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { startLineNumber: 1, startColumn: 1, endLineNumber: 9, endColumn: 1 },
      { startLineNumber: 13, startColumn: 1, endLineNumber: 20, endColumn: 1 },
    ]);
  });

  it('reports failure and does not throw when the API is missing', () => {
    expect(applyHiddenAreas({}, [{ start: 1, end: 2 }], 20)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/features/search/services/hidden-areas.test.ts`
Expected: FAIL — cannot resolve `./hidden-areas`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/hidden-areas.ts`:

```ts
// `setHiddenAreas` is real on Monaco's CodeEditorWidget but absent from the
// published typings — it is how folding hides lines. It is the one internal
// API this feature depends on, so it lives behind this probe: if a future
// Monaco drops or renames it, blocks stay read-only and every other part of
// the search tab still works.

export interface LineRange {
  /** 1-based, inclusive. */
  start: number;
  /** 1-based, inclusive. */
  end: number;
}

interface HidableEditor {
  setHiddenAreas: (ranges: unknown[]) => void;
}

/**
 * The lines to HIDE, given the lines to show. Input ranges must be ascending
 * and non-overlapping — which is what `buildExcerpts` already guarantees,
 * since it merges overlapping and touching windows.
 */
export function complementRanges(visible: LineRange[], lineCount: number): LineRange[] {
  const hidden: LineRange[] = [];
  let cursor = 1;

  for (const range of visible) {
    if (range.start > cursor) {
      hidden.push({ start: cursor, end: range.start - 1 });
    }
    cursor = Math.max(cursor, range.end + 1);
  }
  if (cursor <= lineCount) {
    hidden.push({ start: cursor, end: lineCount });
  }
  return hidden;
}

export function canHideAreas(editor: unknown): editor is HidableEditor {
  return (
    typeof editor === 'object' &&
    editor !== null &&
    typeof (editor as HidableEditor).setHiddenAreas === 'function'
  );
}

/**
 * Hides everything outside `visible`. Returns false when the internal API is
 * unavailable, so the caller can fall back to the read-only render instead of
 * showing an editor with the whole file in it.
 */
export function applyHiddenAreas(
  editor: unknown,
  visible: LineRange[],
  lineCount: number,
): boolean {
  if (!canHideAreas(editor)) return false;
  editor.setHiddenAreas(
    complementRanges(visible, lineCount).map((range) => ({
      startLineNumber: range.start,
      startColumn: 1,
      endLineNumber: range.end,
      endColumn: 1,
    })),
  );
  return true;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `bun test src/features/search/services/hidden-areas.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Export and commit**

Add to `src/features/search/index.ts`:

```ts
export {
  complementRanges,
  canHideAreas,
  applyHiddenAreas,
  type LineRange,
} from './services/hidden-areas';
```

Run: `bun run verify`

```bash
git add src/features/search
git commit -m "feat(search): add the hidden-areas adapter behind a capability probe"
```

---

### Task 7: Model ownership registry

The hazard this closes is documented in `features/editor/services/model-disposal.ts`: a model that outlives its tab is an orphan, and a later project-wide LSP rename can find it, apply an edit, see no open tab, and write the entire orphan buffer to disk.

**Files:**
- Create: `src/features/search/services/model-ownership.ts`
- Create: `src/features/search/services/model-ownership.test.ts`
- Modify: `src/features/search/index.ts`

**Interfaces:**
- Consumes: nothing (the registry is pure bookkeeping; the caller does the Monaco work).
- Produces: `class SearchModelRegistry` with `claim(path: string): void`, `release(path: string): boolean`, `transfer(path: string): void`, `owns(path: string): boolean`, `releaseAll(): string[]`.

- [ ] **Step 1: Write the failing test**

Create `src/features/search/services/model-ownership.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { SearchModelRegistry } from './model-ownership';

describe('SearchModelRegistry', () => {
  it('owns a model it claimed', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    expect(registry.owns('/w/a.cs')).toBe(true);
  });

  it('owns nothing it did not claim — a model backing an open tab is the tab\'s', () => {
    const registry = new SearchModelRegistry();
    expect(registry.owns('/w/a.cs')).toBe(false);
  });

  it('release reports whether the caller should dispose', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    expect(registry.release('/w/a.cs')).toBe(true);
    expect(registry.owns('/w/a.cs')).toBe(false);
  });

  it('release of an unowned path reports false so a tab\'s model is never disposed', () => {
    const registry = new SearchModelRegistry();
    expect(registry.release('/w/a.cs')).toBe(false);
  });

  it('transfer drops ownership WITHOUT authorising disposal', () => {
    // The first edit opens a tab; the tab now owns the model and its unsaved
    // changes. Disposing here would discard them.
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    registry.transfer('/w/a.cs');
    expect(registry.owns('/w/a.cs')).toBe(false);
    expect(registry.release('/w/a.cs')).toBe(false);
  });

  it('releaseAll returns every owned path and empties the registry', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    registry.claim('/w/b.cs');
    expect(registry.releaseAll().sort()).toEqual(['/w/a.cs', '/w/b.cs']);
    expect(registry.owns('/w/a.cs')).toBe(false);
    expect(registry.releaseAll()).toEqual([]);
  });

  it('releaseAll does not return a transferred path', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    registry.claim('/w/b.cs');
    registry.transfer('/w/a.cs');
    expect(registry.releaseAll()).toEqual(['/w/b.cs']);
  });

  it('claiming twice does not double-register', () => {
    const registry = new SearchModelRegistry();
    registry.claim('/w/a.cs');
    registry.claim('/w/a.cs');
    expect(registry.releaseAll()).toEqual(['/w/a.cs']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/features/search/services/model-ownership.test.ts`
Expected: FAIL — cannot resolve `./model-ownership`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/model-ownership.ts`:

```ts
// Who is allowed to dispose a Monaco model the search tab is displaying.
//
// `features/editor/services/model-disposal.ts` documents the hazard this
// exists to avoid: a model that outlives its tab is an orphan, and a later
// project-wide LSP rename or quick-fix can find it via `findModelForUri`,
// apply an edit, see no open tab, and write the ENTIRE orphan buffer to disk —
// reverting the file to a version the user discarded and overwriting whatever
// Unity or git wrote in the meantime.
//
// Search creates models for files that have no tab, so it creates exactly such
// orphans. The rules:
//
//   - File already open in a tab  -> the TAB owns it. Search never claims it
//                                    and must never dispose it.
//   - Hydrated by search, unedited -> SEARCH owns it. Safe to dispose on LRU
//                                    eviction, on a new search, and on tab
//                                    close, because it cannot have unsaved
//                                    changes.
//   - Edited from the results tab  -> the tab opened by that first edit owns
//                                    it. Search TRANSFERS and stops tracking.

export class SearchModelRegistry {
  private owned = new Set<string>();

  /** Search created this model; it may dispose it later. */
  claim(path: string): void {
    this.owned.add(path);
  }

  /** Search owns this model right now. */
  owns(path: string): boolean {
    return this.owned.has(path);
  }

  /**
   * Give up a model. Returns true only if search owned it, i.e. only if the
   * caller may dispose it. A path search never claimed — a model backing an
   * open tab — always returns false.
   */
  release(path: string): boolean {
    return this.owned.delete(path);
  }

  /**
   * Hand ownership to a tab, WITHOUT authorising disposal. Called when a first
   * edit opens the file as a background tab: the model now holds unsaved
   * changes, and disposing it would discard them.
   */
  transfer(path: string): void {
    this.owned.delete(path);
  }

  /** Give up every model search still owns, returning them for disposal. */
  releaseAll(): string[] {
    const paths = [...this.owned];
    this.owned.clear();
    return paths;
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `bun test src/features/search/services/model-ownership.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Export and commit**

Add to `src/features/search/index.ts`:

```ts
export { SearchModelRegistry } from './services/model-ownership';
```

Run: `bun run verify`

```bash
git add src/features/search
git commit -m "feat(search): track which Monaco models the search tab may dispose"
```

---

### Task 8: Hydrate ONE excerpt into a real editor

The first task that mounts Monaco. Read `src/features/search/components/FileExcerptBlock.tsx` and `ExcerptList.tsx` in full before starting — both have changed in every task above.

**Hydration is per EXCERPT, not per file block.** A block renders as
`header → (divider, excerpt, divider) × N`, and the dividers occupy real height
(10px each, Task 3). One editor spanning a whole block could not interleave those
dividers, so its height would differ from the cold render by `20px × excerptCount`
and hydration would jump the reader's scroll — the failure the spec forbids. One
editor per excerpt keeps the two structures identical: each excerpt is
`lines.length × LINE_HEIGHT` in both representations, dividers unchanged around it.

Several editors can share one model, so a file with three excerpts still holds a
single model.

**Files:**
- Create: `src/features/search/components/HydratedExcerpt.tsx`
- Modify: `src/features/search/components/FileExcerptBlock.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `applyHiddenAreas`, `canHideAreas`, `LineRange` (Task 6); `SearchModelRegistry` (Task 7); `getMonacoInstance()` (`src/utils/monaco-instance.ts`); `fileUri` (`features/lsp` barrel).
- Produces: `<HydratedExcerpt filePath excerpt registry lineHeight onFirstEdit onUnavailable />`.

- [ ] **Step 1: Mount an editor over the file's model**

Create `src/features/search/components/HydratedExcerpt.tsx`. Acquire the model by `fileUri(path)` so it matches what the language server was told; create one only when the file has no tab, and claim it in the registry so disposal is authorised:

```tsx
import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getMonacoInstance } from '../../../utils/monaco-instance';
import { fileUri } from '../../lsp';
import { detectLanguage } from '../../../utils/language-detect';
import { applyHiddenAreas } from '../services/hidden-areas';
import type { SearchModelRegistry } from '../services/model-ownership';
import type { Excerpt } from '../services/excerpt-model';

interface HydratedExcerptProps {
  filePath: string;
  excerpt: Excerpt;
  registry: SearchModelRegistry;
  lineHeight: number;
  onFirstEdit: (filePath: string, content: string) => void;
  /** Called when this excerpt cannot be hydrated — no Monaco, or the internal
   *  hidden-areas API is gone. The parent falls back to the cold render. */
  onUnavailable: () => void;
}

function HydratedExcerpt({
  filePath,
  excerpt,
  registry,
  lineHeight,
  onFirstEdit,
  onUnavailable,
}: HydratedExcerptProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const monaco = getMonacoInstance();
    const host = hostRef.current;
    if (!monaco || !host) {
      onUnavailable();
      return;
    }

    let disposed = false;
    let editor: ReturnType<typeof monaco.editor.create> | null = null;

    async function mount() {
      const uri = monaco!.Uri.parse(fileUri(filePath));
      let model = monaco!.editor.getModel(uri);
      if (!model) {
        // No tab backs this file, so search creates the model and owns it.
        // Re-check after the await: another excerpt of the same file may have
        // created it while this read was in flight.
        const content = await invoke<string>('read_file', { path: filePath });
        if (disposed) return;
        const existing = monaco!.editor.getModel(uri);
        if (existing) {
          model = existing;
        } else {
          model = monaco!.editor.createModel(content, detectLanguage(filePath).monacoId, uri);
          registry.claim(filePath);
        }
      }
      if (disposed) return;

      editor = monaco!.editor.create(host!, {
        model,
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        folding: false,
        glyphMargin: false,
        renderLineHighlight: 'none',
        // The results list owns vertical scrolling; an inner scrollbar here
        // would trap the wheel over every excerpt.
        scrollbar: { vertical: 'hidden', horizontal: 'auto', handleMouseWheel: false },
        automaticLayout: true,
        lineHeight,
      });

      // One excerpt, so one visible range: everything else in the file hides.
      const hidden = applyHiddenAreas(
        editor,
        [{ start: excerpt.startLine, end: excerpt.endLine }],
        model.getLineCount(),
      );
      if (!hidden) {
        // Without hidden areas this editor would show the entire file inside a
        // few rows of space. Tear it down and let the parent render cold.
        editor.dispose();
        editor = null;
        onUnavailable();
        return;
      }

      editor.onDidChangeModelContent(() => {
        onFirstEdit(filePath, model!.getValue());
      });
    }

    void mount();

    return () => {
      disposed = true;
      editor?.dispose();
      // The MODEL is not disposed here: eviction and search-tab close own that
      // decision, via the registry. Disposing on unmount would destroy a model
      // another excerpt of the same file is still showing, or one the user is
      // now editing in a tab.
    };
  }, [filePath, excerpt, registry, lineHeight, onFirstEdit, onUnavailable]);

  return (
    <div
      className="search-excerpt-hydrated"
      ref={hostRef}
      style={{ height: `${excerpt.lines.length * lineHeight}px` }}
    />
  );
}

export default HydratedExcerpt;
```

Note on expansion: an excerpt's `startLine`/`endLine` already reflect any expansion, because `applyExpansion` widened them before this component saw the excerpt. The `excerpt` dependency therefore re-runs this effect and re-applies the hidden areas when the user expands, with no extra work here.

- [ ] **Step 2: Style the host**

Add to `src/App.css`:

```css
.search-excerpt-hydrated {
  width: 100%;
  overflow: hidden;
}
```

- [ ] **Step 3: Verify and commit**

Run: `bun run verify`
Expected: PASS. The component is not yet rendered by anything — Task 9 wires it in. Confirm `bun run test:isolated` still passes: this file imports `features/lsp`, and the isolated harness mocks the editor barrel, so an unmocked import here would surface as a crash there.

```bash
git add src/features/search/components/HydratedExcerpt.tsx src/App.css
git commit -m "feat(search): mount a real editor over an excerpt block"
```

---

### Task 9: Hot/cold switching with an LRU

**Files:**
- Modify: `src/features/search/components/ExcerptList.tsx`
- Modify: `src/features/search/components/FileExcerptBlock.tsx`
- Create: `src/features/search/services/hot-blocks.ts`
- Create: `src/features/search/services/hot-blocks.test.ts`
- Modify: `src/features/search/index.ts`

**Interfaces:**
- Consumes: `HydratedExcerpt` (Task 8); `SearchModelRegistry` (Task 7); `disposeModelForPath` (`features/editor`).
- Produces: `hotSet(visibleIndices: number[], previous: string[], keys: string[], cap: number): { hot: string[]; evicted: string[] }`.

- [ ] **Step 1: Write the failing test**

Create `src/features/search/services/hot-blocks.test.ts`:

```ts
import { describe, it, expect } from 'bun:test';
import { hotSet } from './hot-blocks';

const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

describe('hotSet', () => {
  it('hydrates the visible blocks', () => {
    expect(hotSet([0, 1], [], keys, 8).hot).toEqual(['a', 'b']);
  });

  it('keeps previously hot blocks that are still under the cap', () => {
    const { hot, evicted } = hotSet([2], ['a', 'b'], keys, 8);
    expect(hot).toContain('c');
    expect(hot).toContain('a');
    expect(evicted).toEqual([]);
  });

  it('evicts the least recently visible once over the cap', () => {
    const previous = ['a', 'b', 'c'];
    const { hot, evicted } = hotSet([3], previous, keys, 3);
    expect(hot).toEqual(['d', 'a', 'b']);
    expect(evicted).toEqual(['c']);
  });

  it('never evicts a block that is currently visible', () => {
    const { hot, evicted } = hotSet([0, 1, 2], ['x', 'y', 'z'], keys, 3);
    expect(hot).toEqual(['a', 'b', 'c']);
    expect(evicted).toEqual(['x', 'y', 'z']);
  });

  it('drops keys that no longer exist — a new query replaced the results', () => {
    const { hot, evicted } = hotSet([0], ['gone'], keys, 8);
    expect(hot).toEqual(['a']);
    expect(evicted).toEqual(['gone']);
  });

  it('is stable when nothing changed', () => {
    const { hot, evicted } = hotSet([0], ['a'], keys, 8);
    expect(hot).toEqual(['a']);
    expect(evicted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/features/search/services/hot-blocks.test.ts`
Expected: FAIL — cannot resolve `./hot-blocks`.

- [ ] **Step 3: Implement**

Create `src/features/search/services/hot-blocks.ts`:

```ts
// Which file blocks hold a live Monaco editor. Mounting one costs real time
// and memory, so only blocks in view are hydrated and the rest fall back to
// the read-only render. Recently-visible blocks stay hot so scrolling back a
// few rows does not re-mount.

/**
 * The new hot set and the keys to tear down.
 *
 * Visible blocks are always hot and are never evicted. Remaining capacity goes
 * to previously-hot blocks in their existing order (most recent first). Keys
 * absent from `keys` are evicted unconditionally — that is what happens when a
 * new query replaces the result set.
 */
export function hotSet(
  visibleIndices: number[],
  previous: string[],
  keys: string[],
  cap: number,
): { hot: string[]; evicted: string[] } {
  const visible = visibleIndices
    .map((index) => keys[index])
    .filter((key): key is string => key !== undefined);

  const hot = [...visible];
  for (const key of previous) {
    if (hot.length >= cap) break;
    if (hot.includes(key)) continue;
    if (!keys.includes(key)) continue;
    hot.push(key);
  }

  const evicted = previous.filter((key) => !hot.includes(key));
  return { hot, evicted };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `bun test src/features/search/services/hot-blocks.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the list**

In `ExcerptList.tsx`:

Add `const HOT_BLOCK_CAP = 8;` beside the other constants, and hold the registry and the hot set. The hot set is keyed by **file path**, because that is what a model belongs to and what eviction disposes; the excerpt ids handed to a block are derived from it:

```tsx
  const registryRef = useRef(new SearchModelRegistry());
  const [hot, setHot] = useState<string[]>([]);
```

After the virtualizer is created, recompute the hot set from the virtual items and dispose evicted models search still owns:

```tsx
  const virtualItems = virtualizer.getVirtualItems();
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
```

A hot file's excerpts are all hot, so the prop each block receives is:

```tsx
                hotExcerptIds={
                  hot.includes(block.file.path) ? block.excerpts.map((e) => e.id) : []
                }
```

Dispose everything search still owns when the session's search changes or the list unmounts:

```tsx
  useEffect(() => {
    const registry = registryRef.current;
    return () => {
      for (const path of registry.releaseAll()) disposeModelForPath(path);
    };
  }, [session?.activeSearchId]);
```

Import `disposeModelForPath` from `'../../editor'` (barrel — confirm it is exported there; if it is not, export it from `features/editor/index.ts` as part of this task, since reaching into the service file directly would fail `check:modules`).

Pass `registry={registryRef.current}` and `onFirstEdit={onFirstEdit}` (Task 10 adds that callback; until then pass a no-op `() => {}` so this task compiles on its own) down to `FileExcerptBlock`, alongside the `hotExcerptIds` prop shown above.

- [ ] **Step 6: Switch each excerpt between representations**

In `FileExcerptBlock.tsx`, accept three new props — `hotExcerptIds: string[]`, `registry: SearchModelRegistry`, `onFirstEdit: (filePath: string, content: string) => void` — and add local state for excerpts whose hydration reported itself unavailable:

```tsx
  const [coldFallback, setColdFallback] = useState<string[]>([]);
```

Do **not** restructure the existing excerpt loop. Inside it, the divider buttons and the surrounding `<div className="search-excerpt">` stay exactly where they are; only the run of `<ExcerptLineRow>` elements between the two dividers is swapped. Replace that run with:

```tsx
            {hotExcerptIds.includes(excerpt.id) && !coldFallback.includes(excerpt.id) ? (
              <HydratedExcerpt
                filePath={filePath}
                excerpt={excerpt}
                registry={registry}
                lineHeight={LINE_HEIGHT}
                onFirstEdit={onFirstEdit}
                onUnavailable={() =>
                  setColdFallback((prev) =>
                    prev.includes(excerpt.id) ? prev : [...prev, excerpt.id],
                  )
                }
              />
            ) : (
              excerpt.lines.map((line) => (
                <ExcerptLineRow
                  key={line.lineNumber}
                  lineNumber={line.lineNumber}
                  text={line.text}
                  matches={line.matches}
                  lineStart={line.lineStart}
                  monacoId={monacoId}
                  onOpen={(lineNumber, column) => onOpenExcerpt(filePath, lineNumber, column)}
                />
              ))
            )}
```

Keeping the dividers outside the swap is what preserves height parity: hot and cold differ only by the excerpt's own `lines.length × LINE_HEIGHT`, which both compute from the same constant.

Export `LINE_HEIGHT` from `ExcerptList.tsx` and import it here so there is exactly one definition. Add `useState` to the React import.

- [ ] **Step 7: Verify and commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add src/features/search
git commit -m "feat(search): hydrate visible blocks, keep the rest cold"
```

---

### Task 10: First edit opens a background tab

**Files:**
- Modify: `src/stores/workspace.ts`
- Modify: `src/features/search/components/ExcerptList.tsx`
- Create: `src/stores/search-editing.exec.ts`
- Modify: `package.json` (`test:isolated`)

**Interfaces:**
- Consumes: `SearchModelRegistry.transfer` (Task 7).
- Produces: `useWorkspaceStore.getState().openFileInBackground(path: string, content: string): void`.

- [ ] **Step 1: Add the store action**

In `src/stores/workspace.ts`, add to the interface beside `openFile`:

```ts
  /** Adds a file to `openFiles` WITHOUT activating it. Used when a search
   *  excerpt is first edited: the file must join `openFiles` so dirty state,
   *  save, the close guard and LSP sync all apply, but stealing focus from the
   *  results tab mid-keystroke would be hostile. No-op if already open. */
  openFileInBackground: (path: string, content: string) => void;
```

and the implementation:

```ts
  openFileInBackground: (path, content) => {
    if (get().openFiles.some((f) => f.path === path)) return;
    const name = path.split('/').pop() || path;
    set((state) => ({
      openFiles: [...state.openFiles, { path, name, content, isDirty: true }],
    }));
  },
```

- [ ] **Step 2: Route the first edit through it**

In `ExcerptList.tsx`, add the handler passed to `FileExcerptBlock` as `onFirstEdit`:

```tsx
  const onFirstEdit = useCallback((filePath: string, content: string) => {
    const workspace = useWorkspaceStore.getState();
    if (workspace.openFiles.some((f) => f.path === filePath)) {
      // Already a tab — the existing dirty/LSP path owns it.
      workspace.updateFileContent(filePath, content);
      return;
    }
    // The tab now owns the model and its unsaved changes, so search must stop
    // treating it as disposable.
    registryRef.current.transfer(filePath);
    workspace.openFileInBackground(filePath, content);

    const search = useSearchStore.getState();
    const edited = search.sessions[sessionId]?.editedPaths ?? [];
    if (!edited.includes(filePath)) {
      search.update(sessionId, { editedPaths: [...edited, filePath] });
    }
  }, [sessionId]);
```

`editedPaths` lives on the session, not in component state: the query bar
renders the modified count from it and Task 11's save-all reads it, and this
component unmounts every time the user switches away from the results tab —
component state would lose the set on the next tab switch.

Add the field in `src/features/search/services/search-session.ts`:

```ts
  /** Files this results tab has edited, in first-edit order. Drives the
   *  modified count and save-all. Deliberately NOT part of `searchSignature`:
   *  editing a file is not a reason to re-run the search. */
  editedPaths: string[];
```

with `editedPaths: [],` in `createSession`.

- [ ] **Step 3: Write the isolated behaviour test**

Create `src/stores/search-editing.exec.ts` in the style of `src/stores/search-invalidation.exec.ts` — a real store in its own process. Read that file first and mirror its mocking approach exactly:

```ts
import { describe, it, expect } from 'bun:test';

describe('openFileInBackground — REAL execution (own process, see file header)', () => {
  it('adds the file to openFiles without changing the active tab', async () => {
    const { useWorkspaceStore } = await import('./workspace');
    const before = useWorkspaceStore.getState().activeFilePath;
    useWorkspaceStore.getState().openFileInBackground('/w/a.cs', 'edited');
    const state = useWorkspaceStore.getState();
    expect(state.openFiles.some((f) => f.path === '/w/a.cs')).toBe(true);
    expect(state.activeFilePath).toBe(before);
  });

  it('marks it dirty, so mod+s and the close guard both see it', async () => {
    const { useWorkspaceStore } = await import('./workspace');
    useWorkspaceStore.getState().openFileInBackground('/w/b.cs', 'edited');
    expect(useWorkspaceStore.getState().openFiles.find((f) => f.path === '/w/b.cs')?.isDirty).toBe(true);
  });

  it('is a no-op for a file that already has a tab, preserving its content', async () => {
    const { useWorkspaceStore } = await import('./workspace');
    useWorkspaceStore.getState().openFileInBackground('/w/c.cs', 'first');
    useWorkspaceStore.getState().openFileInBackground('/w/c.cs', 'second');
    const matches = useWorkspaceStore.getState().openFiles.filter((f) => f.path === '/w/c.cs');
    expect(matches).toHaveLength(1);
    expect(matches[0].content).toBe('first');
  });
});
```

- [ ] **Step 4: Chain it into the isolated run**

In `package.json`, extend `test:isolated` with the new file, keeping the existing `&&` chain so each file gets its own process:

```
"test:isolated": "bun test ./src/stores/search-tab-lifecycle.exec.ts && bun test ./src/stores/search-invalidation.exec.ts && bun test ./src/stores/search-editing.exec.ts",
```

- [ ] **Step 5: Run and confirm, then mutation-check**

Run: `bun run test:isolated`
Expected: all three files pass.

Then delete the `if (get().openFiles.some(...)) return;` guard from `openFileInBackground`, re-run, and confirm the third test fails. Restore it. Record both outputs.

- [ ] **Step 6: Verify and commit**

Run: `bun run verify`

```bash
git add src/stores/workspace.ts src/stores/search-editing.exec.ts src/features/search package.json
git commit -m "feat(search): first edit opens the file as a background tab"
```

---

### Task 11: Save-all and the modified count

**Files:**
- Modify: `src/App.tsx` (`file.save` command)
- Modify: `src/features/search/components/SearchResultsTab.tsx`
- Modify: `src/features/search/components/ExcerptList.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `editedPaths` (Task 10); `useWorkspaceStore.getState().saveFile(path)`.
- Produces: a `search-save-all` window event carrying `{ sessionId: string }`.

- [ ] **Step 1: Make `mod+s` save-all in a results tab**

In `src/App.tsx`, the `file.save` command currently saves the active file. Wrap it so a results tab means "save every file this tab edited", leaving every other tab's behaviour identical:

```tsx
      handler: () => {
        const activePath = useWorkspaceStore.getState().activeFilePath;
        if (activePath?.startsWith('search://')) {
          // A results tab has no single active file. Save exactly the files it
          // edited — a file left dirty for unrelated reasons is not swept in.
          window.dispatchEvent(
            new CustomEvent('search-save-all', { detail: { sessionId: activePath } }),
          );
          return;
        }
        if (activePath) void useWorkspaceStore.getState().saveFile(activePath);
      },
```

Preserve whatever guard the existing handler has for a null active path.

- [ ] **Step 2: Handle it in the list**

In `ExcerptList.tsx`:

```tsx
  useEffect(() => {
    function onSaveAll(event: Event) {
      const detail = (event as CustomEvent<{ sessionId: string }>).detail;
      if (detail.sessionId !== sessionId) return;
      const workspace = useWorkspaceStore.getState();
      const search = useSearchStore.getState();
      // Read from the live store rather than a closed-over value: this handler
      // is registered once per sessionId, and an edit made after registration
      // would be missing from a captured array.
      for (const path of search.sessions[sessionId]?.editedPaths ?? []) {
        void workspace.saveFile(path);
      }
      search.update(sessionId, { editedPaths: [] });
    }
    window.addEventListener('search-save-all', onSaveAll);
    return () => window.removeEventListener('search-save-all', onSaveAll);
  }, [sessionId]);
```

- [ ] **Step 3: Surface the count**

`session.editedPaths` already exists and is written by Task 10. Render it in `SearchQueryBar` after the existing count:

```tsx
        {session.editedPaths.length > 0 && (
          <span className="search-modified-count">
            {session.editedPaths.length} modified · ⌘S to save
          </span>
        )}
```

Add to `src/App.css`:

```css
.search-modified-count {
  flex-shrink: 0;
  color: var(--accent);
  font-size: 12px;
  white-space: nowrap;
}
```

Note `editedPaths` must NOT go into `searchSignature` — editing a file is not a reason to re-run the search.

- [ ] **Step 4: Verify and commit**

Run: `bun run verify`
Expected: PASS.

```bash
git add src/App.tsx src/features/search src/App.css
git commit -m "feat(search): save every file edited from a results tab"
```

---

## Final manual verification

Performed by the project owner, not by implementing agents:

- [ ] Search a common identifier in a Unity project — no `.meta` or `.prefab` results; toggling the Unity-assets control brings them back and re-runs.
- [ ] Shaders, `.asmdef`, `.uxml` and `.json` still appear (the regression the blocklist exists to avoid).
- [ ] The ⌃/⌄ bars are gone; hovering an excerpt reveals expansion on its edges, and `shift+enter` still expands.
- [ ] Mod+click mid-identifier on a result lands the caret on that character, including on a long preview-trimmed line.
- [ ] Enter on a focused excerpt opens it at the match.
- [ ] Scroll a large result set: blocks hydrate without the scroll position jumping.
- [ ] Type into an excerpt — a background tab appears for that file, marked dirty, and the results tab shows the modified count.
- [ ] `mod+s` in the results tab writes every edited file; a file left dirty in another tab beforehand is untouched.
- [ ] Edit a file that is also open in its own tab — both views show the change.
- [ ] `bun run verify` green, with `verify:intellisense` a real PASS rather than SKIPPED.
