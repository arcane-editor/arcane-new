import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dir, '../../..');
// document-sync.ts owns the canonical implementation; its own tests cover it.
const CANONICAL = path.join(SRC, 'features/lsp/services/document-sync.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full) && !/\.test\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * A document URI is built in one place, `fileUri()`, and read back by
 * `pathFromFileUri()`. Both handle the three shapes that matter: POSIX, a
 * Windows drive path, and UNC.
 *
 * Hand-rolling one is not a style problem, it is a correctness problem, and it
 * only shows up on Windows. `file://` + `D:/Unity/Game/Player.cs` parses with
 * `D:` as the URI *authority*, so Monaco's model URI
 * (`file://D%3A/Unity/...`) never equals the URI csharp-ls was told about at
 * didOpen (`file:///D:/Unity/...`). Every completion, hover and go-to-definition
 * then asks about a document the server has never heard of and returns nothing,
 * while the client re-sends the whole file on each attempt because the model
 * URI can never enter the open set.
 *
 * EditorPanel and TabBar each rolled their own. This keeps that from coming
 * back anywhere in the tree.
 */
describe('file:// URI construction', () => {
  it('is not hand-rolled outside document-sync.ts', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === CANONICAL) continue;
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        // A template literal or concatenation that produces a file:// URI.
        // Comparisons (`startsWith('file://')`) and comments are not builders.
        if (/`file:\/\/\$\{|['"]file:\/\/['"]\s*\+/.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
