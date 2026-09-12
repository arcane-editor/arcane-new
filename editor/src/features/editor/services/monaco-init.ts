import { loader } from '@monaco-editor/react';
import type { Monaco } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import {
  configureTypeScriptDefaults,
  disposeExtraLibs,
} from './monaco-typescript';
import { getMonacoInstance, setMonacoInstance } from '../../../utils/monaco-instance';
import { browserUrlFor, isExternalUrl, openExternal } from '../../../utils/external-link';

let loaderConfigured = false;

function ensureLoaderConfigured(): void {
  if (loaderConfigured) return;
  // Force @monaco-editor/react loader to use bundled Monaco instead of CDN.
  // Prevents external loader sourcemap 404 noise and keeps startup offline-safe.
  loader.config({ monaco });
  loaderConfigured = true;
}

export async function initMonaco(): Promise<Monaco> {
  const existing = getMonacoInstance();
  if (existing) return existing;
  ensureLoaderConfigured();
  const monacoInstance = await loader.init();
  setMonacoInstance(monacoInstance);

  // A URL in a comment is a link Monaco detects and opens itself, through its
  // own opener service — it never becomes a DOM anchor, so the document-level
  // handler in main.tsx cannot see it. Standalone Monaco's default opener is
  // `window.open`, which does nothing in a webview.
  //
  // Returning false for anything else is what leaves `file:` links to
  // `registerEditorOpener` (cross-file Go to Definition, providers.ts).
  monacoInstance.editor.registerLinkOpener({
    open(resource) {
      // `browserUrlFor`, never the Uri's own default spelling — see the
      // note on that function:
      // Monaco's default spelling percent-escapes `=` and `&`, which turns
      // every query string into one key by the time it reaches the browser.
      const url = browserUrlFor(resource);
      if (!isExternalUrl(url)) return false;
      void openExternal(url);
      return true;
    },
  });

  // Disable Monaco's built-in TypeScript semantic + suggestion diagnostics
  // immediately on Monaco init. Without this, Monaco's bundled TS worker
  // (which has no knowledge of the user's tsconfig or node_modules) emits
  // its own "Cannot find module" / "X is unused" errors that overlap the
  // real LSP diagnostics. Syntax validation stays on — it's fast and
  // doesn't need project context.
  configureTypeScriptDefaults(monacoInstance);

  return monacoInstance;
}

export function getMonaco(): Monaco | null {
  return getMonacoInstance();
}

export async function setupWorkspaceIntelliSense(
  _workspacePath: string,
  tsConfig: Record<string, unknown> | null,
): Promise<void> {
  const monaco = await initMonaco();

  // Configure compiler options for syntax validation only.
  // The LSP server handles all IntelliSense (completions, hover, diagnostics).
  // We intentionally do NOT load workspace files or node_modules types into
  // Monaco's TS worker — doing so loads thousands of files on the main thread
  // and can crash the webview with OOM.
  configureTypeScriptDefaults(monaco, tsConfig ?? undefined);
}

export function teardownWorkspaceIntelliSense(): void {
  disposeExtraLibs();
}
