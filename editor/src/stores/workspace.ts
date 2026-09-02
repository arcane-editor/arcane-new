import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listenScoped } from '../utils/tauri-listener';
import type { FileEntry, TreeNode, OpenFile, DiffInfo } from '../types';
import { initMonaco, disposeModelForPath } from '../features/editor';
import { applySaveResult } from '../utils/save-outcome';
import { isVirtualPath } from '../utils/virtual-path';
import {
  lspManager,
  registerLspProviders,
  attachClientToProviders,
  syncDocumentOpen,
  syncDocumentClose,
  syncDocumentSave,
  syncDocumentChange,
  resetDocumentVersions,
  forgetDocument,
  fileUri,
  markCsharpProjectLoaded,
  resetCsharpProjectLoaded,
  type LspClient,
} from '../features/lsp';
import { useGitStore } from './git';
import { useUiStore } from './ui';
import { useProjectContextStore } from './project-context';
import { useTerminalStore } from './terminal';
import { useUnityStore } from './unity';
import { useUnitySceneStore } from './unity-scene';
import { useAiStore } from './ai';
import { useGraphifyStore } from './graphify';
import { useSearchStore } from './search';
import { useSettingsStore } from './settings';
import { notify } from './notifications';
import { coDeleteMeta, coRenameMeta } from '../features/explorer';
import { maybeRefreshUnityAfterSave } from '../features/unity-bridge';
import { isUnityAssetFile } from '../features/unity-asset-viewer';
import { resolveDiffSources, isLiveDiff, nextDiffInfo } from '../features/git';
import { ExcludeMatcher } from '../utils/exclude-matcher';
import { addRecentProject } from '../utils/persistence';
import { classifyFile, offerClassRenameSync } from '../features/csharp';
import { detectLanguage } from '../utils/language-detect';
import { safeUnlisten } from '../utils/tauri-listener';
import { filesToReload } from '../utils/open-file-reload';
import { isIgnoreFile } from '../utils/ignore-file';

// Track provider dispose function
let disposeLspProviders: (() => void) | null = null;

// Track file-watcher event listener — must be cleaned up on workspace switch
// so the previous workspace's events stop driving tree refreshes.
let unlistenFileWatcher: (() => void) | null = null;
let unlistenGitState: (() => void) | null = null;
let unlistenContentChanged: (() => void) | null = null;
let fileWatcherDebounce: ReturnType<typeof setTimeout> | null = null;

// Unity-only: when .cs files are added/removed under Assets/, the generated
// `.unityide.csproj` is stale until we regenerate it and nudge csharp-ls. Unity
// touches many files at once (it rewrites whole script folders on import), so
// we coalesce the burst with a ~2s debounce and accumulate the net delta
// across the window before doing the (expensive, Rust-side) csproj regen.
const UNITY_CSPROJ_RELOAD_DEBOUNCE_MS = 2000;
let unityCsprojReloadDebounce: ReturnType<typeof setTimeout> | null = null;
// Accumulated .cs paths seen since the debounce timer was (re)armed. A path
// can't be both added and removed in the same coalesced window in a way the
// server cares about — last-event-wins — so we track each in its own set and
// reconcile (added∖removed, removed∖added) when the timer fires.
const unityPendingCsAdded = new Set<string>();
const unityPendingCsRemoved = new Set<string>();

/** LSP `FileChangeType` (spec §3.17.1): 1=Created, 2=Changed, 3=Deleted. */
const FILE_CHANGE_CREATED = 1;
const FILE_CHANGE_CHANGED = 2;
const FILE_CHANGE_DELETED = 3;

interface FileIndexDelta {
  added: string[];
  removed: string[];
}

interface WatchedFileChange {
  uri: string;
  type: number;
}

function clearUnityCsprojReload(): void {
  if (unityCsprojReloadDebounce) {
    clearTimeout(unityCsprojReloadDebounce);
    unityCsprojReloadDebounce = null;
  }
  unityPendingCsAdded.clear();
  unityPendingCsRemoved.clear();
}

/**
 * Hot-reload the C# project model when .cs files are added/removed under a
 * Unity project's Assets/. Unity regenerates its own project files on every
 * import, but the IDE drives csharp-ls off its own generated `.unityide.csproj`
 * (globbed from `Assets/**​/*.cs`), so a new/removed script is invisible to
 * IntelliSense until we (1) regenerate that csproj and (2) tell csharp-ls.
 *
 * No-ops for non-Unity projects. Filters the delta to `.cs` files under
 * `<workspace>/Assets/`, then debounces ~2s to coalesce Unity's bursty file
 * events into a single regen + notification.
 *
 * Sends `workspace/didChangeWatchedFiles` (project file Changed + each
 * added/removed script) AND then restarts csharp-ls.
 *
 * The notification alone is not enough, and this was confirmed in live use:
 * a newly created script reported `CS0518: Predefined type 'System.Void' is
 * not defined` on every line until the window was reloaded. csharp-ls (Roslyn)
 * ignores didChangeWatchedFiles for project *structure*, and `.unityide.csproj`
 * globs `Assets/**​/*.cs` — MSBuild expands that glob at load, so a file
 * created afterwards belongs to no project at all. A file in no project has no
 * corelib reference, which is precisely what CS0518 reports.
 *
 * The notification is kept because it is correct and cheap, and a csharp-ls
 * that honours it makes the restart a no-op in practice. The restart is the
 * guarantee. It costs a solution reload (seconds), but Unity is recompiling
 * anyway on a new script, and the alternative is IntelliSense that stays
 * silently broken until the user thinks to reload the window.
 */
function scheduleUnityCsprojReload(delta: FileIndexDelta): void {
  if (!useProjectContextStore.getState().isUnityProject) return;

  const workspacePath = useWorkspaceStore.getState().workspacePath;
  if (!workspacePath) return;

  // Only .cs files under <workspace>/Assets/ affect the C# project model.
  const assetsPrefix =
    (workspacePath.endsWith('/') ? workspacePath : workspacePath + '/') + 'Assets/';
  const isRelevant = (p: string) => p.endsWith('.cs') && p.startsWith(assetsPrefix);

  let sawRelevant = false;
  for (const p of delta.added) {
    if (!isRelevant(p)) continue;
    sawRelevant = true;
    // A re-add supersedes a pending removal within the same window.
    unityPendingCsRemoved.delete(p);
    unityPendingCsAdded.add(p);
  }
  for (const p of delta.removed) {
    if (!isRelevant(p)) continue;
    sawRelevant = true;
    unityPendingCsAdded.delete(p);
    unityPendingCsRemoved.add(p);
  }

  if (!sawRelevant) return;

  if (unityCsprojReloadDebounce) clearTimeout(unityCsprojReloadDebounce);
  unityCsprojReloadDebounce = setTimeout(() => {
    unityCsprojReloadDebounce = null;
    const added = [...unityPendingCsAdded];
    const removed = [...unityPendingCsRemoved];
    unityPendingCsAdded.clear();
    unityPendingCsRemoved.clear();
    void runUnityCsprojReload(workspacePath, added, removed);
  }, UNITY_CSPROJ_RELOAD_DEBOUNCE_MS);
}

async function runUnityCsprojReload(
  workspacePath: string,
  addedCs: string[],
  removedCs: string[],
): Promise<void> {
  // Regenerate `.unityide.csproj`/`.unityide.sln` from the current Assets/ tree.
  // All the heavy lifting lives in Rust; the frontend just orchestrates.
  // Returns the solution path (or null if it couldn't be generated).
  let solutionPath: string | null;
  try {
    solutionPath = await invoke<string | null>('unity_setup_lsp', { workspacePath });
  } catch (err) {
    console.warn('[Workspace] unity_setup_lsp regen failed during hot-reload:', err);
    return;
  }
  // Keep the cached solution path fresh so a later restartLsp/crash-recovery
  // reuses the regenerated solution rather than a stale one.
  if (solutionPath) csharpSolutionPath = solutionPath;

  // No-op cleanly if csharp-ls isn't running (non-Unity lazy path never
  // started it, it crashed past its restart budget, dotnet missing, etc.).
  const client = lspManager.client('csharp');
  if (!client.isRunning()) return;

  const changes: WatchedFileChange[] = [];
  // The regenerated project file itself changed. unity_setup_lsp returns the
  // .sln path; that's the concrete artifact we have a path for, and it sits
  // next to the .unityide.csproj it generates — signal it as Changed so Roslyn
  // re-reads the project graph.
  if (solutionPath) {
    changes.push({ uri: fileUri(solutionPath), type: FILE_CHANGE_CHANGED });
  }
  for (const p of addedCs) {
    changes.push({ uri: fileUri(p), type: FILE_CHANGE_CREATED });
  }
  for (const p of removedCs) {
    changes.push({ uri: fileUri(p), type: FILE_CHANGE_DELETED });
  }
  if (changes.length === 0) return;

  client.notify('workspace/didChangeWatchedFiles', { changes });

  // Escalation. Roslyn does not rebuild its project graph off that
  // notification, so without this a brand-new script sits in no project and
  // every predefined type reports CS0518 until the user reloads the window.
  //
  // Only structure changes reach here (adds/removes), and they are already
  // coalesced by the ~2s debounce above, so a burst of Unity file events
  // produces one restart rather than one per file.
  try {
    await client.stop();
  } catch (err) {
    console.warn('[Workspace] csharp-ls stop before project-structure restart failed:', err);
  }
  // runLspStart's re-sync loop reopens every tracked .cs file
  // (forgetDocument → syncDocumentOpen), so open editors get real diagnostics
  // back against the rebuilt project without the user touching anything.
  await attemptLspStartFor('csharp', workspacePath, solutionPath);

  console.log(
    `[Workspace] Unity csproj hot-reload: regenerated, notified, restarted csharp-ls`,
    { added: addedCs.length, removed: removedCs.length },
  );
}

