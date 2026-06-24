import type { Monaco } from '@monaco-editor/react';
import type { editor, IDisposable, Position } from 'monaco-editor';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { useUiStore } from '../../../stores/ui';
import type { DiagnosticItem } from '../../../types';
import { ensureLoaded, getPackages, lookup, newerVersionThan } from './registry-cache';

// ── Scoping ───────────────────────────────────────────────────────────────────
//
// Everything here is hard-scoped to a Unity project's `Packages/manifest.json`.
// Providers bail immediately for any other model so there's zero pollution of
// regular JSON editing.

/** True only for `<...>/Packages/manifest.json` (case-insensitive on the suffix). */
export function isManifestModel(model: editor.ITextModel): boolean {
  // model.uri.path is the decoded path component for our `file://` model URIs.
  const p = model.uri.path.replace(/\\/g, '/').toLowerCase();
  return p.endsWith('/packages/manifest.json') || p === 'packages/manifest.json';
}

/** Feature gate: only a Unity project with the setting enabled. */
function featureEnabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.packages.manifestIntelligence') === true
  );
}

// ── Manifest structural analysis ───────────────────────────────────────────────

interface DependencyLine {
  name: string;
  version: string;
  /** 1-based line number of the dependency entry. */
  line: number;
  /** 1-based column where the value string content starts (for value-edit ranges). */
  valueStartCol: number;
}

interface ManifestShape {
  /** [startLine, endLine] (1-based, inclusive) of the `dependencies` object body. */
  dependenciesRange: [number, number] | null;
  dependencies: DependencyLine[];
}

// `"name": "version"` on a single line — Unity always serializes the manifest this way.
const DEP_LINE_RE = /^\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;

/**
 * Light line-based scan of a manifest model. We avoid a full JSON parse so the
 * analysis still works while the user is mid-edit (and so we can map deps to
 * exact line numbers for diagnostics). Only the `dependencies` object is read.
 */
