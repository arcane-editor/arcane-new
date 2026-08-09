import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const STORE = readFileSync(path.resolve(import.meta.dir, 'search.ts'), 'utf8');

/**
 * Workspace search in a Unity project was hard-limited to `.cs`, and the
 * backend ANDs `fileExtensions` with the include glob — so typing `*.shader`
 * into "files to include" could never re-admit a non-.cs file. Shaders,
 * .asmdef, .uxml, StreamingAssets JSON and component names inside .prefab /
 * .unity YAML were all unsearchable, and the panel simply said
 * "No results found" with nothing in the UI explaining why.
 */
describe('content search scope', () => {
  it('does not hardcode a .cs-only extension filter for Unity projects', () => {
    expect(STORE).not.toMatch(/fileExtensions:\s*isUnity\s*\?\s*\['cs'\]/);
  });

  it('passes no extension filter, leaving scope to the user-facing globs', () => {
    expect(STORE).toMatch(/fileExtensions:\s*null/);
  });
});
