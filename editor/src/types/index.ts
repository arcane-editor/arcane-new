export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileEntry[];
  /** Gitignored (git check-ignore semantics); rendered dimmed in the tree. */
  ignored?: boolean;
}

export interface TreeNode {
  id: string; // full path as unique ID
  name: string;
  isDir: boolean;
  children?: TreeNode[];
  /** Gitignored (git check-ignore semantics); rendered dimmed in the tree. */
  ignored?: boolean;
}

export interface DiffInfo {
  originalContent: string;
  modifiedContent: string;
  /** Repo-root-relative path (post-rename, if this entry is a rename). */
  filePath: string;
  staged: boolean;
  /**
   * Pre-rename path, for a renamed entry. Retained on the tab so a live
   * refresh re-reads the HEAD side from the same place the initial open did —
   * otherwise a refresh would silently turn a rename diff back into a
   * whole-file insertion.
   */
  origPath?: string | null;
  /**
   * True when the workspace is a Unity project, this is a Unity asset file
   * (`.unity`/`.prefab`/`.asset`/…), AND `unity.sceneDiff.enabled` was on
   * when the tab was opened — i.e. eligible for the semantic
   * `SceneDiffViewer` instead of the raw Monaco text diff. Computed once at
   * `openDiffTab` time (see `stores/workspace.ts`).
   */
  semanticCandidate?: boolean;
  /**
   * Present only for `diff://commit/<hash>/<relpath>` tabs opened via
   * `openCommitDiffTab` — the commit hash whose changes are being viewed
   * (original = `<hash>^`, modified = `<hash>`). Tabs carrying this field are
   * intentionally excluded from persistence — see `utils/persistence.ts`.
   */
  commitHash?: string;
}

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  isDirty: boolean;
  diff?: DiffInfo;
  /**
   * The file's bytes are not UTF-8, so `content` is empty and stands for
   * nothing. Unity ships binary `.asset` files in every project (TerrainData,
   * XRSettings, lightmaps) and writes them as binary even under Force Text.
   *
   * Every write path MUST refuse this tab: saving the empty buffer would
   * truncate the asset.
   */
  isBinary?: boolean;
  /** Byte length on disk, shown in place of content for a binary file. */
  byteSize?: number;
}

export interface GitLogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/** One changed file within a commit (from `git_show_commit`). */
export interface CommitFileChange {
  path: string;
  /** Same vocabulary as `GitFileStatus.status` ('modified'/'added'/'deleted'/'renamed'/…). */
  status: string;
}

/** Full detail for a single commit — metadata + changed-files list. */
export interface CommitDetail {
  hash: string;
  message: string;
  author: string;
  date: string;
  files: CommitFileChange[];
}

export interface FileContent {
  path: string;
  content: string;
}

export interface Command {
  id: string;
  label: string;
  category: string;
  keybinding?: string;
  /**
   * Additional chords that run the same command, beyond the one `keybinding`
   * advertises. Only `keybinding` is shown in the palette and mirrored in the
   * native menu — these are aliases for the same gesture typed differently.
   *
   * The case this exists for: "Cmd +" is `mod+shift+equal` on a US layout but
   * `mod+equal` is what the unshifted key reports, and react-hotkeys-hook
   * matches shift exactly (`n !== g` in its matcher), so one chord cannot
   * cover both. VS Code binds both for the same reason.
   */
  extraKeybindings?: string[];
  handler: () => void;
  when?: () => boolean;
  // Opt out of bindGlobalShortcutsToMonaco's editor bridge. Use when the
  // keybinding collides with a Monaco default that must stay reachable in
  // the editor: an editor.addCommand keybinding consumes the keystroke
  // unconditionally — `when()` only skips our handler, it cannot hand the
  // key back to Monaco's own keymap.
  skipMonacoBridge?: boolean;
}

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface NotificationAction {
  label: string;
  run: () => void;
}

export interface Notification {
  id: string;
  type: NotificationType;
  message: string;
  createdAt: number;
  actions?: NotificationAction[];
  persistent?: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
  is_locked: boolean;
  is_prunable: boolean;
  is_main: boolean;
}

export interface StashEntry {
  index: number;
  message: string;
  date: string;
}

export interface BlameLine {
  line: number;
  sha: string;
  author: string;
  author_email: string;
  date: string;
  summary: string;
  is_uncommitted: boolean;
}