async function proactivelyOpenCSharpFiles(workspacePath: string): Promise<void> {
  const MAX_FILES = 20;

  const csharpClient = lspManager.client('csharp');
  if (!csharpClient.isRunning()) return;

  // Scan all files in the workspace via Tauri backend
  const allFiles = await invoke<string[]>('scan_all_files', { workspacePath });

  // Filter to .cs files in Assets/ and classify by priority
  // scan_all_files returns absolute paths; make relative for classifyFile
  const prefix = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/';
  const csFiles = allFiles
    .filter((f: string) => f.endsWith('.cs') && f.includes('/Assets/'))
    .map((f: string) => {
      const relative = f.startsWith(prefix) ? f.slice(prefix.length) : f;
      return { path: f, priority: classifyFile(relative) };
    })
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_FILES);

  for (const file of csFiles) {
    try {
      const content = await invoke<string>('read_file', { path: file.path });
      syncDocumentOpen(csharpClient, file.path, content, 'csharp');
    } catch {
      // Skip unreadable files
    }
  }

  if (csFiles.length > 0) {
    console.log(`[Workspace] Proactively opened ${csFiles.length} C# files for Roslyn`);
  }
}

// Track the C# solution path for restart purposes (csharp-only).
let csharpSolutionPath: string | null = null;

// Per-language restart budget: if a server crashes more than N times within
// the window, we stop auto-restarting and surface an error so the user can
// investigate instead of being stuck in a Loading↔Ready loop. Each language
// gets its own bucket so a flaky pyright doesn't poison the csharp budget.
const LSP_RESTART_WINDOW_MS = 30_000;
const LSP_MAX_RESTARTS_IN_WINDOW = 3;
const lspRestartTimestamps = new Map<string, number[]>();

// Per-language: push-diagnostics unsubscribe handle returned by
// attachClientToProviders. Replaced on every successful restart so we don't
// leak handlers across crashes.
const lspPushDiagUnsubs = new Map<string, () => void>();

// Per-attempt csharp-only resources. csharp-ls drives the global LSP status
// flow ($/progress + window/logMessage + 60s failsafe); other languages just
// rely on activity-based ready detection in providers.ts.
let unsubscribeCsharpProgress: (() => void) | null = null;
let unsubscribeCsharpLogMessage: (() => void) | null = null;
let csharpFailsafeTimer: ReturnType<typeof setTimeout> | null = null;

// Languages that have failed to start in the current workspace session and
// should not be retried until restartLsp() is called or the workspace
// switches. Keeps a missing pyright from triggering a spawn-storm every
// time the user opens a `.py` file.
const lspFailedLanguages = new Set<string>();

// Dedupe concurrent attemptLspStartFor calls for the same language. Without
// this, a `.cs` file opened while csharp-ls is still initializing would
// trigger a second start that tears down the first's listeners — which
// rejects the first's `initialize` and surfaces a bogus "csharp-ls not
// found" toast even though spawn succeeded.
const pendingLspStarts = new Map<string, Promise<void>>();

/**
 * Heuristic: does this error look like the binary isn't installed? We use
 * this to decide whether to show the friendly install hint. For other
 * failures (shutdown races, init timeouts, server crashes mid-handshake),
 * the install hint would be misleading.
 */
function looksLikeMissingBinary(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Failed to spawn|No such file|ENOENT|os error 2/i.test(msg);
}

function releasePriorLspAttempt(): void {
  if (unsubscribeCsharpProgress) {
    unsubscribeCsharpProgress();
    unsubscribeCsharpProgress = null;
  }
  if (unsubscribeCsharpLogMessage) {
    unsubscribeCsharpLogMessage();
    unsubscribeCsharpLogMessage = null;
  }
  if (csharpFailsafeTimer) {
    clearTimeout(csharpFailsafeTimer);
    csharpFailsafeTimer = null;
  }
}

async function ensureMonacoProvidersRegistered(): Promise<void> {
  if (disposeLspProviders) return;
  try {
    const monaco = await initMonaco();
    disposeLspProviders = registerLspProviders(monaco);
  } catch (err) {
    console.warn('[Workspace] Failed to register Monaco/LSP providers:', err);
  }
}

/**
 * Start (or restart) the LSP server for `language`. Idempotent in failure:
 * if the server can't be spawned, the language is added to
 * `lspFailedLanguages` so subsequent file-open events don't trigger more
 * spawn attempts until `restartLsp()` is called.
 *
 * Concurrent calls for the same language collapse onto a single in-flight
 * start so that opening `.cs` files mid-initialization can't tear down the
 * first attempt's listeners.
 *
 * `solutionPath` is only consumed by the csharp branch; passing it for
 * other languages is harmless.
 */
function attemptLspStartFor(
  language: string,
  workspacePath: string,
  solutionPath?: string | null,
): Promise<void> {
  const existing = pendingLspStarts.get(language);
  if (existing) return existing;

  const promise = (async () => {
    try {
      await runLspStart(language, workspacePath, solutionPath ?? null);
    } finally {
      pendingLspStarts.delete(language);
    }
  })();
  pendingLspStarts.set(language, promise);
  return promise;
}

