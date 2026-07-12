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
  filePath: string;
  staged: boolean;
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
  handler: () => void;
  when?: () => boolean;
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
  'ai.edits.applyMode': 'approve' | 'auto';
  'ai.edits.alwaysApproveUnityAssets': boolean;
  'unity.analyzers.enabled': boolean;
  'unity.compileGate.enabled': boolean;
  'unity.lspGate.enabled': boolean;
  'unity.verifiedPass.enabled': boolean;
  'unity.nearMissDiagnostics.enabled': boolean;
  'unity.rename.formerlySerializedAs': boolean;
  'unity.serializationDiagnostics.enabled': boolean;
  'unity.asmdef.diagnostics': boolean;
  'unity.bridge.enabled': boolean;
  'unity.bridge.refreshOnSave': boolean;
  'unity.telemetry.enabled': boolean;
  'unity.hierarchyPanel.enabled': boolean;
  'unity.assetViewer.structuredDefault': boolean;
  'unity.sceneDiff.enabled': boolean;
  'unity.codeLens.assetUsages': boolean;
  'unity.templates.enabled': boolean;
  'unity.docs.versionMatchedHover': boolean;
  'unity.explorer.assetsFirst': boolean;
  'unity.explorer.hideMeta': boolean;
  'explorer.autoReveal': boolean;
  'unity.git.metaPairingChecks': boolean;
  'unity.git.yamlMergeIntegration': boolean;
  'unity.testRunner.enabled': boolean;
  'unity.debugger.enabled': boolean;
  'unity.shader.completions': boolean;
  'unity.packages.manifestIntelligence': boolean;
  'unity.index.enabled': boolean;
}

/**
 * Reserved diagnostic source names:
 *   'lsp'              – language server protocol (csharp-ls, tsserver, pyright, …)
 *   'unity-analyzer'   – Unity-specific static analyzers running in-process
 *   'unity-compiler'   – compilation errors forwarded from the Unity Editor bridge
 *   'asmdef'           – assembly-definition graph diagnostics
 *   'unity-packages'   – package manifest / UPM hint diagnostics
 */
export type DiagnosticSource =
  | 'lsp'
  | 'unity-analyzer'
  | 'unity-compiler'
  | 'asmdef'
  | 'unity-packages'
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
