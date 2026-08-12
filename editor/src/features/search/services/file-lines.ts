import { invoke } from '@tauri-apps/api/core';

/** Splits file content into lines with terminators removed. A trailing
 *  newline does NOT produce a final empty line — line N of a file with N
 *  lines must be the last element. */
export function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Expansion re-reads the same file repeatedly as the user opens context on
// several excerpts; the cache is dropped whenever a new search starts, so it
// can never serve lines from a file that changed between searches.
const cache = new Map<string, string[]>();

export async function readFileLines(path: string): Promise<string[]> {
  const cached = cache.get(path);
  if (cached) return cached;
  const content = await invoke<string>('read_file', { path });
  const lines = splitLines(content);
  cache.set(path, lines);
  return lines;
}

export function clearFileLineCache(): void {
  cache.clear();
}