async function runLspStart(
  language: string,
  workspacePath: string,
  solutionPath: string | null,
): Promise<void> {
  console.log('[Workspace] LSP start requested', { language, workspacePath, solutionPath });

  // Static Monaco-side providers must be registered exactly once. They're
  // language-aware internally and look up the right client per request, so
  // we register them on the first attemptLspStartFor call regardless of
  // which language triggered it.
  await ensureMonacoProvidersRegistered();

  if (language === 'csharp') {
    releasePriorLspAttempt();
    // Close the C# diagnostics gate before the server exists, so a pull
    // scheduled by a model created during startup is held rather than answered
    // from a workspace whose references haven't loaded. Covers restarts too
    // (crash recovery, Unity csproj hot-reload) — both rebuild the project
    // graph and both come through here. Reopened by the load-finished marker
    // below, or by the gate's own failsafe.
    resetCsharpProjectLoaded();
  }

  const client = lspManager.client(language);

  try {
    await client.start(workspacePath, solutionPath ?? undefined);
  } catch (err) {
    console.warn(`[Workspace] LSP (${language}) failed to start:`, err);
    lspFailedLanguages.add(language);
    if (language === 'csharp') {
      useUiStore.getState().setLspStatus('error');
    }
    if (looksLikeMissingBinary(err)) {
      notify.error(installHintFor(language) ?? `LSP server for '${language}' is not installed`);
    } else {
      const detail = err instanceof Error ? err.message : String(err);
      notify.error(`LSP server (${language}) failed to start: ${detail}`);
    }
    return;
  }

  // Wire push-diagnostics to this client. Replace any prior handle so we
  // don't double-fire after a restart.
  const priorPushUnsub = lspPushDiagUnsubs.get(language);
  if (priorPushUnsub) priorPushUnsub();
  lspPushDiagUnsubs.set(language, attachClientToProviders(client));

  // Crash recovery: register an onExited callback for this client. The
  // callback handles restart budget and triggers attemptLspStartFor again.
  client.onExited(() => handleClientCrash(language));

  if (language === 'csharp') {
    useUiStore.getState().setLspStatus('indexing');

    unsubscribeCsharpProgress = client.onNotification('$/progress', (params: unknown) => {
      const p = params as { value?: { kind?: string; message?: string; title?: string } };
      const v = p?.value;
      if (!v) return;
      if (v.kind === 'end') useUiStore.getState().setLspProgress(null);
      else if (v.message) useUiStore.getState().setLspProgress(v.message);
      else if (v.title) useUiStore.getState().setLspProgress(v.title);
    });

    // csharp-ls 0.22 reports solution load progress via window/logMessage,
    // not $/progress, and uses pull diagnostics so publishDiagnostics never
    // arrives. Watch the log stream for the load-finished marker and flip
    // to 'ready' so the StatusBar isn't a permanent "Loading".
    let solutionLoadFinished = false;
    unsubscribeCsharpLogMessage = client.onNotification('window/logMessage', (params: unknown) => {
      const p = params as { message?: string };
      const raw = p?.message ?? '';
      const msg = raw.replace(/^csharp-ls:\s*/, '');
      if (!msg) return;

      if (msg.startsWith('Loading solution') || msg.startsWith('Loading project')) {
        useUiStore.getState().setLspProgress(msg);
      } else if (
        msg.startsWith('Finished loading solution') ||
        msg.startsWith('Finished loading project')
      ) {
        solutionLoadFinished = true;
        useUiStore.getState().setLspProgress(null);
        useUiStore.getState().setLspStatus('ready');
        // Roslyn now has its reference set, so a diagnostic report finally
        // means something. Opening the gate re-pulls every open C# model
        // (providers.ts), which is what replaces the whole-file CS0518
        // cascade a mid-load pull would otherwise have left on screen.
        markCsharpProjectLoaded();
      }
    });

    // Failsafe: if no load-finished marker arrives within 60s, flip to
    // 'ready' anyway so the user isn't stuck on "Loading" forever.
    csharpFailsafeTimer = setTimeout(() => {
      csharpFailsafeTimer = null;
      if (solutionLoadFinished) return;
      const ui = useUiStore.getState();
      if (ui.lspStatus === 'starting' || ui.lspStatus === 'indexing') {
        ui.setLspStatus('ready');
      }
    }, 60_000);
  }

  // Re-sync any open files that match this language. Active file first.
  // forgetDocument() before each open so a restarted server gets a real
  // `didOpen` instead of a `didChange` against a file it has never seen.
  const { openFiles, activeFilePath } = useWorkspaceStore.getState();
  const sorted = [...openFiles].sort((a, b) =>
    a.path === activeFilePath ? -1 : b.path === activeFilePath ? 1 : 0,
  );
  for (const file of sorted) {
    if (isVirtualPath(file.path)) continue;
    const info = detectLanguage(file.name);
    if (info.lspServerKey === language && info.lspLanguageId) {
      forgetDocument(file.path);
      syncDocumentOpen(client, file.path, file.content, info.lspLanguageId);
    }
  }
}

function handleClientCrash(language: string): void {
  console.warn(`[Workspace] LSP (${language}) crashed, attempting restart...`);

  const now = Date.now();
  const stamps = (lspRestartTimestamps.get(language) ?? []).filter(
    (t) => now - t < LSP_RESTART_WINDOW_MS,
  );
  stamps.push(now);
  lspRestartTimestamps.set(language, stamps);

  if (stamps.length > LSP_MAX_RESTARTS_IN_WINDOW) {
    console.error(
      `[Workspace] LSP (${language}) crashed ${stamps.length} times in ${LSP_RESTART_WINDOW_MS / 1000}s — giving up.`,
    );
    lspFailedLanguages.add(language);
    if (language === 'csharp') {
      useUiStore.getState().setLspStatus('error');
      useUiStore
        .getState()
        .setLspProgress('LSP crashed repeatedly — see console; click status bar to retry');
      releasePriorLspAttempt();
    }
    return;
  }

  if (language === 'csharp') {
    useUiStore.getState().setLspStatus('starting');
    releasePriorLspAttempt();
  }
  // attemptLspStartFor's re-sync loop calls forgetDocument() per file
  // before re-opening, so per-language documents are refreshed cleanly
  // without trampling other languages' tracking state.

  setTimeout(() => {
    const currentPath = useWorkspaceStore.getState().workspacePath;
    if (!currentPath) {
      if (language === 'csharp') useUiStore.getState().setLspStatus('idle');
      return;
    }
    const sln = language === 'csharp' ? csharpSolutionPath : null;
    void attemptLspStartFor(language, currentPath, sln);
  }, 1000);
}

function installHintFor(language: string): string | null {
  switch (language) {
    case 'csharp':
      return 'csharp-ls not found — install with: dotnet tool install -g csharp-ls';
    case 'python':
      return 'Pyright not found — install with: npm install -g pyright';
    case 'typescript':
      return 'typescript-language-server not found — install with: npm install -g typescript-language-server typescript';
    default:
      return null;
  }
}

/**
 * Lazy-start the right LSP server for a file's language and return the
 * client + LSP languageId. Returns null if the language has no LSP, the
 * server has already failed to start in this session, or the start fails.
 */
async function ensureLspForFile(
  filename: string,
): Promise<{ client: LspClient; lspLanguageId: string } | null> {
  const info = detectLanguage(filename);
  if (!info.lspServerKey || !info.lspLanguageId) return null;
  if (lspFailedLanguages.has(info.lspServerKey)) return null;

  const client = lspManager.client(info.lspServerKey);
  if (!client.isRunning()) {
    const { workspacePath } = useWorkspaceStore.getState();
    if (!workspacePath) return null;
    // Lazy startup for any LSP language. C# eager-starts only for Unity
    // projects in setWorkspace; in non-Unity projects this path handles
    // the first .cs file open the same way it does for Python/TS.
    await attemptLspStartFor(info.lspServerKey, workspacePath);
    if (!client.isRunning()) return null;
  }
  return { client, lspLanguageId: info.lspLanguageId };
}

function getRunningClientForFile(
  filename: string,
): { client: LspClient; lspLanguageId: string } | null {
  const info = detectLanguage(filename);
  if (!info.lspServerKey || !info.lspLanguageId) return null;
  const client = lspManager.client(info.lspServerKey);
  if (!client.isRunning()) return null;
  return { client, lspLanguageId: info.lspLanguageId };
}

function toTreeNode(entry: FileEntry): TreeNode {
  return {
    id: entry.path,
    name: entry.name,
    isDir: entry.is_dir,
    ignored: entry.ignored,
    children: entry.is_dir
      ? (entry.children ?? []).map(toTreeNode)
      : undefined,
  };
}

function filterEntries(entries: FileEntry[], patterns: string[]): FileEntry[] {
  if (patterns.length === 0) return entries;
  const matcher = new ExcludeMatcher(patterns);
  return entries.filter((e) => !matcher.matches(e.name));
}

function updateTreeChildren(
  nodes: TreeNode[],
  parentId: string,
  children: TreeNode[],
): TreeNode[] {
  return nodes.map((node) => {
    if (node.id === parentId) {
      return { ...node, children };
    }
    if (node.children) {
      return {
        ...node,
        children: updateTreeChildren(node.children, parentId, children),
      };
    }
    return node;
  });
}

function findNodeInTree(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNodeInTree(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

// Refresh the tree to reflect changes that happened inside the given parent
// directories. Refreshes root if any change is at root level; for nested
// dirs, reloads only the parents that are currently visible in the tree
// (avoids touching subtrees the user hasn't expanded).
async function refreshAffectedDirs(
  get: () => WorkspaceState,
  parents: string[],
): Promise<void> {
  const state = get();
  const rootPath = state.assetsRootPath ?? state.workspacePath;
  if (!rootPath) return;

  const uniqueParents = Array.from(new Set(parents));
  const needsRoot = uniqueParents.some((p) => p === rootPath);

  if (needsRoot) {
    await state.refreshTree();
  }

  for (const parent of uniqueParents) {
    if (parent === rootPath) continue;
    // Only reload if the parent is currently in the visible tree
    const node = findNodeInTree(get().tree, parent);
    if (node && node.children !== undefined) {
      try {
        await get().loadChildren(parent);
      } catch (err) {
        console.warn('[Workspace] loadChildren failed for', parent, err);
      }
    }
  }
}

// Re-classify gitignore status for every already-loaded tree level without
// touching the tree's structure (no collapse of expanded folders): re-list
// each loaded directory just for its fresh `ignored` flags and patch them
// onto the existing nodes. Runs when a .gitignore/.ignore file changes.
async function refreshIgnoreFlags(get: () => WorkspaceState): Promise<void> {
  const state = get();
  const rootPath = state.assetsRootPath ?? state.workspacePath;
  if (!rootPath) return;

  const dirs: string[] = [rootPath];
  const collectLoadedDirs = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.isDir && n.children && n.children.length > 0) {
        dirs.push(n.id);
        collectLoadedDirs(n.children);
      }
    }
  };
  collectLoadedDirs(state.tree);

  const flagEntries = await Promise.all(
    dirs.map(async (dir) => {
      try {
        const entries = await invoke<FileEntry[]>('read_directory', { path: dir });
        return entries.map((e) => [e.path, e.ignored ?? false] as const);
      } catch {
        return [] as ReadonlyArray<readonly [string, boolean]>;
      }
    }),
  );
  const flags = new Map(flagEntries.flat());

  const apply = (nodes: TreeNode[]): TreeNode[] =>
    nodes.map((n) => ({
      ...n,
      ignored: flags.get(n.id) ?? n.ignored,
      children: n.children ? apply(n.children) : undefined,
    }));
  useWorkspaceStore.setState({ tree: apply(get().tree) });
}

