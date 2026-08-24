import { useEffect, useRef, useState } from 'react';
import MonacoEditor, { DiffEditor } from '@monaco-editor/react';
import type { editor as MonacoEditorNs } from 'monaco-editor';
import { ask } from '@tauri-apps/plugin-dialog';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUiStore, type AssetViewerMode, type DiffViewMode } from '../../../stores/ui';
import { useThemeStore } from '../../../stores/theme';
import { useSettingsStore } from '../../../stores/settings';
import { useProjectContextStore } from '../../../stores/project-context';
import { getPendingNavigation, clearPendingNavigation } from '../../../utils/editor-navigation';
import { ensureMonacoTheme } from '../../theme';
import { WelcomeScreen } from '../../project';
import { registerShaderLanguages } from '../../shader-languages';
import { registerUiToolkit } from '../../uitoolkit';
import { getMonacoLanguageId } from '../../../utils/language-detect';
import { bindGlobalShortcutsToMonaco } from '../services/bind-shortcuts';
import { registerBetterComments } from '../services/better-comments';
import { registerImportLinkProvider } from '../services/import-link-provider';
import { registerDotEnvLanguage } from '../services/dotenv-language';
import { registerUsageHoverProvider } from '../services/usage-hover-provider';
import { registerUnityDocsHover } from '../services/unity-docs-hover';
import { registerBlameHoverProvider, attachGitGutter } from '../../git';
import { PackageCacheBanner, isPackageCachePath } from '../../unity-packages';
import { initUsageCodeLens } from '../../unity-context';
import { initUnityAnalyzers } from '../../unity-analyzers';
import { initUnityCompilerDiagnostics } from '../../unity-compiler';
import {
  AssetViewer,
  isUnityAssetFile,
  InputActionsViewer,
  isInputActionsFile,
  SceneDiffViewer,
} from '../../unity-asset-viewer';
import { attachUnityDecorations } from '../../csharp';
import { initTestCodeLens } from '../../unity-test-runner';
import { attachBreakpointGutter } from '../../debugger';
import { registerInlineSuggestProvider } from '../../inline-suggest';
import { MarkdownPreview, PlanDocumentView, isMarkdownPath, isPlanPath, type PlanNote } from '../../markdown-preview';
import { planController } from '../../ai-panel';
import { SearchResultsTab } from '../../search';
import { fileUri } from '../../lsp';

const detectLanguage = getMonacoLanguageId;