function analyzeManifest(model: editor.ITextModel): ManifestShape {
  const lineCount = model.getLineCount();
  let depStart = -1;
  let depEnd = -1;
  let depBraceDepth = 0;
  let inDeps = false;

  const deps: DependencyLine[] = [];

  for (let ln = 1; ln <= lineCount; ln++) {
    const text = model.getLineContent(ln);

    if (!inDeps) {
      // Detect the opening of the dependencies object: `"dependencies": {`
      const openMatch = /"dependencies"\s*:\s*\{/.exec(text);
      if (openMatch) {
        inDeps = true;
        depStart = ln;
        // Account for braces from the opening `{` onward (handles an inline
        // `"dependencies": {}` closing on the same line). Depth starts at 1 for
        // the matched `{`; add any further braces in the remainder of the line.
        const afterOpen = text.slice(openMatch.index + openMatch[0].length);
        const extraOpens = (afterOpen.match(/\{/g) ?? []).length;
        const extraCloses = (afterOpen.match(/\}/g) ?? []).length;
        depBraceDepth = 1 + extraOpens - extraCloses;
        if (depBraceDepth <= 0) {
          depEnd = ln;
          inDeps = false;
          break; // empty `{}` — no dependencies
        }
      }
      continue;
    }

    // Inside dependencies: track brace depth so we know when it closes.
    const opens = (text.match(/\{/g) ?? []).length;
    const closes = (text.match(/\}/g) ?? []).length;

    const m = DEP_LINE_RE.exec(text);
    if (m && depBraceDepth === 1) {
      const name = m[1];
      const version = m[2];
      // Column of the value-string interior: index of the 2nd quote pair.
      const valueQuoteIdx = text.indexOf('"', text.indexOf(':'));
      deps.push({
        name,
        version,
        line: ln,
        valueStartCol: valueQuoteIdx >= 0 ? valueQuoteIdx + 2 : 1,
      });
    }

    depBraceDepth += opens - closes;
    if (depBraceDepth <= 0) {
      depEnd = ln;
      inDeps = false;
      break;
    }
  }

  return {
    dependenciesRange: depStart > 0 ? [depStart, depEnd > 0 ? depEnd : lineCount] : null,
    dependencies: deps,
  };
}

/** Is `position` inside the dependencies object body? */
function isInsideDependencies(shape: ManifestShape, position: Position): boolean {
  if (!shape.dependenciesRange) return false;
  const [start, end] = shape.dependenciesRange;
  return position.lineNumber > start && position.lineNumber <= end;
}

// Which string literal is the cursor inside on its line: the key (1st) or value (2nd)?
type StringContext = 'key' | 'value' | 'none';

function stringContextAt(model: editor.ITextModel, position: Position): StringContext {
  const lineText = model.getLineContent(position.lineNumber);
  const col = position.column - 1; // 0-based index into the line

  // Find quote positions up to the cursor; count how many quotes precede it.
  let quotesBefore = 0;
  for (let i = 0; i < col && i < lineText.length; i++) {
    if (lineText[i] === '"' && lineText[i - 1] !== '\\') quotesBefore++;
  }
  // Inside a string ⇔ odd number of quotes precede the cursor.
  if (quotesBefore % 2 === 0) return 'none';
  // 1st string on the line is the key, 2nd is the value.
  return quotesBefore === 1 ? 'key' : 'value';
}

// ── Providers ───────────────────────────────────────────────────────────────────

let disposables: IDisposable[] = [];

/**
 * Register Monaco completion + hover providers for Unity package manifests.
 * Scoped to `Packages/manifest.json`; gated on `isUnityProject` + the setting.
 * Idempotent. Returns a disposer.
 */
export function registerManifestProviders(monaco: Monaco): () => void {
  if (disposables.length > 0) return disposeManifestProviders;

  // Warm the registry cache so completions/hovers are enriched ASAP.
  void ensureLoaded();

  // ── Completion ───────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerCompletionItemProvider('json', {
      triggerCharacters: ['"', '.'],
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        if (!featureEnabled() || !isManifestModel(model)) return { suggestions: [] };

        const shape = analyzeManifest(model);
        if (!isInsideDependencies(shape, position)) return { suggestions: [] };

        const ctx = stringContextAt(model, position);
        if (ctx === 'none') return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        // Use a range that spans the dotted identifier (word boundaries treat
        // `.`/`-` as separators, so expand to the full token between quotes).
        const lineText = model.getLineContent(position.lineNumber);
        const tokenRange = expandToStringToken(lineText, position, monaco, word);

        if (ctx === 'key') {
          const suggestions = getPackages().map((pkg) => ({
            label: pkg.name,
            kind: monaco.languages.CompletionItemKind.Module,
            insertText: pkg.name,
            detail: pkg.latestVersion ? `latest ${pkg.latestVersion}` : 'Unity package',
            documentation: pkg.description ? { value: pkg.description } : undefined,
            filterText: pkg.name,
            range: tokenRange,
          }));
          return { suggestions };
        }

        // ctx === 'value': offer the latest known version for this line's package.
        const m = DEP_LINE_RE.exec(lineText);
        const pkgName = m?.[1];
        const info = pkgName ? lookup(pkgName) : undefined;
        if (!info?.latestVersion) return { suggestions: [] };
        return {
          suggestions: [
            {
              label: info.latestVersion,
              kind: monaco.languages.CompletionItemKind.Value,
              insertText: info.latestVersion,
              detail: `latest known version of ${pkgName}`,
              range: tokenRange,
            },
          ],
        };
      },
    }),
  );

  // ── Hover ────────────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerHoverProvider('json', {
      provideHover(model: editor.ITextModel, position: Position) {
        if (!featureEnabled() || !isManifestModel(model)) return null;

        const shape = analyzeManifest(model);
        if (!isInsideDependencies(shape, position)) return null;

        const lineText = model.getLineContent(position.lineNumber);
        const m = DEP_LINE_RE.exec(lineText);
        if (!m) return null;
        const name = m[1];
        const info = lookup(name);
        if (!info) return null;

        const parts: string[] = [`**${name}**`];
        if (info.description) parts.push(info.description);
        if (info.latestVersion) parts.push(`Latest known version: \`${info.latestVersion}\``);

        return {
          contents: [{ value: parts.join('\n\n') }],
        };
      },
    }),
  );

  return disposeManifestProviders;
}

export function disposeManifestProviders(): void {
  for (const d of disposables) d.dispose();
  disposables = [];
}

/**
 * Expand a Monaco word range to cover the whole string token (so a dotted
 * package id like `com.unity.x` is replaced atomically rather than just the
 * `x` segment). Falls back to the plain word range.
 */