/** Both sides of a diff, plus whether either side failed to load. */
interface DiffContents {
  originalContent: string;
  modifiedContent: string;
  /** True only when BOTH sides failed — i.e. there is nothing to show at all. */
  bothFailed: boolean;
  /** Joined failure detail, for the toast. Empty unless `bothFailed`. */
  detail: string;
}

/**
 * Read both sides of a staged/unstaged diff from git.
 *
 * Shared by `openDiffTab` (first open) and `refreshOpenDiffTabs` (live update)
 * so the two can never drift on which revision each side comes from — that
 * asymmetry is exactly what produced wrong diff contents before.
 */
async function fetchDiffContents(
  workspacePath: string,
  filePath: string,
  staged: boolean,
  origPath?: string | null,
): Promise<DiffContents> {
  let originalContent = '';
  let modifiedContent = '';
  let originalFailed = false;
  let modifiedFailed = false;
  let originalError: unknown = null;
  let modifiedError: unknown = null;

  if (staged) {
    // Staged diff: HEAD vs INDEX. A staged deletion naturally renders as
    // content -> empty (git_show_index returns "" once a path is removed
    // from the index). For a rename the HEAD side lives at the PRE-rename
    // path — `filePath` doesn't exist in HEAD at all, so reading it there
    // would render the move as a whole-file insertion.
    const { original } = resolveDiffSources({ path: filePath, staged: true, origPath });
    try {
      originalContent = await invoke<string>('git_show_head', {
        workspacePath,
        filePath: original.path,
      });
    } catch (err) {
      originalFailed = true;
      originalError = err;
    }
    try {
      modifiedContent = await invoke<string>('git_show_index', { workspacePath, filePath });
    } catch (err) {
      modifiedFailed = true;
      modifiedError = err;
    }
  } else {
    // Unstaged diff: INDEX vs worktree. Unmerged/conflicted paths have no
    // stage 0, so git_show_index errors for them — fall back to HEAD so
    // conflicts keep the pre-existing HEAD-vs-worktree behavior. Untracked
    // files: the index side is "" as before.
    try {
      originalContent = await invoke<string>('git_show_index', { workspacePath, filePath });
    } catch {
      try {
        originalContent = await invoke<string>('git_show_head', { workspacePath, filePath });
      } catch (err) {
        originalFailed = true;
        originalError = err;
      }
    }
    try {
      // `filePath` is repo-root-relative (see `repo_root` in git.rs), and the
      // root is not the workspace whenever the opened folder sits below it —
      // joining against `workspacePath` would read the wrong file, or nothing.
      const root = await invoke<string>('git_repo_root', { workspacePath });
      modifiedContent = await invoke<string>('read_file', { path: `${root}/${filePath}` });
    } catch (err) {
      // File deleted — modifiedContent stays empty. Still tracked as a
      // failure below so a fully broken repo/workspace (both sides
      // erroring) surfaces a toast instead of a silently empty diff.
      modifiedFailed = true;
      modifiedError = err;
    }
  }

  const bothFailed = originalFailed && modifiedFailed;
  const detail = bothFailed
    ? [originalError, modifiedError]
        .filter((e): e is unknown => e != null)
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join('; ')
    : '';

  return { originalContent, modifiedContent, bothFailed, detail };
}

/**
 * Keeps the search store's `activeSessionId` pointed at whichever `search://`
 * tab is now the active editor tab — Task 11's results sidebar renders
 * whichever session that id names, so a stale id would show one tab's
 * results while a different search tab is on screen. `openSearchTab` already
 * does this for a newly-created tab; this covers every other way a search
 * tab can become active (a TabBar click via `setActiveFile`, or `closeFile`
 * falling back to the next tab when the active one closes).
 *
 * Never creates a session — only `ensureSession` does that. Every open
 * `search://` tab already has one (created in `openSearchTab`, torn down in
 * `closeFile` at the same moment the tab itself closes), so by the time a
 * tab can become active here, its session is guaranteed to already exist.
 * No-ops for a non-search (or null) path.
 */
function syncActiveSearchSession(path: string | null): void {
  if (!path || !path.startsWith('search://')) return;
  useSearchStore.getState().setActiveSession(path);
}

interface WorkspaceState {
  workspacePath: string | null;
  assetsRootPath: string | null;
  tree: TreeNode[];
  openFiles: OpenFile[];
  activeFilePath: string | null;
  extraExcludePatterns: string[];
  isLoadingTree: boolean;
  /** Most recently closed tab paths, newest first; capped at 20 */
  recentlyClosed: string[];

  setWorkspace: (path: string) => Promise<void>;
  setExcludePatterns: (patterns: string[]) => void;
  setAssetsRoot: (assetsPath: string) => Promise<void>;
  loadChildren: (parentPath: string) => Promise<TreeNode[]>;
  openFile: (path: string, name: string) => Promise<void>;
  /** Adds a file to `openFiles` WITHOUT activating it. Used when a search
   *  excerpt is first edited: the file must join `openFiles` so dirty state,
   *  save, the close guard and LSP sync all apply, but stealing focus from the
   *  results tab mid-keystroke would be hostile. No-op if already open. */
  openFileInBackground: (path: string, content: string) => void;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  reorderTabs: (fromPath: string, toPath: string) => void;
  popRecentlyClosed: () => string | null;
  updateFileContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  reloadFileFromDisk: (path: string, opts?: { skipIfDirty?: boolean }) => Promise<void>;
  /**
   * `filePath` is repo-root-relative. `origPath` is the pre-rename path for a
   * renamed entry — required for a staged rename to diff as a rename rather
   * than a whole-file insertion.
   */
  openDiffTab: (
    filePath: string,
    fileName: string,
    staged: boolean,
    origPath?: string | null,
  ) => Promise<void>;
  openCommitDiffTab: (hash: string, filePath: string, title: string) => Promise<void>;
  /** Opens a new search tab and returns its path (`search://<n>`). `seed`
   *  pre-fills the query and/or the include glob — used by "Search in Folder"
   *  and by seeding from the editor selection. */
  openSearchTab: (seed?: { query?: string; includePattern?: string }) => string;
  /**
   * Re-read both sides of every open staged/unstaged diff tab. Called on
   * `git-state-changed` (stage, unstage, commit, checkout) and when a watched
   * file changes on disk, so an open diff reflects reality instead of the
   * moment it was opened. Never changes which tab is active.
   */
  refreshOpenDiffTabs: () => Promise<void>;
  refreshTree: () => Promise<void>;
  createFile: (parentDir: string, fileName: string) => Promise<string | null>;
  createDirectory: (parentDir: string, dirName: string) => Promise<string | null>;
  renamePath: (oldPath: string, newPath: string) => Promise<void>;
  deletePath: (path: string) => Promise<void>;
  restartLsp: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspacePath: null,
  assetsRootPath: null,
  tree: [],
  openFiles: [],
  activeFilePath: null,
  extraExcludePatterns: [],
  isLoadingTree: false,
  recentlyClosed: [],

