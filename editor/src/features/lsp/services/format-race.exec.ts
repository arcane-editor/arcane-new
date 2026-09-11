import { it, expect, mock } from 'bun:test';
mock.module('../../../features/lsp/services/manager.ts', () => ({ lspManager: {} }));
const { setMonacoInstance } = await import('../../../utils/monaco-instance.ts');
const { formatDocumentBeforeSave } = await import('../../../features/lsp/services/format-on-save.ts');
it('formatting discards a response when the model version advances', async () => {
  const original = 'class A{int x;}';
  let text = original, version = 1, applyCount = 0;
  const model = {
    uri: { path: '/ws/A.cs' }, isDisposed: () => false,
    getOptions: () => ({ tabSize: 4, insertSpaces: true }), getVersionId: () => version,
    getValue: () => text,
    pushEditOperations: (_: any, edits: any[]) => { applyCount++; for (const e of edits) { text = text.slice(0,e.range.startColumn-1) + e.text + text.slice(e.range.endColumn-1); } },
  };
  setMonacoInstance({ editor: { getModel: () => model }, Uri: { parse: (s: string) => s } } as any);
  let complete!: (edits: any) => void;
  const client = { request: () => new Promise(resolve => { complete=resolve; }) };
  const pending = formatDocumentBeforeSave(client as any, '/ws/A.cs');
  text='class A{int y;}'; version++;
  complete([{ range: { start: {line:0,character:0}, end: {line:0,character:original.length} }, newText:'class A { int x; }' }]);
  const result = await pending;
  expect(applyCount).toBe(0); expect(result).toBeNull(); expect(text).toBe('class A{int y;}');

});
