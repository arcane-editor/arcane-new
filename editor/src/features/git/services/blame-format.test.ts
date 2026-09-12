import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  blamePadding,
  formatBlameHover,
  formatInlineBlame,
  shouldShowBlame,
} from './blame-format';
import type { BlameLine } from '../../../types';

const ROOT = path.resolve(import.meta.dir, '../../..');

const line = (over: Partial<BlameLine> = {}): BlameLine => ({
  line: 1,
  sha: '9c1e4f27a0b3d5e6f70819a2b3c4d5e6f7081920',
  author: 'Sourav Das',
  author_email: 'sourav@example.com',
  date: '2026-08-01T10:00:00Z',
  summary: 'Add the cohort import path',
  is_uncommitted: false,
  ...over,
});

describe('formatInlineBlame', () => {
  it('leads with the author, then when, then what', () => {
    const text = formatInlineBlame(line());
    expect(text.startsWith('Sourav Das, ')).toBe(true);
    expect(text.endsWith(' · Add the cohort import path')).toBe(true);
  });

  it('drops the separator when there is no commit subject', () => {
    expect(formatInlineBlame(line({ summary: '' }))).not.toContain('·');
  });

  it('says so plainly when the line is not committed yet', () => {
    expect(formatInlineBlame(line({ is_uncommitted: true }))).toBe('Uncommitted');
  });

  it('truncates a subject that is really a commit body', () => {
    const text = formatInlineBlame(line({ summary: 'x'.repeat(200) }));
    const subject = text.slice(text.indexOf('· ') + 2);
    expect(subject.length).toBeLessThanOrEqual(60);
    expect(subject.endsWith('…')).toBe(true);
  });

  it('never renders an empty author as an empty run of text', () => {
    expect(formatInlineBlame(line({ author: '', summary: '', date: '' }))).toBe('Unknown');
  });
});

describe('formatBlameHover', () => {
  it('carries the full commit — the detail the hint had to drop', () => {
    const md = formatBlameHover(line());
    expect(md).toContain('**Sourav Das**');
    expect(md).toContain('sourav@example.com');
    expect(md).toContain('Add the cohort import path');
    // Short sha, not the full 40.
    expect(md).toContain('`9c1e4f2`');
    expect(md).not.toContain(line().sha);
  });

  it('explains an uncommitted line rather than showing a blank commit', () => {
    const md = formatBlameHover(line({ is_uncommitted: true }));
    expect(md).toContain('Uncommitted changes');
    expect(md).not.toContain('`');
  });
});

describe('shouldShowBlame', () => {
  it('skips a blank line — a lone hint there reads as content', () => {
    expect(shouldShowBlame('')).toBe(false);
    expect(shouldShowBlame('    \t ')).toBe(false);
  });

  it('shows on any line with code on it', () => {
    expect(shouldShowBlame('  transform.position = Vector3.zero;')).toBe(true);
    expect(shouldShowBlame('}')).toBe(true);
  });
});

describe('blamePadding', () => {
  it('holds a floor so the hint never crowds a long line', () => {
    expect(blamePadding(120)).toBe(6);
  });

  it('pushes out to a minimum column so short lines align', () => {
    expect(blamePadding(0)).toBe(24);
    expect(blamePadding(10)).toBe(14);
  });

  it('crosses over at the column where the floor takes back over', () => {
    expect(blamePadding(18)).toBe(6);
    expect(blamePadding(17)).toBe(7);
  });
});

/**
 * Blame is a property of a LINE; a hover provider answers about a SYMBOL.
 * Registering it as one put "who touched this" into the same popover as the
 * language server's signature, the Unity docs and the usage count — four
 * answers to a question that asked for one.
 */
describe('blame is no longer a hover provider', () => {
  it('registers no blame hover provider anywhere', () => {
    const panel = readFileSync(
      path.join(ROOT, 'features/editor/components/EditorPanel.tsx'),
      'utf8',
    );
    expect(panel).not.toMatch(/registerBlameHoverProvider/);
    expect(panel).toMatch(/attachInlineBlame\(editor, monaco\)/);
  });

  it('exports the inline attachment, not the old provider', () => {
    const barrel = readFileSync(path.join(ROOT, 'features/git/index.ts'), 'utf8');
    expect(barrel).toMatch(/attachInlineBlame/);
    expect(barrel).not.toMatch(/registerBlameHoverProvider/);
  });

  it('disposes with the editor rather than leaking a listener per file switch', () => {
    const panel = readFileSync(
      path.join(ROOT, 'features/editor/components/EditorPanel.tsx'),
      'utf8',
    );
    expect(panel).toMatch(/editor\.onDidDispose\(disposeInlineBlame\)/);
  });
});