export interface SettingsSchema {
  'editor.fontSize': number;
  'editor.tabSize': 2 | 4 | 8;
  'editor.wordWrap': 'on' | 'off' | 'wordWrapColumn';
  'editor.minimap': boolean;
  'editor.lineNumbers': 'on' | 'off' | 'relative';
  'editor.cursorBlinking': 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
  'editor.bracketPairColorization': boolean;
  'editor.renderWhitespace': 'none' | 'boundary' | 'selection' | 'all';
  'editor.autoSave': 'off' | 'afterDelay' | 'onFocusChange';
  'editor.autoSaveDelay': number;
  'editor.betterComments': boolean;
  'terminal.fontSize': number;
  'terminal.fontFamily': string;
  'terminal.cursorBlink': boolean;
  'graphify.autoRebuildOnSave': boolean;
  'graphify.rebuildOnCommit': boolean;
  'graphify.suppressFirstOpenToast': boolean;
  'ai.checkpoints.enabled': boolean;
  'ai.escalation.enabled': boolean;
  'ai.memory.enabled': boolean;
  'ai.edits.applyMode': 'approve' | 'auto';
  'ai.edits.alwaysApproveUnityAssets': boolean;
  'ai.inlineSuggestions.enabled': boolean;
  /** Contextual one-time hints. See features/app-shell/services/coach-marks.ts */
  'ui.coachMarks.enabled': boolean;
  'unity.analyzers.enabled': boolean;
  'unity.compileGate.enabled': boolean;
  'unity.lspGate.enabled': boolean;
  'unity.assetGate.enabled': boolean;
  'unity.verifiedPass.enabled': boolean;
  'unity.nearMissDiagnostics.enabled': boolean;
  'unity.rename.formerlySerializedAs': boolean;
  'unity.serializationDiagnostics.enabled': boolean;
  'unity.projectSettingsDiagnostics.enabled': boolean;
  'unity.inputDiagnostics.enabled': boolean;
  'unity.uiDiagnostics.enabled': boolean;
  'unity.uiToolkit.panel': boolean;
  'lsp.solutionWideAnalysis': boolean;
  'unity.asmdef.diagnostics': boolean;
  'unity.bridge.enabled': boolean;
  'unity.bridge.refreshOnSave': boolean;
  'unity.telemetry.enabled': boolean;
  'unity.hierarchyPanel.enabled': boolean;
  'unity.assetViewer.structuredDefault': boolean;
  'unity.scriptableObjects.inspector': boolean;
  'unity.scriptableObjects.browser': boolean;
  'unity.codeLens.scriptableObjectInstances': boolean;
  'unity.sceneDiff.enabled': boolean;
  'unity.codeLens.assetUsages': boolean;
  'unity.templates.enabled': boolean;
  'unity.docs.versionMatchedHover': boolean;
  'unity.explorer.assetsFirst': boolean;
  'unity.explorer.hideMeta': boolean;
  'explorer.autoReveal': boolean;
  /** Workspace paths for which the "open the Unity project root" banner was
   *  dismissed. Settings are global, so this is a list rather than a flag. */
  'project.rootBanner.dismissed': string[];
  'unity.git.metaPairingChecks': boolean;
  'unity.git.yamlMergeIntegration': boolean;
  'unity.testRunner.enabled': boolean;
  'unity.inputHub.enabled': boolean;
  'unity.debugger.enabled': boolean;
  'unity.shader.completions': boolean;
  'unity.packages.manifestIntelligence': boolean;
  'unity.index.enabled': boolean;
  /** Lines of context rendered either side of a match in the search tab. */
  'search.contextLines': number;
  /** Populate a new search from the editor's selection / word under cursor. */
  'search.seedQueryFromCursor': 'selection' | 'always' | 'never';
  /** Lowercase query = case-insensitive; any uppercase = case-sensitive. */
  'search.useSmartcase': boolean;
  /**
   * Window zoom as a *level*, not a scale factor — 0 is unzoomed, each step is
   * one 1.2x multiple. See `features/app-shell/zoom.ts`. Persisted so a zoomed
   * window comes back zoomed, which is what VS Code's `window.zoomLevel` does.
   */
  'window.zoomLevel': number;
  /** Download and install new versions in the background. */
  'updates.autoInstall': boolean;
}

/**
 * Reserved diagnostic source names:
 *   'lsp'              – language server protocol (csharp-ls, tsserver, pyright, …)
 *   'unity-analyzer'   – Unity-specific static analyzers running in-process
 *   'unity-compiler'   – compilation errors forwarded from the Unity Editor bridge
 *   'asmdef'           – assembly-definition graph diagnostics
 *   'unity-packages'   – package manifest / UPM hint diagnostics
 *   'unity-uitoolkit'  – UXML/USS reference + property diagnostics
 */
export type DiagnosticSource =
  | 'lsp'
  | 'unity-analyzer'
  | 'unity-compiler'
  | 'asmdef'
  | 'unity-packages'
  | 'unity-uitoolkit'
  | (string & Record<never, never>); // allow arbitrary strings while keeping the named literals

export interface DiagnosticItem {
  file: string;
  fileName: string;
  line: number;
  col: number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source?: DiagnosticSource;
}

export interface SearchMatch {
  lineNumber: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
  /**
   * UTF-16 offset in the original (pre-trim) line at which `lineContent`
   * begins; `0` unless the backend preview-trimmed a very long line. The true
   * editor column of a match is `lineStart + matchStart`.
   */
  lineStart?: number;
  /** Context lines immediately preceding `lineNumber`, in file order.
   *  Absent when the search ran with zero context. */
  before?: string[];
  /** Context lines immediately following `lineNumber`. */
  after?: string[];
}

export interface FileSearchResult {
  path: string;
  matches: SearchMatch[];
  /**
   * True when this file's match count hit the backend's per-file cap
   * (`maxMatchesPerFile`) — more matches exist but were not returned.
   */
  truncated?: boolean;
}

/**
 * A suggestion pinned to a plan document. The behaviour is documented where
 * the anchoring lives (`markdown-preview/services/note-anchor.ts`, which
 * re-exports this); the SHAPE lives here because `stores/ai.ts` holds these
 * notes and `markdown-preview`'s barrel exports components that read that
 * store. Importing the type across that barrel would close a runtime cycle —
 * store → barrel → PlanDocumentView → store — which is the failure mode
 * CLAUDE.md records for `acp`/`ai-panel`. `types/` imports nothing, so it
 * cannot participate in one.
 */
export interface PlanNote {
  id: string;
  /** The exact text the user selected. */
  quotedText: string;
  /** What they want changed. */
  body: string;
  /** Nearest preceding heading, or the document title. */
  headingPath: string;
  /** False once the quoted text no longer appears in the document. */
  anchored: boolean;
}

/** A checkbox line in a plan's `## Todos` section. */
export interface PlanStep {
  title: string;
  done: boolean;
}
