import type { Monaco } from '@monaco-editor/react';
import { invoke } from '@tauri-apps/api/core';
import type { FileContent } from '../../../types';

/**
 * Maps tsconfig.json string values to Monaco's numeric enum values.
 * tsconfig.json uses strings like "react-jsx", "esnext", "nodenext" etc.
 * Monaco's API uses numeric enums.
 */
function mapTsConfigToMonaco(
  tsCompilerOptions: Record<string, unknown>,
  ts: Monaco['languages']['typescript'],
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};

  // Map target
  const targetMap: Record<string, number> = {
    es3: ts.ScriptTarget.ES3,
    es5: ts.ScriptTarget.ES5,
    es2015: ts.ScriptTarget.ES2015,
    es2016: ts.ScriptTarget.ES2016,
    es2017: ts.ScriptTarget.ES2017,
    es2018: ts.ScriptTarget.ES2018,
    es2019: ts.ScriptTarget.ES2019,
    es2020: ts.ScriptTarget.ES2020,
    esnext: ts.ScriptTarget.ESNext,
  };
  if (typeof tsCompilerOptions.target === 'string') {
    const t = targetMap[tsCompilerOptions.target.toLowerCase()];
    if (t !== undefined) mapped.target = t;
  }

  // Map module
  const moduleMap: Record<string, number> = {
    none: ts.ModuleKind.None,
    commonjs: ts.ModuleKind.CommonJS,
    amd: ts.ModuleKind.AMD,
    umd: ts.ModuleKind.UMD,
    system: ts.ModuleKind.System,
    es2015: ts.ModuleKind.ES2015,
    esnext: ts.ModuleKind.ESNext,
  };
  if (typeof tsCompilerOptions.module === 'string') {
    const m = moduleMap[tsCompilerOptions.module.toLowerCase()];
    if (m !== undefined) mapped.module = m;
  }

  // Map moduleResolution — Monaco only has Classic and NodeJs
  const moduleResolutionMap: Record<string, number> = {
    classic: ts.ModuleResolutionKind.Classic,
    node: ts.ModuleResolutionKind.NodeJs,
    node10: ts.ModuleResolutionKind.NodeJs,
    node16: ts.ModuleResolutionKind.NodeJs,
    nodenext: ts.ModuleResolutionKind.NodeJs,
    bundler: ts.ModuleResolutionKind.NodeJs,
  };
  if (typeof tsCompilerOptions.moduleResolution === 'string') {
    const mr = moduleResolutionMap[tsCompilerOptions.moduleResolution.toLowerCase()];
    if (mr !== undefined) mapped.moduleResolution = mr;
  }

  // Map jsx
  const jsxMap: Record<string, number> = {
    preserve: ts.JsxEmit.Preserve,
    react: ts.JsxEmit.React,
    'react-native': ts.JsxEmit.ReactNative,
    'react-jsx': ts.JsxEmit.ReactJSX,
    'react-jsxdev': ts.JsxEmit.ReactJSXDev,
  };
  if (typeof tsCompilerOptions.jsx === 'string') {
    const j = jsxMap[tsCompilerOptions.jsx.toLowerCase()];
    if (j !== undefined) mapped.jsx = j;
  }

  // Copy boolean/string fields directly
  const directFields = [
    'strict', 'noImplicitAny', 'strictNullChecks', 'strictFunctionTypes',
    'strictBindCallApply', 'strictPropertyInitialization', 'noImplicitThis',
    'alwaysStrict', 'noUnusedLocals', 'noUnusedParameters',
    'noImplicitReturns', 'noFallthroughCasesInSwitch', 'allowJs',
    'checkJs', 'declaration', 'declarationMap', 'sourceMap',
    'skipLibCheck', 'esModuleInterop', 'allowSyntheticDefaultImports',
    'resolveJsonModule', 'isolatedModules', 'noEmit',
    'baseUrl', 'paths', 'allowNonTsExtensions',
  ];

  for (const field of directFields) {
    if (tsCompilerOptions[field] !== undefined) {
      mapped[field] = tsCompilerOptions[field];
    }
  }

  return mapped;
}

export function configureTypeScriptDefaults(
  monaco: Monaco,
  workspaceTsConfig?: Record<string, unknown>,
): void {
  const ts = monaco.languages.typescript;

  // Sensible defaults for a modern React + Vite project
  const compilerOptions: Record<string, unknown> = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    isolatedModules: true,
    noEmit: true,
    allowNonTsExtensions: true,
  };

  // If workspace has a tsconfig.json, overlay its compilerOptions
  if (workspaceTsConfig?.compilerOptions) {
    Object.assign(
      compilerOptions,
      mapTsConfigToMonaco(
        workspaceTsConfig.compilerOptions as Record<string, unknown>,
        ts,
      ),
    );
  }

  ts.typescriptDefaults.setCompilerOptions(compilerOptions as any);
  ts.javascriptDefaults.setCompilerOptions(compilerOptions as any);

  // Enable eager model sync so all open models are available to the worker
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.javascriptDefaults.setEagerModelSync(true);

  // Disable semantic diagnostics — the LSP server handles all diagnostics.
  // Keep syntax validation (fast, no project context needed).
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
  });
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: true,
  });
}

// Track disposables for cleanup
let extraLibDisposables: { dispose(): void }[] = [];

export async function loadWorkspaceFiles(
  monaco: Monaco,
  workspacePath: string,
): Promise<void> {
  const ts = monaco.languages.typescript;

  // Scan workspace for source files
  const filePaths = await invoke<string[]>('scan_workspace_files', {
    path: workspacePath,
  });

  // Batch-read in chunks to avoid overwhelming IPC
  const CHUNK_SIZE = 50;
  for (let i = 0; i < filePaths.length; i += CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + CHUNK_SIZE);
    const files = await invoke<FileContent[]>('read_files_bulk', {
      paths: chunk,
    });

    for (const file of files) {
      const uri = `file://${file.path}`;
      const disposable = ts.typescriptDefaults.addExtraLib(file.content, uri);
      extraLibDisposables.push(disposable);
    }
  }
}

export async function loadTypeDefinitions(
  monaco: Monaco,
  workspacePath: string,
): Promise<void> {
  const ts = monaco.languages.typescript;

  // Scan ALL .d.ts files in node_modules (like VS Code does)
  const typePaths = await invoke<string[]>('scan_node_modules_types', {
    workspacePath,
  });

  // Batch-read in chunks
  const CHUNK_SIZE = 100;
  for (let i = 0; i < typePaths.length; i += CHUNK_SIZE) {
    const chunk = typePaths.slice(i, i + CHUNK_SIZE);
    const files = await invoke<FileContent[]>('read_files_bulk', {
      paths: chunk,
    });

    for (const file of files) {
      const uri = `file://${file.path}`;
      const disposable = ts.typescriptDefaults.addExtraLib(file.content, uri);
      extraLibDisposables.push(disposable);
    }
  }
}

export function updateExtraLib(
  monaco: Monaco,
  filePath: string,
  content: string,
): void {
  const ts = monaco.languages.typescript;
  const uri = `file://${filePath}`;
  // addExtraLib with the same URI replaces the previous entry
  ts.typescriptDefaults.addExtraLib(content, uri);
}

export function disposeExtraLibs(): void {
  for (const d of extraLibDisposables) {
    d.dispose();
  }
  extraLibDisposables = [];
}
