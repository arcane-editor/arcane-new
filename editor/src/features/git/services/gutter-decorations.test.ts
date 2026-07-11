import { describe, it, expect } from 'bun:test';
import { parseDiffHunks } from './gutter-decorations';

describe('parseDiffHunks', () => {
  it('returns empty ranges for an empty diff', () => {
    expect(parseDiffHunks('')).toEqual({ added: [], modified: [], deletedAt: [] });
  });

  it('parses an add-only hunk into a single added range', () => {
    const diff = [
      'diff --git a/foo.txt b/foo.txt',
      'index 1111111..2222222 100644',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,2 +1,5 @@',
      ' line1',
      '+new1',
      '+new2',
      '+new3',
      ' line2',
      '',
    ].join('\n');

    expect(parseDiffHunks(diff)).toEqual({
      added: [[2, 4]],
      modified: [],
      deletedAt: [],
    });
  });

  it('parses a delete-only hunk into a single deletedAt marker', () => {
    const diff = [
      'diff --git a/foo.txt b/foo.txt',
      'index 1111111..2222222 100644',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1,4 +1,2 @@',
      ' line1',
      '-gone1',
      '-gone2',
      ' line2',
      '',
    ].join('\n');

    expect(parseDiffHunks(diff)).toEqual({
      added: [],
      modified: [],
      deletedAt: [2],
    });
  });

  it('parses a mixed block: paired lines become modified, excess + becomes added', () => {
    // 2 removed, 3 added -> first 2 pair up as modified, 1 excess is added.
    const diff = [
      '@@ -1,3 +1,4 @@',
      ' ctx',
      '-old1',
      '-old2',
      '+new1',
      '+new2',
      '+new3',
      ' ctx2',
      '',
    ].join('\n');

    expect(parseDiffHunks(diff)).toEqual({
      added: [[4, 4]],
      modified: [[2, 3]],
      deletedAt: [],
    });
  });

  it('parses a mixed block: paired lines become modified, excess - becomes deletedAt', () => {
    // 3 removed, 1 added -> first pairs as modified, 2 excess deletions marked
    // right after the modified line.
    const diff = ['@@ -1,4 +1,2 @@', ' ctx', '-old1', '-old2', '-old3', '+new1', ' ctx2', ''].join(
      '\n',
    );

    expect(parseDiffHunks(diff)).toEqual({
      added: [],
      modified: [[2, 2]],
      deletedAt: [3],
    });
  });

  it('handles multiple hunks independently', () => {
    const diff = [
      '@@ -1,2 +1,3 @@',
      ' ctx',
      '+added1',
      ' ctx2',
      '@@ -20,3 +21,2 @@',
      ' ctx3',
      '-removed1',
      ' ctx4',
      '',
    ].join('\n');

    expect(parseDiffHunks(diff)).toEqual({
      added: [[2, 2]],
      modified: [],
      deletedAt: [22],
    });
  });

  it('ignores rename/mode-change header noise with no hunks', () => {
    const diff = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to new.txt',
      '',
    ].join('\n');

    expect(parseDiffHunks(diff)).toEqual({ added: [], modified: [], deletedAt: [] });
  });

  it('ignores "\\ No newline at end of file" markers', () => {
    const diff = ['@@ -1,1 +1,1 @@', '-old last line', '+new last line', '\\ No newline at end of file', ''].join(
      '\n',
    );

    expect(parseDiffHunks(diff)).toEqual({
      added: [],
      modified: [[1, 1]],
      deletedAt: [],
    });
  });

  it('handles a rename with real content changes after the rename header', () => {
    const diff = [
      'diff --git a/old.txt b/new.txt',
      'similarity index 80%',
      'rename from old.txt',
      'rename to new.txt',
      'index 1111111..2222222 100644',
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1,2 +1,2 @@',
      '-hello',
      '+hello world',
      ' unchanged',
      '',
    ].join('\n');

    expect(parseDiffHunks(diff)).toEqual({
      added: [],
      modified: [[1, 1]],
      deletedAt: [],
    });
  });

  it('supports shorthand hunk headers with implicit count of 1', () => {
    const diff = ['@@ -1 +1 @@', '-old', '+new', ''].join('\n');

    expect(parseDiffHunks(diff)).toEqual({
      added: [],
      modified: [[1, 1]],
      deletedAt: [],
    });
  });
});
