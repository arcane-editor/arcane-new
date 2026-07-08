/**
 * Structural self-tests for `TASKS` (`tasks.ts`) — pure, no LLM. Guards
 * against the class of mistakes that are easy to make by hand when growing
 * the suite (duplicate ids, typo'd fixture names, a check kind that doesn't
 * round-trip through `CheckSpec`, an ask-mode task that can never pass
 * because it asserts a file mutation with no write tool available, or an
 * agent-mode codegen task with no file-level check at all).
 */

import { describe, it, expect } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TASKS } from './tasks';
import type { CheckSpec } from './eval-types';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

// Mirrors the `CheckSpec` union in `eval-types.ts` — kept as an explicit list
// (rather than derived) because TS unions don't exist at runtime.
const VALID_CHECK_KINDS: CheckSpec['type'][] = [
  'file_exists',
  'file_contains',
  'file_not_contains',
  'analyzer_clean',
  'answer_matches',
  'answer_not_matches',
  'tool_called',
  'tool_not_called',
];

const FILE_MUTATION_CHECK_KINDS: CheckSpec['type'][] = ['file_exists', 'file_contains', 'file_not_contains'];

describe('TASKS structural integrity', () => {
  it('has every task id unique', () => {
    const ids = TASKS.map((t) => t.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  it('references only fixtures that exist on disk', () => {
    const missing = TASKS.filter((t) => {
      const dir = join(FIXTURES_DIR, t.fixture);
      return !existsSync(dir) || !statSync(dir).isDirectory();
    }).map((t) => `${t.id} -> ${t.fixture}`);
    expect(missing).toEqual([]);
  });

  it('uses only valid CheckSpec kinds', () => {
    const invalid: string[] = [];
    for (const task of TASKS) {
      for (const check of task.checks) {
        if (!VALID_CHECK_KINDS.includes(check.type)) {
          invalid.push(`${task.id}: ${check.type}`);
        }
      }
    }
    expect(invalid).toEqual([]);
  });

  it('gives every task at least one check', () => {
    const empty = TASKS.filter((t) => t.checks.length === 0).map((t) => t.id);
    expect(empty).toEqual([]);
  });

  it('never asserts a file-mutation check on an ask-mode task (ask mode has no write tool)', () => {
    const offenders: string[] = [];
    for (const task of TASKS) {
      if (task.mode !== 'ask') continue;
      for (const check of task.checks) {
        if (FILE_MUTATION_CHECK_KINDS.includes(check.type)) {
          offenders.push(`${task.id}: ${check.type}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every agent-mode codegen task at least one file-level check', () => {
    const offenders: string[] = [];
    for (const task of TASKS) {
      if (task.family !== 'codegen' || task.mode !== 'agent') continue;
      const hasFileCheck = task.checks.some((c) => FILE_MUTATION_CHECK_KINDS.includes(c.type));
      if (!hasFileCheck) offenders.push(task.id);
    }
    expect(offenders).toEqual([]);
  });

  it('has ~24 tasks (grown from the original 12 seed tasks)', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(24);
  });
});