function EditorPanel() {
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);
  const updateFileContent = useWorkspaceStore((s) => s.updateFileContent);
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const monacoThemeId = `app-theme-${activeThemeId}`;

  const editorFontSize = useSettingsStore((s) => s.settings['editor.fontSize']);
  const editorTabSize = useSettingsStore((s) => s.settings['editor.tabSize']);
  const editorWordWrap = useSettingsStore((s) => s.settings['editor.wordWrap']);
  const editorMinimap = useSettingsStore((s) => s.settings['editor.minimap']);
  const editorLineNumbers = useSettingsStore((s) => s.settings['editor.lineNumbers']);
  const editorCursorBlinking = useSettingsStore((s) => s.settings['editor.cursorBlinking']);
  const editorBracketPairColorization = useSettingsStore((s) => s.settings['editor.bracketPairColorization']);
  const editorRenderWhitespace = useSettingsStore((s) => s.settings['editor.renderWhitespace']);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const structuredDefault = useSettingsStore((s) => s.settings['unity.assetViewer.structuredDefault']);
  const assetViewerModeMap = useUiStore((s) => s.assetViewerMode);
  const diffViewModeMap = useUiStore((s) => s.diffViewMode);
  const markdownViewModeMap = useUiStore((s) => s.markdownViewMode);
  // Suggestions live with the open document, not in the .md — the file
  // stays clean because execution re-reads it from disk.
  const [planNotes, setPlanNotes] = useState<PlanNote[]>([]);

  const editorRef = useRef<MonacoEditorNs.IStandaloneCodeEditor | null>(null);

  // Whenever the active file changes, move keyboard focus into the editor
  // so the user can start typing immediately — no click-to-focus required
  // after opening from the explorer, quick-open, or a tab click. If a Go to
  // Definition / navigate-to-line request is pending, also consume it here:
  // the MonacoEditor instance is reused across file switches — it just
  // swaps its underlying model — so `onMount` only fires once, not for
  // subsequent navigations. Without that, cross-file Cmd+Click would land
  // at the top of the target file instead of on the symbol's declaration.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeFilePath) return;
    const nav = getPendingNavigation();
    if (nav) clearPendingNavigation();
    // Defer one frame so the model swap initiated by the path-prop
    // change has actually completed before we move the cursor / focus.
    requestAnimationFrame(() => {
      if (nav) {
        const position = { lineNumber: nav.line, column: nav.column };
        editor.setPosition(position);
        editor.revealPositionInCenter(position);
      }
      editor.focus();
    });
  }, [activeFilePath]);

  useEffect(() => {
    // Keep Monaco theme definition/application in sync with active theme changes.
    // This covers both regular editor and diff editor instances.
    ensureMonacoTheme(useThemeStore.getState().getActiveTheme());
  }, [activeThemeId]);

  useEffect(() => {
    const navHandler = (e: Event) => {
      const { line, column } = (e as CustomEvent).detail;
      const editor = editorRef.current;
      if (editor) {
        const pos = { lineNumber: line, column: column || 1 };
        editor.setPosition(pos);
        editor.revealPositionInCenter(pos);
        editor.focus();
      }
    };
    const formatHandler = () => {
      editorRef.current?.getAction('editor.action.formatDocument')?.run();
    };
    const gotoHandler = () => {
      editorRef.current?.getAction('editor.action.gotoLine')?.run();
    };
    window.addEventListener('navigate-to-line', navHandler);
    window.addEventListener('format-document', formatHandler);
    window.addEventListener('goto-line', gotoHandler);
    return () => {
      window.removeEventListener('navigate-to-line', navHandler);
      window.removeEventListener('format-document', formatHandler);
      window.removeEventListener('goto-line', gotoHandler);
    };
  }, []);

  if (!activeFilePath) {
    return <WelcomeScreen />;
  }

  const activeFile = openFiles.find((f) => f.path === activeFilePath);
  if (!activeFile) {
    return <WelcomeScreen />;
  }

  if (activeFile.path.startsWith('search://')) {
    return <SearchResultsTab sessionId={activeFile.path} />;
  }

  const activeLanguage = detectLanguage(activeFile.name);
  // Must be `fileUri`, not a hand-rolled `file://` + encoded path. On Windows
  // the latter yields `file://D%3A/...`, where the drive is parsed as the URI
  // *authority* — so Monaco's model URI never equals the `file:///D:/...` the
  // language server was told about at didOpen, and every completion, hover and
  // definition asks about a document csharp-ls has never heard of.
  const modelPath = fileUri(activeFile.path);
  const isLargeFile = activeFile.content.length > 1_000_000;

  // Unity YAML assets (+ Input System .inputactions) render in a structured
  // viewer by default (per setting), with per-file "View raw" / "Edit raw"
  // overrides tracked in the ui store.
  const isUnityAsset = isUnityProject && isUnityAssetFile(activeFile.name);
  const isInputActions = isUnityProject && isInputActionsFile(activeFile.name);
  const structuredCandidate = isUnityAsset || isInputActions;
  const assetMode: AssetViewerMode | null = structuredCandidate
    ? assetViewerModeMap[activeFile.path] ?? (structuredDefault ? 'structured' : 'raw-edit')
    : null;
  const monacoReadOnly = isPackageCachePath(activeFile.path) || assetMode === 'raw-view';

  const setRawView = () => useUiStore.getState().setAssetViewerMode(activeFile.path, 'raw-view');
  const setRawEdit = async () => {
    const ok = await ask(
      'Editing this asset by hand can corrupt it and silently break references. Continue?',
      { title: 'Edit Raw', kind: 'warning' },
    );
    if (ok) useUiStore.getState().setAssetViewerMode(activeFile.path, 'raw-edit');
  };

  if (isUnityAsset && assetMode === 'structured') {
    return (
      <AssetViewer
        path={activeFile.path}
        name={activeFile.name}
        onViewRaw={setRawView}
        onEditRaw={setRawEdit}
      />
    );
  }
  if (isInputActions && assetMode === 'structured') {
    return (
      <InputActionsViewer
        name={activeFile.name}
        content={activeFile.content}
        onViewRaw={setRawView}
        onEditRaw={setRawEdit}
      />
    );
  }

  // Markdown renders as a document, not as source. A plan additionally gets
  // its steps, suggestions and execute controls — the reason it opens here
  // rather than in Monaco is that a plan is something you act on, and sending
  // the user to a raw text buffer to do that was the gap.
  //
  // A plan is matched on its PATH, not on being markdown: `.aplan` carries
  // markdown but is not a `.md`, and the legacy `.arcane/plans/*.md` clause in
  // isPlanPath still has to win over the plain-markdown branch below.
  //
  // There is no view-mode gate on this branch. A plan has one mode — the
  // document — and every part of it is edited in place; the Monaco fallback
  // further down is reachable only for files this never claims.
  const isPlainMarkdown =
    isMarkdownPath(activeFile.name) && !activeFile.diff && !isPlanPath(activeFile.path);
  if (isPlanPath(activeFile.path) && !activeFile.diff) {
    return (
      <PlanDocumentView
        path={activeFile.path}
        content={activeFile.content}
        notes={planNotes}
        onNotesChange={setPlanNotes}
        onRevise={() => planController.reviseWithNotes(activeFile.path, planNotes)}
        onExecute={() => planController.executePlan(activeFile.path)}
        onStop={() => planController.abortExecution()}
      />
    );
  }
  if (isPlainMarkdown && (markdownViewModeMap[activeFile.path] ?? 'preview') === 'preview') {
    return (
      <div className="md-preview-standalone">
        <div className="md-preview-toolbar">
          <button
            type="button"
            className="plan-doc-mode"
            onClick={() => useUiStore.getState().setMarkdownViewMode(activeFile.path, 'source')}
          >
            Edit source
          </button>
        </div>
        <MarkdownPreview
          content={activeFile.content}
          notes={[]}
          onNotesChange={() => {}}
          allowNotes={false}
        />
      </div>
    );
  }

  if (activeFile.diff) {
    const diffPath = activeFile.path;
    const diffInfo = activeFile.diff;
    // Unity asset diffs render as a semantic tree by default (tagged at
    // `openDiffTab` time, gated on the `unity.sceneDiff.enabled` setting);
    // per-tab overrides — manual toggle or an automatic SceneDiffViewer
    // fallback — live in the ui store, same pattern as `assetViewerMode`.
    const semanticCandidate = diffInfo.semanticCandidate === true;
    const diffMode: DiffViewMode = diffViewModeMap[diffPath] ?? (semanticCandidate ? 'semantic' : 'text');
    const setDiffMode = (mode: DiffViewMode) => useUiStore.getState().setDiffViewMode(diffPath, mode);

    if (semanticCandidate && diffMode === 'semantic') {
      return (
        <SceneDiffViewer
          filePath={diffInfo.filePath}
          name={activeFile.name}
          staged={diffInfo.staged}
          onViewText={() => setDiffMode('text')}
          onFallback={() => setDiffMode('text')}
        />
      );
    }

    return (
      <div className="editor-container" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {semanticCandidate && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '4px 10px',
              fontSize: 12,
              background: 'var(--bg-sidebar)',
              borderBottom: '1px solid var(--border)',
              color: 'var(--text-secondary)',
              flexShrink: 0,
            }}
          >
            <span>Raw YAML text diff.</span>
            <button className="asset-viewer-btn" style={{ marginLeft: 'auto' }} onClick={() => setDiffMode('semantic')}>
              Semantic View
            </button>
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0 }}>
          <DiffEditor
            height="100%"
            language={detectLanguage(diffInfo.filePath)}
            theme={monacoThemeId}
            original={diffInfo.originalContent}
            modified={diffInfo.modifiedContent}
            beforeMount={(_monaco) => {
              // Pre-register theme so editor.create() doesn't fall back to vs (light).
              ensureMonacoTheme(useThemeStore.getState().getActiveTheme());
            }}
            onMount={(_editor, _monaco) => {
              ensureMonacoTheme(useThemeStore.getState().getActiveTheme());
            }}
            options={{
              readOnly: true,
              renderSideBySide: true,
              automaticLayout: true,
              minimap: { enabled: false },
              overviewRulerLanes: 0,
              overviewRulerBorder: false,
              hideCursorInOverviewRuler: true,
              scrollbar: { useShadows: false },
              fontSize: editorFontSize,
              fontFamily: "'Geist Mono Variable', 'Geist Mono', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, 'Courier New', monospace",
              fontLigatures: true,
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="editor-container">
      <PackageCacheBanner />
      {isPlainMarkdown && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '4px 10px',
            fontSize: 12,
            background: 'var(--bg-sidebar)',
            borderBottom: '1px solid var(--border)',
            color: 'var(--text-secondary)',
            flexShrink: 0,
          }}
        >
          <span>Markdown source</span>
          <button
            className="asset-viewer-btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => useUiStore.getState().setMarkdownViewMode(activeFile.path, 'preview')}
          >
            Preview
          </button>
        </div>
      )}
      {structuredCandidate && assetMode && assetMode !== 'structured' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '4px 10px',
            fontSize: 12,
            background: assetMode === 'raw-edit' ? 'var(--warning-bg, #4d3800)' : 'var(--bg-sidebar)',
            borderBottom: '1px solid var(--border)',
            color: 'var(--text-secondary)',
          }}
        >
          <span>
            {assetMode === 'raw-edit'
              ? '⚠ Editing raw YAML — hand-edits can break this asset.'
              : 'Raw YAML (read-only).'}
          </span>
          <button
            className="asset-viewer-btn"
            style={{ marginLeft: 'auto' }}
            onClick={() => useUiStore.getState().setAssetViewerMode(activeFile.path, 'structured')}
          >
            Structured View
          </button>
        </div>
      )}
      <MonacoEditor
        path={modelPath}
        height="100%"
        language={activeLanguage}
        theme={monacoThemeId}
        value={activeFile.content}
        onChange={(value) => {
          if (value !== undefined) {
            updateFileContent(activeFile.path, value);
          }
        }}
        beforeMount={(monaco) => {
          // Register custom shader languages and theme BEFORE editor.create()
          // so first paint uses the correct theme (otherwise Monaco falls back to vs/light).
          registerShaderLanguages(monaco);
          registerDotEnvLanguage(monaco);
          registerImportLinkProvider(monaco);
          registerUiToolkit(monaco);
          registerBlameHoverProvider(monaco);
          initUsageCodeLens(monaco);
          registerUsageHoverProvider(monaco);
          registerUnityDocsHover(monaco);
          initUnityAnalyzers(monaco);
          initUnityCompilerDiagnostics(monaco);
          initTestCodeLens(monaco);
          registerInlineSuggestProvider(monaco);
          ensureMonacoTheme(useThemeStore.getState().getActiveTheme());
        }}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          // EditorPanel has early-return render paths (AssetViewer,
          // SceneDiffViewer, structured asset viewers) where this
          // MonacoEditor instance unmounts without a new one replacing it.
          // Without this guard, editorRef.current would keep pointing at a
          // disposed editor, which the activeFilePath-focus effect above
          // could then try to call .focus() on.
          editor.onDidDispose(() => {
            if (editorRef.current === editor) editorRef.current = null;
          });

          const boundLanguage = editor.getModel()?.getLanguageId() ?? activeLanguage;
          console.info('[Editor] Monaco language binding', {
            filePath: activeFile.path,
            modelPath,
            requestedLanguage: activeLanguage,
            boundLanguage,
          });

          // Ensure theme is defined and applied for late-loading Monaco
          ensureMonacoTheme(useThemeStore.getState().getActiveTheme());

          // Bridge global shortcuts (Cmd+K, Cmd+J, etc.) into Monaco so they
          // fire while the editor has focus. Without this, react-hotkeys-hook
          // never sees the keys because Monaco swallows them.
          const unbindShortcuts = bindGlobalShortcutsToMonaco(editor, monaco);
          editor.onDidDispose(unbindShortcuts);

          registerBetterComments(editor, monaco);
          // Unity semantic colouring: lifecycle methods, engine types, and
          // Inspector-facing attributes. Self-gates per model on `.cs`, and
          // rebinds on model swap, so it survives file switches.
          attachUnityDecorations(editor, monaco);
          // Debugger breakpoint gutter (Unity projects; self-gates otherwise).
          attachBreakpointGutter(editor, monaco);
          // Git changed-lines gutter (vs HEAD); disposed alongside this
          // editor instance (model swaps on file switch keep it alive and
          // just trigger a refresh — see attachGitGutter's onDidChangeModel
          // hookup).
          const disposeGitGutter = attachGitGutter(editor, monaco);
          editor.onDidDispose(disposeGitGutter);

          // Handle pending Go to Definition navigation
          const nav = getPendingNavigation();
          if (nav) {
            clearPendingNavigation();
            const position = { lineNumber: nav.line, column: nav.column };
            editor.setPosition(position);
            editor.revealPositionInCenter(position);
          }

          // Focus the editor on mount so the very first file opened in a
          // fresh Monaco instance also gets keyboard focus, matching the
          // behavior of subsequent file switches (handled by the
          // activeFilePath effect above).
          editor.focus();

          // Track cursor position for status bar
          editor.onDidChangeCursorPosition((e) => {
            useUiStore.getState().setCursorPosition({
              line: e.position.lineNumber,
              column: e.position.column,
            });
          });

          // Set initial cursor position
          const pos = editor.getPosition();
          if (pos) {
            useUiStore.getState().setCursorPosition({
              line: pos.lineNumber,
              column: pos.column,
            });
          }
        }}
        options={{
          readOnly: monacoReadOnly,
          minimap: { enabled: editorMinimap && !isLargeFile },
          fontSize: editorFontSize,
          fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Monaco, 'Courier New', monospace",
          fontLigatures: !isLargeFile,
          lineNumbers: editorLineNumbers,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          // The decorations overview ruler is the red strip down the right edge.
          // When a project fails to resolve, csharp-ls marks nearly every line,
          // the per-marker ticks merge, and it renders as one solid red bar the
          // full height of the file — alarming, unactionable, and covering the
          // scrollbar. Errors are still reported by the squiggle, the gutter and
          // the Problems panel, which are the surfaces you can actually click.
          overviewRulerLanes: 0,
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            useShadows: false,
          },
          wordWrap: editorWordWrap,
          tabSize: editorTabSize,
          cursorBlinking: editorCursorBlinking,
          bracketPairColorization: { enabled: editorBracketPairColorization && !isLargeFile },
          renderWhitespace: editorRenderWhitespace,
          quickSuggestions: isLargeFile ? false : { other: true, comments: false, strings: false },
          suggestOnTriggerCharacters: !isLargeFile,
          acceptSuggestionOnCommitCharacter: true,
          acceptSuggestionOnEnter: 'on',
          tabCompletion: 'on',
          wordBasedSuggestions: isLargeFile ? 'off' : 'currentDocument',
          parameterHints: { enabled: !isLargeFile },
          snippetSuggestions: 'inline',
          inlineSuggest: { enabled: !isLargeFile },
        }}
      />
    </div>
  );
}

export default EditorPanel;