  setWorkspace: async (path: string) => {
    useUiStore.getState().setLspStatus('idle');

    // Clean up previous workspace
    if (disposeLspProviders) {
      disposeLspProviders();
      disposeLspProviders = null;
    }
    await lspManager.stopAll().catch(() => {});
    for (const unsub of lspPushDiagUnsubs.values()) {
      try { unsub(); } catch { /* ignore */ }
    }
    lspPushDiagUnsubs.clear();
    releasePriorLspAttempt();
    resetDocumentVersions();
    // Fresh workspace gets fresh per-language restart budgets — prior
    // crashes don't carry over, and previously-failed languages get a
    // second chance in case the user installed the missing server.
    lspRestartTimestamps.clear();
    lspFailedLanguages.clear();
    useUiStore.getState().setLspStatus('starting');

    // Stop the previous workspace's file watcher and tear down its event
    // listener so changes in the old project no longer drive the new tree.
    if (unlistenFileWatcher) {
      safeUnlisten(unlistenFileWatcher);
      unlistenFileWatcher = null;
    }
    if (unlistenGitState) {
      safeUnlisten(unlistenGitState);
      unlistenGitState = null;
    }
    if (unlistenContentChanged) {
      safeUnlisten(unlistenContentChanged);
      unlistenContentChanged = null;
    }
    if (fileWatcherDebounce) {
      clearTimeout(fileWatcherDebounce);
      fileWatcherDebounce = null;
    }
    // Cancel any pending Unity csproj hot-reload from the previous workspace
    // and drop its accumulated .cs delta so it can't fire against the new one.
    clearUnityCsprojReload();
    await invoke('stop_file_watcher').catch((err) => {
      console.warn('[Workspace] stop_file_watcher failed:', err);
    });

    // Drop the previous project's Unity state. Console history and the last
    // compile report used to survive the switch, so project A's errors were
    // presented as project B's.
    useUnityStore.getState().resetForWorkspaceChange();
    useUnitySceneStore.getState().reset();

    // Kill terminals from the previous workspace — their cwd is stale and
    // they shouldn't bleed into the new project's terminal panel.
    const termStore = useTerminalStore.getState();
    await Promise.all(
      termStore.terminals.map((t) =>
        termStore.killTerminal(t.id).catch(() => {}),
      ),
    );

    // Reset other workspace-scoped stores. Each already exposes a reset; we
    // were just never calling them on switch.
    useGitStore.getState().reset();
    useProjectContextStore.getState().reset();
    useAiStore.getState().resetConversation();
    useGraphifyStore.getState().reset();
    {
      const { sessions, clearResults } = useSearchStore.getState();
      // Every open search tab's results belong to the workspace being left —
      // clear each session rather than just the default one now that search
      // is session-keyed (one search per tab).
      Object.keys(sessions).forEach((id) => clearResults(id));
    }

    set({ isLoadingTree: true });

    // Detect project type up front so we can gate csharp-ls startup AND decide
    // where to root the file tree. The detection is a fast Rust filesystem check
    // (Assets/ + ProjectSettings/). Running it before read_directory lets us root
    // the tree at <root>/Assets in a single read, with no root→Assets flicker.
    let unityInfo: {
      is_unity: boolean;
      unity_version: string | null;
      nested_project_path: string | null;
      ancestor_project_path: string | null;
    } = {
      is_unity: false,
      unity_version: null,
      nested_project_path: null,
      ancestor_project_path: null,
    };
    try {
      unityInfo = await invoke<{
        is_unity: boolean;
        unity_version: string | null;
        nested_project_path: string | null;
        ancestor_project_path: string | null;
      }>('detect_unity_project', { workspacePath: path });
    } catch (err) {
      console.warn('[Workspace] Unity detection failed:', err);
    }

    // For Unity projects, show only the contents of Assets/ — as if the user had
    // opened the Assets folder directly. `is_unity` is true only when the opened
    // folder itself is the Unity root, so <root>/Assets is guaranteed to exist.
    // workspacePath stays the real project root (git/LSP/terminals/watcher use it);
    // only the tree is re-rooted via assetsRootPath.
    const treeRoot = unityInfo.is_unity ? `${path}/Assets` : path;

    let entries: FileEntry[];
    try {
      entries = await invoke<FileEntry[]>('read_directory', { path: treeRoot });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // This is the sole user-facing toast for a setWorkspace failure — every
      // caller (boot restore, "Open Recent", explorer refresh, the nested-
      // project prompt, etc.) either lets this rejection propagate/logs it
      // silently or relies on this toast entirely for user feedback. Keep the
      // path + an actionable hint here rather than duplicating a toast at
      // each call site.
      notify.error(`Couldn't open ${path} — it may have been moved or deleted. (${msg})`);
      set({ isLoadingTree: false });
      throw err;
    }
    const tree = filterEntries(entries, get().extraExcludePatterns).map(toTreeNode);

    set({
      workspacePath: path,
      assetsRootPath: unityInfo.is_unity ? treeRoot : null,
      tree,
      openFiles: [],
      activeFilePath: null,
      isLoadingTree: false,
      recentlyClosed: [],
    });

    addRecentProject(path);

    useProjectContextStore.getState().applyDetection(path, unityInfo);

    // C# LSP eager startup is Unity-only. Non-Unity projects can still get
    // C# completions if the user opens a .cs file — ensureLspForFile (below)
    // handles lazy startup the same way it does for Python and TypeScript.
    //
    // The dotnet probe is gated behind the Unity check on purpose: non-Unity
    // workspaces never pay that cost, and if a non-Unity user opens a stray
    // .cs file without dotnet, the lazy path surfaces a plain toast — only
    // Unity gets the dedicated modal.
    if (unityInfo.is_unity) {
      let dotnetInstalled = true;
      try {
        dotnetInstalled = await invoke<boolean>('check_dotnet_installed');
      } catch (err) {
        console.warn('[Workspace] Dotnet check failed:', err);
      }

      if (!dotnetInstalled) {
        useUiStore.getState().setDotnetMissingModalOpen(true);
      } else {
        let solutionPath: string | null = null;
        try {
          solutionPath = await invoke<string | null>('unity_setup_lsp', { workspacePath: path });
          if (solutionPath) {
            console.log('[Workspace] Unity project setup complete, solution:', solutionPath);
          }
        } catch (err) {
          console.warn('[Workspace] Unity setup failed:', err);
        }
        csharpSolutionPath = solutionPath;

        if (!solutionPath) {
          // The generator builds its reference set from the Unity install
          // itself, so reaching here no longer means "Unity hasn't generated
          // its csprojs" — it means we couldn't resolve the Unity editor for
          // this project's version at all.
          useUiStore
            .getState()
            .setLspProgress(
              'Unity editor not found for this project version — C# IntelliSense unavailable',
            );
        }

        attemptLspStartFor('csharp', path, solutionPath).then(() => {
          proactivelyOpenCSharpFiles(path).catch((err) => {
            console.warn('[Workspace] Proactive file opening failed:', err);
          });
        });
      }
    }

    // Refresh git status (async, non-blocking)
    useGitStore.getState().refreshStatus(path);

    // Build the persistent quick-open file index for this workspace
    // (fire-and-forget — `fuzzy_search_files` rebuilds inline on its own if
    // this hasn't landed yet by the time the user opens quick-open).
    // Unconditionally replaces any index left over from a prior workspace.
    invoke('build_file_index', {
      workspacePath: path,
      extraExcludes: get().extraExcludePatterns,
    }).catch((err) => {
      console.error('[Workspace] build_file_index failed:', err);
    });

    // Start file watcher and subscribe to its delta events so the tree
    // reflects external filesystem changes (and so files created inside
    // expanded subdirs appear without a manual refresh).
    invoke('start_file_watcher', { workspacePath: path })
      .then(async () => {
        const unlisten = await listenScoped<FileIndexDelta>('file-index-changed', (event) => {
          const delta = event.payload;
          // Unity-only: keep the C# project model in sync when .cs files are
          // added/removed under Assets/ (regenerate .unityide.csproj + nudge
          // csharp-ls). Self-debounced (~2s) and self-gated to Unity projects;
          // a no-op everywhere else. Independent of the tree-refresh debounce
          // below so neither path starves the other.
          scheduleUnityCsprojReload(delta);
          // Debounce so a burst of changes triggers one refresh
          if (fileWatcherDebounce) clearTimeout(fileWatcherDebounce);
          fileWatcherDebounce = setTimeout(() => {
            fileWatcherDebounce = null;
            const parents = new Set<string>();
            for (const p of [...delta.added, ...delta.removed]) {
              const slash = p.lastIndexOf('/');
              if (slash > 0) parents.add(p.slice(0, slash));
            }
            refreshAffectedDirs(get, Array.from(parents)).catch((err) => {
              console.warn('[Workspace] file-watcher refresh failed:', err);
            });
          }, 150);
        });
        unlistenFileWatcher = unlisten;

        // The Rust watcher emits this event the instant `.git/HEAD` or any
        // branch-pointer ref is rewritten — i.e., when the user runs
        // `git checkout` (in our terminal or anywhere else). Refresh both the
        // status (current branch, ahead/behind, dirty files) and the branch
        // list immediately so the status bar and branch switcher update
        // without waiting for window-focus or a manual git operation —
        // otherwise a branch created in the terminal shows up in the status
        // bar but not in the branch list (or vice versa).
        const unlistenGit = await listenScoped<void>('git-state-changed', () => {
          const wp = get().workspacePath;
          if (wp) {
            useGitStore.getState().refreshStatus(wp).catch(() => {});
            useGitStore.getState().refreshBranches(wp).catch(() => {});
            // Staging, committing or checking out changes what an open diff
            // should show; without this the tab keeps rendering whatever was
            // true when it was opened.
            get().refreshOpenDiffTabs().catch(() => {});
          }
        });
        unlistenGitState = unlistenGit;

        // Live-reload open tabs when their file changes on disk (external
        // editor, git checkout in a terminal, codegen). Dirty tabs are
        // skipped — unsaved edits always win. reloadFileFromDisk drives the
        // full pipeline: store content → Monaco (guarded, no re-dirty) →
        // LSP didChange.
        const unlistenContent = await listenScoped<string[]>('file-content-changed', (event) => {
          const store = get();
          for (const p of filesToReload(store.openFiles, event.payload)) {
            store.reloadFileFromDisk(p, { skipIfDirty: true }).catch((err) => {
              console.warn('[Workspace] live reload failed:', p, err);
            });
          }
          // A working-tree edit is the other side of an unstaged diff, and it
          // never touches `.git`, so `git-state-changed` won't fire for it.
          store.refreshOpenDiffTabs().catch(() => {});
          // Editing ignore rules changes which tree entries render dimmed.
          if (event.payload.some(isIgnoreFile)) {
            refreshIgnoreFlags(get).catch((err) => {
              console.warn('[Workspace] ignore-flag refresh failed:', err);
            });
          }
        });
        unlistenContentChanged = unlistenContent;
      })
      .catch((err) => {
        console.warn('[Workspace] File watcher failed to start:', err);
      });

    // Detect the codebase graph and, on first visit, open the intro modal.
    // Stale graphs are communicated by GraphifyStatusBadge in the status bar
    // (click-to-rebuild), so no toast nag here. Bundle ships with a sidecar
    // binary; when unavailable the store stays in 'error' and we suppress
    // the prompt. Users can hide the first-open modal permanently from settings.
    void useGraphifyStore
      .getState()
      .detect(path)
      .then(() => {
        const graph = useGraphifyStore.getState();
        if (graph.sidecarAvailable === false) return;
        const suppress = useSettingsStore
          .getState()
          .getSetting('graphify.suppressFirstOpenToast');
        if (suppress) return;

        if (graph.status === 'absent') {
          useUiStore.getState().setGraphifyIntroOpen(true);
        }
      });
  },