function expandToStringToken(
  lineText: string,
  position: Position,
  monaco: Monaco,
  word: { startColumn: number; endColumn: number },
): InstanceType<typeof monaco.Range> {
  const col = position.column - 1;
  // Find the enclosing quotes.
  let start = col;
  while (start > 0 && lineText[start - 1] !== '"') start--;
  let end = col;
  while (end < lineText.length && lineText[end] !== '"') end++;
  if (start > 0 && end <= lineText.length && start <= end) {
    return new monaco.Range(position.lineNumber, start + 1, position.lineNumber, end + 1);
  }
  return new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn,
  );
}

// ── Diagnostics: "newer version available" info markers ────────────────────────

const DIAG_DEBOUNCE_MS = 600;
let markerWatcher: IDisposable | null = null;
let createWatcher: IDisposable | null = null;
const perUriDebounce = new Map<string, ReturnType<typeof setTimeout>>();
const publishedUris = new Set<string>();

/**
 * Scan a manifest model and publish `'unity-packages'`-source info diagnostics
 * for any pinned dependency older than the known-latest version. A no-op (and
 * clears prior output) when the feature is disabled or it's not a manifest.
 */
async function recomputeDiagnostics(model: editor.ITextModel): Promise<void> {
  const uri = model.uri.toString();

  if (!featureEnabled() || !isManifestModel(model)) {
    if (publishedUris.has(uri)) {
      useUiStore.getState().setFileDiagnostics(uri, 'unity-packages', []);
      publishedUris.delete(uri);
    }
    return;
  }

  // Make sure the registry/seed data is available before comparing versions.
  await ensureLoaded();
  if (model.isDisposed()) return;

  const shape = analyzeManifest(model);
  const filePath = model.uri.path;
  const fileName = filePath.split('/').pop() ?? filePath;
  const items: DiagnosticItem[] = [];

  for (const dep of shape.dependencies) {
    const newer = newerVersionThan(dep.name, dep.version);
    if (!newer) continue;
    items.push({
      file: filePath,
      fileName,
      line: dep.line,
      col: dep.valueStartCol,
      message: `${dep.name}: newer version available: ${newer} (current ${dep.version})`,
      severity: 'info',
      source: 'unity-packages',
    });
  }

  useUiStore.getState().setFileDiagnostics(uri, 'unity-packages', items);
  if (items.length > 0) publishedUris.add(uri);
  else publishedUris.delete(uri);
}

function scheduleDiagnostics(model: editor.ITextModel): void {
  const uri = model.uri.toString();
  const existing = perUriDebounce.get(uri);
  if (existing) clearTimeout(existing);
  perUriDebounce.set(
    uri,
    setTimeout(() => {
      perUriDebounce.delete(uri);
      if (model.isDisposed()) return;
      void recomputeDiagnostics(model);
    }, DIAG_DEBOUNCE_MS),
  );
}

/**
 * Start watching manifest models for "newer version available" info diagnostics.
 * Idempotent. Returns a disposer. Inert outside Unity projects (recompute self-gates).
 */
export function startManifestDiagnostics(monaco: Monaco): () => void {
  if (markerWatcher || createWatcher) return stopManifestDiagnostics;

  const watch = (model: editor.ITextModel) => {
    if (!isManifestModel(model)) return;
    // Initial pass + on every content change (debounced).
    scheduleDiagnostics(model);
    const sub = model.onDidChangeContent(() => scheduleDiagnostics(model));
    disposables.push(sub);
  };

  for (const m of monaco.editor.getModels()) watch(m);
  createWatcher = monaco.editor.onDidCreateModel((m: editor.ITextModel) => watch(m));

  // Also recompute when models are removed so we clear stale entries.
  markerWatcher = monaco.editor.onWillDisposeModel((m: editor.ITextModel) => {
    const uri = m.uri.toString();
    if (publishedUris.has(uri)) {
      useUiStore.getState().setFileDiagnostics(uri, 'unity-packages', []);
      publishedUris.delete(uri);
    }
  });

  return stopManifestDiagnostics;
}

export function stopManifestDiagnostics(): void {
  if (createWatcher) {
    createWatcher.dispose();
    createWatcher = null;
  }
  if (markerWatcher) {
    markerWatcher.dispose();
    markerWatcher = null;
  }
  for (const t of perUriDebounce.values()) clearTimeout(t);
  perUriDebounce.clear();
  const ui = useUiStore.getState();
  for (const uri of publishedUris) ui.setFileDiagnostics(uri, 'unity-packages', []);
  publishedUris.clear();
}
