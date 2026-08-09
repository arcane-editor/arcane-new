import { describe, it, expect } from 'bun:test';
import { parseRustCommands, parseInvokeCalls, checkAll } from './check-invoke-args.mjs';

describe('parseRustCommands', () => {
  it('records required and optional params, skipping Tauri-injected ones', () => {
    const src = `
#[tauri::command]
pub fn fuzzy_search_files(
    state: tauri::State<'_, file_index::FileIndexState>,
    window: tauri::Window,
    workspace_path: String,
    query: String,
    max_results: usize,
    extra_excludes: Vec<String>,
    file_extensions: Option<Vec<String>>,
) -> Result<Vec<FuzzyFileResult>, String> {}
`;
    const cmds = parseRustCommands(src);
    expect(cmds.get('fuzzy_search_files')).toEqual({
      required: ['workspacePath', 'query', 'maxResults', 'extraExcludes'],
      optional: ['fileExtensions'],
    });
  });

  it('handles a single-line signature', () => {
    const src = `#[tauri::command]\nfn read_file(path: String) -> Result<String, String> {}`;
    expect(parseRustCommands(src).get('read_file')).toEqual({ required: ['path'], optional: [] });
  });

  it('handles async commands and a leading pub(crate)', () => {
    const src = `#[tauri::command]\npub async fn start_search(app: tauri::AppHandle, search_id: u64) -> Result<(), String> {}`;
    expect(parseRustCommands(src).get('start_search')).toEqual({
      required: ['searchId'],
      optional: [],
    });
  });

  it('does not split generic type arguments at their commas', () => {
    const src = `#[tauri::command]\nfn f(a: HashMap<String, Vec<u8>>, b: u32) -> Result<(), String> {}`;
    expect(parseRustCommands(src).get('f')).toEqual({ required: ['a', 'b'], optional: [] });
  });
});

describe('parseInvokeCalls', () => {
  it('extracts keys from an object literal', () => {
    const src = `await invoke<Foo[]>('fuzzy_search_files', { workspacePath: ws, query: type, limit: 20, fileExtensions: ['cs'] });`;
    const calls = parseInvokeCalls(src, 'a.ts');
    expect(calls[0].command).toBe('fuzzy_search_files');
    expect(calls[0].keys.sort()).toEqual(['fileExtensions', 'limit', 'query', 'workspacePath']);
    expect(calls[0].checked).toBe(true);
  });

  it('marks a non-literal payload as unchecked rather than passing it', () => {
    const src = `await invoke('start_content_search', payload);`;
    const calls = parseInvokeCalls(src, 'a.ts');
    expect(calls[0].checked).toBe(false);
  });

  it('ignores keys nested inside a sub-object', () => {
    const src = `invoke('start_content_search', { searchId: gen, options: { query, isRegex: false } });`;
    const calls = parseInvokeCalls(src, 'a.ts');
    expect(calls[0].keys.sort()).toEqual(['options', 'searchId']);
  });

  it('handles shorthand properties and a no-argument call', () => {
    const src = `invoke('a', { path });\ninvoke('b');`;
    const calls = parseInvokeCalls(src, 'a.ts');
    expect(calls[0].keys).toEqual(['path']);
    expect(calls[1].command).toBe('b');
    expect(calls[1].keys).toEqual([]);
    expect(calls[1].checked).toBe(true);
  });

  it('does not mistake a colon inside a string value for a key separator', () => {
    const src = `invoke('a', { url: 'http://x/y', name: "k:v" });`;
    const calls = parseInvokeCalls(src, 'a.ts');
    expect(calls[0].keys.sort()).toEqual(['name', 'url']);
  });

  it('reports the line number of the call', () => {
    const src = `const x = 1;\n\ninvoke('a', { p: 1 });`;
    expect(parseInvokeCalls(src, 'a.ts')[0].line).toBe(3);
  });
});

describe('checkAll', () => {
  const rust = `
#[tauri::command]
pub fn fuzzy_search_files(workspace_path: String, query: String, max_results: usize, extra_excludes: Vec<String>, file_extensions: Option<Vec<String>>) -> Result<(), String> {}
`;

  it('reports a missing required argument and an unknown key', () => {
    const ts = `invoke('fuzzy_search_files', { workspacePath: ws, query: q, limit: 20 });`;
    const { violations } = checkAll({
      rustSources: [{ file: 'file_scanner.rs', text: rust }],
      tsSources: [{ file: 'open-script.ts', text: ts }],
    });
    const missing = violations.find((v) => v.kind === 'missing');
    expect(missing.missing.sort()).toEqual(['extraExcludes', 'maxResults']);
    const unknown = violations.find((v) => v.kind === 'unknown');
    expect(unknown.unknown).toEqual(['limit']);
  });

  it('passes a correct call', () => {
    const ts = `invoke('fuzzy_search_files', { workspacePath: ws, query: q, maxResults: 100, extraExcludes: [] });`;
    const { violations } = checkAll({
      rustSources: [{ file: 'file_scanner.rs', text: rust }],
      tsSources: [{ file: 'PaletteModal.tsx', text: ts }],
    });
    expect(violations).toEqual([]);
  });

  it('allows an optional argument to be omitted', () => {
    const ts = `invoke('fuzzy_search_files', { workspacePath: ws, query: q, maxResults: 1, extraExcludes: [] });`;
    const { violations } = checkAll({
      rustSources: [{ file: 'f.rs', text: rust }],
      tsSources: [{ file: 'a.ts', text: ts }],
    });
    expect(violations).toEqual([]);
  });

  it('counts a non-literal payload as unchecked, not as a pass', () => {
    const ts = `invoke('fuzzy_search_files', payload);`;
    const { violations, unchecked } = checkAll({
      rustSources: [{ file: 'f.rs', text: rust }],
      tsSources: [{ file: 'a.ts', text: ts }],
    });
    expect(violations).toEqual([]);
    expect(unchecked.length).toBe(1);
  });

  it('reports an invoke naming a command that does not exist', () => {
    const ts = `invoke('no_such_command', { a: 1 });`;
    const { violations } = checkAll({
      rustSources: [{ file: 'f.rs', text: rust }],
      tsSources: [{ file: 'a.ts', text: ts }],
    });
    expect(violations[0].kind).toBe('no-such-command');
  });
});
