import type { Monaco } from '@monaco-editor/react';

let monacoInstance: Monaco | null = null;

export function setMonacoInstance(monaco: Monaco): void {
  monacoInstance = monaco;
}

export function getMonacoInstance(): Monaco | null {
  return monacoInstance;
}