  setExcludePatterns: (patterns: string[]) => {
    set({ extraExcludePatterns: patterns });
    // Refresh tree so new patterns take effect immediately
    get().refreshTree();

    // Rebuild the quick-open file index so it reflects the new exclude
    // patterns immediately (fire-and-forget — a mismatched cache would
    // otherwise self-correct on the next fuzzy_search_files call anyway,
    // but rebuilding now avoids that one-off inline-rebuild latency hit).
    const { workspacePath } = get();
    if (workspacePath) {
      invoke('build_file_index', {
        workspacePath,
        extraExcludes: patterns,
      }).catch((err) => {
        console.error('[Workspace] build_file_index failed:', err);
      });
    }
  },

  setAssetsRoot: async (assetsPath: string) => {
    try {
      const entries = await invoke<FileEntry[]>('read_directory', { path: assetsPath });
      const tree = filterEntries(entries, get().extraExcludePatterns).map(toTreeNode);
      set({ assetsRootPath: assetsPath, tree });
      console.log('[Workspace] Assets root set:', assetsPath);
    } catch (err) {
      console.warn('[Workspace] Failed to set Assets root:', err);
    }
  },

  loadChildren: async (parentPath: string) => {
    const entries = await invoke<FileEntry[]>('read_directory', {
      path: parentPath,
    });
    const children = filterEntries(entries, get().extraExcludePatterns).map(toTreeNode);
    set((state) => ({
      tree: updateTreeChildren(state.tree, parentPath, children),
    }));
    return children;
  },

  openFile: async (path: string, name: string) => {
    const { openFiles } = get();
    const existing = openFiles.find((f) => f.path === path);
    if (existing) {
      set({ activeFilePath: path });
      return;
    }

    // `auth://account` used to be opened here as a contentless virtual tab.
    // The account view is a section of the settings modal now, so nothing
    // creates one — the remaining `auth://` guards elsewhere in the codebase
    // are kept only to tolerate state persisted by an older version.
    // `read_file_checked` rather than `read_file`: a binary asset is an
    // ordinary thing to click in a Unity project, and `read_to_string` reports
    // it with the same io::Error as a missing file. That surfaced to the user
    // as the raw OS string "stream did not contain valid UTF-8".
    const read = await invoke<{ text: string | null; isBinary: boolean; size: number }>(
      'read_file_checked',
      { path },
    );

    if (read.isBinary) {
      // Content stays empty and the tab is flagged, so the editor renders an
      // explanation and every write path refuses it.
      set((state) => ({
        openFiles: [
          ...state.openFiles,
          { path, name, content: '', isDirty: false, isBinary: true, byteSize: read.size },
        ],
        activeFilePath: path,
      }));
      return;
    }

    const content = read.text ?? '';
    const file: OpenFile = { path, name, content, isDirty: false };
    set((state) => ({
      openFiles: [...state.openFiles, file],
      activeFilePath: path,
    }));

    // Notify (and lazily start) the LSP server for this file's language.
    const ctx = await ensureLspForFile(name);
    if (ctx) {
      syncDocumentOpen(ctx.client, path, content, ctx.lspLanguageId);
    }
  },

  openFileInBackground: (path, content) => {
    if (get().openFiles.some((f) => f.path === path)) return;
    const name = path.split('/').pop() || path;
    set((state) => ({
      openFiles: [...state.openFiles, { path, name, content, isDirty: true }],
    }));

    // Notify (and lazily start) the LSP server for this file's language —
    // mirrors `openFile`'s own didOpen above. Fire-and-forget rather than
    // `await`ed: this action's contract is synchronous (the isolated test
    // asserts `openFiles` already holds the new tab the instant this call
    // returns), so the async LSP handshake runs after the state write
    // instead of gating it. Skipping this is not a mere protocol nicety —
    // `syncDocumentChange`/`syncDocumentSave` (`document-sync.ts`) both
    // early-return on `!openCounts.has(path)`, which is only ever populated
    // by a `didOpen`. Without one, every `didChange` and `didSave` for a
    // file that started life as a background tab would be SILENTLY dropped
    // for the rest of the session — no error, no stale diagnostics, just
    // none at all.
    void ensureLspForFile(name).then((ctx) => {
      if (!ctx) return;
      // Read the CURRENT content, not the snapshot closed over by this call:
      // the user may keep typing while the server is still lazily starting,
      // and `didOpen`'s text is what establishes the server's baseline — a
      // stale baseline here would need a further edit to ever self-correct.
      const current = get().openFiles.find((f) => f.path === path)?.content ?? content;
      syncDocumentOpen(ctx.client, path, current, ctx.lspLanguageId);
    });
  },

  closeFile: (path: string) => {
    if (path.startsWith('search://')) {
      useSearchStore.getState().closeSession(path);
    }

    // Notify the LSP server for this file's language before removing.
    const file = get().openFiles.find((f) => f.path === path);
    if (file) {
      const ctx = getRunningClientForFile(file.name);
      if (ctx) syncDocumentClose(ctx.client, path);
    }

    // Diagnostics are keyed by document URI and nothing cleared them on close,
    // so the Problems panel and the status-bar error count kept reporting files
    // that are closed — or deleted — with no way to make them go away.
    // Cleared under both keys: providers store some diagnostics by document
    // URI and some by raw path (TabBar reads both), so clearing one alone
    // leaves the other reporting a file that is no longer open.
    useUiStore.getState().clearFileDiagnostics(fileUri(path));
    useUiStore.getState().clearFileDiagnostics(path);

    // Free the Monaco model — AFTER didClose, so the server is told about a
    // document that still exists. Left alive, the orphan keeps whatever the
    // user typed (including changes discarded at the "Close Anyway" prompt),
    // and a later LSP rename that touches this file will find it and write
    // that whole buffer back to disk.
    disposeModelForPath(path);

    set((state) => {
      const openFiles = state.openFiles.filter((f) => f.path !== path);
      let { activeFilePath } = state;
      if (activeFilePath === path) {
        activeFilePath =
          openFiles.length > 0
            ? openFiles[openFiles.length - 1].path
            : null;
      }
      // Track for "Reopen Closed Tab" — skip virtual paths since they
      // require special re-open logic we don't have.
      const isVirtual = isVirtualPath(path);
      const recentlyClosed = isVirtual
        ? state.recentlyClosed
        : [path, ...state.recentlyClosed.filter((p) => p !== path)].slice(0, 20);
      return { openFiles, activeFilePath, recentlyClosed };
    });

    // Covers two cases, both real: (1) closing the active tab fell back to a
    // DIFFERENT search:// tab (e.g. closing a regular file left a search tab
    // as the last one open) — activeSessionId must follow it, and nothing
    // above set that up. (2) the closed tab itself was the search tab:
    // `closeSession` above already retargeted `activeSessionId`, but to an
    // ARBITRARY surviving session (`Object.keys(next)[0]`) that need not
    // match whichever tab is actually active now — this call corrects that
    // to the real one whenever the real one is also a search tab. No-ops
    // only when the tab that ends up active isn't a search tab at all.
    syncActiveSearchSession(get().activeFilePath);
  },

