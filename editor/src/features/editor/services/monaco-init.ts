import { loader } from '@monaco-editor/react';
import type { Monaco } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import {
  configureTypeScriptDefaults,
  disposeExtraLibs,
} from './monaco-typescript';
import { getMonacoInstance, setMonacoInstance } from '../../../utils/monaco-instance';

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