  popRecentlyClosed: () => {
    const { recentlyClosed } = get();
    if (recentlyClosed.length === 0) return null;
    const [head, ...rest] = recentlyClosed;
    set({ recentlyClosed: rest });
    return head;
  },

  setActiveFile: (path: string) => {
    set({ activeFilePath: path });
    syncActiveSearchSession(path);
  },

  reorderTabs: (fromPath: string, toPath: string) => {
    set((state) => {
      const fromIdx = state.openFiles.findIndex((f) => f.path === fromPath);
      const toIdx = state.openFiles.findIndex((f) => f.path === toPath);
      if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return state;
      const next = [...state.openFiles];
      const [moved] = next.splice(fromIdx, 1);
      const insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
      next.splice(insertIdx, 0, moved);
      return { openFiles: next };
    });
  },

  updateFileContent: (path: string, content: string) => {
    set((state) => ({
      openFiles: state.openFiles.map((f) =>
        // A binary tab never takes content: marking it dirty would arm a save
        // that truncates the file.
        f.path === path && !f.isBinary ? { ...f, content, isDirty: true } : f,
      ),
    }));

    // Notify the right LSP about the content change.
    const file = get().openFiles.find((f) => f.path === path);
    if (file) {
      const ctx = getRunningClientForFile(file.name);
      if (ctx) syncDocumentChange(ctx.client, path, content);
    }
  },

  saveFile: async (path: string) => {
    const { openFiles } = get();
    const file = openFiles.find((f) => f.path === path);
    if (!file) return;
    // A binary tab's `content` is an empty placeholder, never the file. Writing
    // it would truncate the asset, so saving is refused outright rather than
    // silently no-oped -- the user pressed Cmd+S and deserves to know why
    // nothing happened.
    if (file.isBinary) {
      notify.error(`${file.name} is a binary file and cannot be saved from the editor.`);
      return;
    }
    // Snapshot what actually goes to disk. The user can keep typing during the
    // write — easily hundreds of ms on a large file — and those keystrokes are
    // NOT in this payload.
    const written = file.content;
    try {
      await invoke('write_file', { path, contents: written });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error(`Failed to save ${file.name}: ${msg}`);
      throw err;
    }
    // Clean only if the buffer still matches what was written. Clearing
    // unconditionally marked mid-write keystrokes as saved; the watcher then
    // saw the disk change, found the tab clean, and reloaded over them.
    set((state) => ({ openFiles: applySaveResult(state.openFiles, path, written) }));

    // Notify the right LSP about the save.
    const ctx = getRunningClientForFile(file.name);
    if (ctx) syncDocumentSave(ctx.client, path, written);

    // Refresh git status after save
    const { workspacePath } = get();
    if (workspacePath) {
      useGitStore.getState().refreshStatus(workspacePath);
      useGitStore.getState().invalidateBlameFile(path);
      // Saving changes the worktree side of any open unstaged diff. The
      // watcher would eventually catch this, but going direct makes the diff
      // update on the same tick as the save.
      get().refreshOpenDiffTabs().catch(() => {});
    }

    // Unity: ask the connected Editor to refresh/recompile on .cs save
    // (gated + fire-and-forget; no-op outside Unity projects).
    maybeRefreshUnityAfterSave(path);
  },

  reloadFileFromDisk: async (path: string, opts?: { skipIfDirty?: boolean }) => {
    const { openFiles } = get();
    const file = openFiles.find((f) => f.path === path);
    if (!file) return;
    if (isVirtualPath(path)) return;
    // A binary tab holds no text to refresh, and `read_file` would fail on it.
    if (file.isBinary) return;
    let content: string;
    try {
      content = await invoke<string>('read_file', { path });
    } catch (err) {
      console.warn('[Workspace] reloadFileFromDisk failed:', path, err);
      return;
    }
    // Re-check AFTER the await: the tab may have closed, or (watcher-driven
    // reloads only) the user may have started typing while the read was in
    // flight — an external change must never clobber unsaved edits. Default
    // callers (checkpoint restore, discard, rename-sync) intentionally
    // overwrite dirty buffers.
    const current = get().openFiles.find((f) => f.path === path);
    if (!current) return;
    if (opts?.skipIfDirty) {
      if (current.isDirty) return;
      // Echo suppression: our own saves (and no-op external writes) round-trip
      // through the watcher; identical content needs no store churn or LSP
      // didChange.
      if (current.content === content) return;
    }
    set((state) => ({
      openFiles: state.openFiles.map((f) =>
        f.path === path ? { ...f, content, isDirty: false } : f,
      ),
    }));
    const ctx = getRunningClientForFile(file.name);
    if (ctx) syncDocumentChange(ctx.client, path, content);
  },

  openDiffTab: async (filePath: string, fileName: string, staged: boolean, origPath?: string | null) => {
    const { workspacePath } = get();
    if (!workspacePath) return;

    const diffPath = `diff://${staged ? 'staged' : 'unstaged'}/${filePath}`;

    const { originalContent, modifiedContent, bothFailed, detail } = await fetchDiffContents(
      workspacePath,
      filePath,
      staged,
      origPath,
    );

    if (bothFailed) {
      notify.error(`Couldn't load diff for ${fileName}: ${detail}`);
      return;
    }

    // Unity scene/prefab/asset files get a semantic tree diff instead of the
    // flat Monaco text diff below, gated on being a Unity project (mirrors
    // EditorPanel's `structuredCandidate` pattern) AND the user setting
    // (checked at open time — see `DiffInfo.semanticCandidate`'s doc comment).
    const semanticCandidate =
      useProjectContextStore.getState().isUnityProject &&
      isUnityAssetFile(fileName) &&
      useSettingsStore.getState().settings['unity.sceneDiff.enabled'];

    set((state) => {
      const idx = state.openFiles.findIndex((f) => f.path === diffPath);
      if (idx !== -1) {
        // Stale-tab fix: re-clicking an already-open diff tab must refresh
        // its content in place (new `diff` object reference — Monaco's
        // DiffEditor won't re-render on a mutated object) rather than just
        // activating the old, possibly-stale tab.
        const existing = state.openFiles[idx];
        const openFiles = state.openFiles.slice();
        openFiles[idx] = {
          ...existing,
          diff: { ...(existing.diff as DiffInfo), originalContent, modifiedContent, semanticCandidate, origPath },
        };
        return { openFiles, activeFilePath: diffPath };
      }

      const file: OpenFile = {
        path: diffPath,
        name: `${fileName} (${staged ? 'Staged' : 'Working Tree'})`,
        content: '',
        isDirty: false,
        diff: {
          originalContent,
          modifiedContent,
          filePath,
          staged,
          semanticCandidate,
          origPath,
        },
      };
      return { openFiles: [...state.openFiles, file], activeFilePath: diffPath };
    });
  },

  refreshOpenDiffTabs: async () => {
    const { workspacePath, openFiles } = get();
    if (!workspacePath) return;

    // Commit diffs are pinned to immutable revisions, so they can never go
    // stale and are skipped. Everything else compares against the index or the
    // worktree, both of which the triggering event may have just changed.
    const targets = openFiles.filter(
      (f): f is OpenFile & { diff: DiffInfo } => !!f.diff && isLiveDiff(f.diff),
    );
    if (targets.length === 0) return;

    const results = await Promise.all(
      targets.map(async (f) => {
        try {
          const contents = await fetchDiffContents(
            workspacePath,
            f.diff.filePath,
            f.diff.staged,
            f.diff.origPath,
          );
          return { path: f.path, contents };
        } catch {
          return null;
        }
      }),
    );

    set((state) => ({
      openFiles: state.openFiles.map((f) => {
        const result = results.find((r) => r && r.path === f.path);
        // Both sides failing means the file is gone from git's view entirely
        // (e.g. discarded while open). Leave the tab's last-known content
        // rather than blanking it — closing it is the user's call.
        if (!result || !f.diff || result.contents.bothFailed) return f;
        const { originalContent, modifiedContent } = result.contents;
        // `nextDiffInfo` preserves object identity when nothing changed, which
        // is what keeps Monaco from re-rendering (and resetting scroll) on
        // every unrelated git event.
        const next = nextDiffInfo(f.diff, { originalContent, modifiedContent });
        return next === f.diff ? f : { ...f, diff: next };
      }),
    }));
  },

  openCommitDiffTab: async (hash: string, filePath: string, title: string) => {
    const { workspacePath } = get();
    if (!workspacePath) return;

    const diffPath = `diff://commit/${hash}/${filePath}`;

    // Original = the file as it stood before the commit (`<hash>^`); modified
    // = the file as the commit left it. `git_show_file_at` returns "" for a
    // root commit's nonexistent parent or a path that didn't exist at that
    // revision — i.e. added/deleted files diff cleanly against empty.
    // Content sources are immutable revs, so refetching on every click (see
    // below) is cheap and harmless.
    const [originalContent, modifiedContent] = await Promise.all([
      invoke<string>('git_show_file_at', { workspacePath, rev: `${hash}^`, filePath }),
      invoke<string>('git_show_file_at', { workspacePath, rev: hash, filePath }),
    ]);

    set((state) => {
      const idx = state.openFiles.findIndex((f) => f.path === diffPath);
      if (idx !== -1) {
        // Same stale-tab fix as openDiffTab (also picks up label changes).
        const existing = state.openFiles[idx];
        const openFiles = state.openFiles.slice();
        openFiles[idx] = {
          ...existing,
          name: title,
          diff: { ...(existing.diff as DiffInfo), originalContent, modifiedContent },
        };
        return { openFiles, activeFilePath: diffPath };
      }

      const file: OpenFile = {
        path: diffPath,
        name: title,
        content: '',
        isDirty: false,
        diff: {
          originalContent,
          modifiedContent,
          filePath,
          staged: false,
          commitHash: hash,
        },
      };
      return { openFiles: [...state.openFiles, file], activeFilePath: diffPath };
    });
  },

  openSearchTab: (seed) => {
    // The probe below only checks currently-OPEN tabs, so a closed id CAN be
    // handed out again — this only guarantees no collision with a LIVE tab,
    // not that ids are never reused. Reuse is safe today only because of a
    // property of `closeSession` (in stores/search.ts, not enforced here):
    // closing a tab always leaves that id's entry either absent from
    // `sessions` or freshly blank (the recreated-default-session case), so a
    // later tab that reuses the id never inherits stale results.
    const used = get().openFiles.filter((f) => f.path.startsWith('search://')).length;
    let n = used + 1;
    while (get().openFiles.some((f) => f.path === `search://${n}`)) n += 1;
    const path = `search://${n}`;

    const search = useSearchStore.getState();
    search.ensureSession(path);
    if (seed?.query !== undefined || seed?.includePattern !== undefined) {
      search.update(path, {
        ...(seed.query !== undefined ? { query: seed.query } : {}),
        ...(seed.includePattern !== undefined ? { includePattern: seed.includePattern } : {}),
      });
    }
    search.setActiveSession(path);

    set((state) => ({
      openFiles: [...state.openFiles, { path, name: 'Search', content: '', isDirty: false }],
      activeFilePath: path,
    }));
    return path;
  },

  refreshTree: async () => {
    const { workspacePath, assetsRootPath, tree: oldTree } = get();
    const rootPath = assetsRootPath ?? workspacePath;
    if (!rootPath) return;
    try {
      const entries = await invoke<FileEntry[]>('read_directory', { path: rootPath });
      // Index existing nodes by path so we can preserve already-loaded subtrees
      // (otherwise every refresh collapses every expanded folder).
      const oldById = new Map<string, TreeNode>();
      const collect = (nodes: TreeNode[]) => {
        for (const n of nodes) {
          oldById.set(n.id, n);
          if (n.children) collect(n.children);
        }
      };
      collect(oldTree);

      const tree = filterEntries(entries, get().extraExcludePatterns).map((e): TreeNode => {
        const existing = oldById.get(e.path);
        return {
          id: e.path,
          name: e.name,
          isDir: e.is_dir,
          ignored: e.ignored,
          children: e.is_dir ? (existing?.children ?? []) : undefined,
        };
      });
      set({ tree });
    } catch (err) {
      console.warn('[Workspace] refreshTree failed:', err);
    }
  },

  createFile: async (parentDir: string, fileName: string) => {
    const fullPath = `${parentDir}/${fileName}`;
    try {
      await invoke('create_file', { path: fullPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error(`Failed to create file: ${msg}`);
      return null;
    }
    await refreshAffectedDirs(get, [parentDir]);
    return fullPath;
  },

  createDirectory: async (parentDir: string, dirName: string) => {
    const fullPath = `${parentDir}/${dirName}`;
    try {
      await invoke('create_directory', { path: fullPath });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify.error(`Failed to create folder: ${msg}`);
      return null;
    }
    await refreshAffectedDirs(get, [parentDir]);
    return fullPath;
  },

  renamePath: async (oldPath: string, newPath: string) => {
    await invoke('rename_path', { oldPath, newPath });
    // Co-rename .meta file in Unity projects, then offer to sync a matching
    // class name (F-2.5).
    if (useProjectContextStore.getState().isUnityProject) {
      await coRenameMeta(oldPath, newPath);
      offerClassRenameSync(oldPath, newPath);
    }
    // Update any open files that match the old path
    const newName = newPath.split('/').pop() || '';
    set((state) => {
      const openFiles = state.openFiles.map((f) => {
        if (f.path === oldPath) {
          return { ...f, path: newPath, name: newName };
        }
        // Handle files inside a renamed directory
        if (f.path.startsWith(oldPath + '/')) {
          const newFilePath = newPath + f.path.slice(oldPath.length);
          return { ...f, path: newFilePath };
        }
        return f;
      });
      const activeFilePath = state.activeFilePath === oldPath
        ? newPath
        : state.activeFilePath?.startsWith(oldPath + '/')
          ? newPath + state.activeFilePath.slice(oldPath.length)
          : state.activeFilePath;
      return { openFiles, activeFilePath };
    });
    await get().refreshTree();
  },

  deletePath: async (path: string) => {
    await invoke('delete_path', { path });
    // Co-delete .meta file in Unity projects
    if (useProjectContextStore.getState().isUnityProject) {
      await coDeleteMeta(path);
    }
    // Close any open files at or under this path
    set((state) => {
      const openFiles = state.openFiles.filter(
        (f) => f.path !== path && !f.path.startsWith(path + '/')
      );
      const activeFilePath = (state.activeFilePath === path || state.activeFilePath?.startsWith(path + '/'))
        ? (openFiles.length > 0 ? openFiles[openFiles.length - 1].path : null)
        : state.activeFilePath;
      return { openFiles, activeFilePath };
    });
    // Same fallback-to-last-remaining-tab shape as closeFile — the newly
    // active tab can be a search:// one, so the search store's active
    // session must follow it here too (see `syncActiveSearchSession`).
    syncActiveSearchSession(get().activeFilePath);
    await get().refreshTree();
  },

  restartLsp: async () => {
    const path = get().workspacePath;
    if (!path) return;
    useUiStore.getState().setLspStatus('starting');
    if (disposeLspProviders) {
      disposeLspProviders();
      disposeLspProviders = null;
    }
    // Stop every running language server, then re-start on demand. The C#
    // server starts immediately because Unity projects need it eagerly;
    // python/ts will lazy-start when the user next opens a file in those
    // languages. Clearing failed-language tracking here gives a missing
    // server one more shot in case the user just installed it.
    await lspManager.stopAll().catch(() => {});
    for (const unsub of lspPushDiagUnsubs.values()) {
      try { unsub(); } catch { /* ignore */ }
    }
    lspPushDiagUnsubs.clear();
    releasePriorLspAttempt();
    resetDocumentVersions();
    lspRestartTimestamps.clear();
    lspFailedLanguages.clear();

    await attemptLspStartFor('csharp', path, csharpSolutionPath);
  },
}));
