import { describe, expect, it } from 'bun:test';
import { buildFileAttachment, relPathOf, isAlreadyStaged } from './stage-file';
import type { Attachment } from './types';

describe('relPathOf', () => {
  it('strips the workspace prefix', () => {
    expect(relPathOf('/w/src/index.ts', '/w')).toBe('src/index.ts');
  });

  it('leaves a path outside the workspace absolute', () => {
    // Dropping a file from elsewhere on disk still needs an identifying label.
    expect(relPathOf('/other/thing.ts', '/w')).toBe('/other/thing.ts');
  });

  it('handles a missing workspace', () => {
    expect(relPathOf('/w/src/index.ts', null)).toBe('/w/src/index.ts');
  });

  it('does not treat a sibling directory with a shared prefix as inside', () => {
    // `/workspace-old` must not be read as living under `/workspace`.
    expect(relPathOf('/workspace-old/a.ts', '/workspace')).toBe('/workspace-old/a.ts');
  });
});

describe('buildFileAttachment', () => {
  it('produces a file attachment matching the mention path shape', () => {
    const a = buildFileAttachment('/w/src/index.ts', '/w');
    expect(a.kind).toBe('file');
    expect(a.path).toBe('/w/src/index.ts');
    expect(a.relPath).toBe('src/index.ts');
    expect(a.bytes).toBe(0);
    expect(a.id).toStartWith('att_');
  });

  it('gives each attachment a distinct id', () => {
    const a = buildFileAttachment('/w/a.ts', '/w');
    const b = buildFileAttachment('/w/a.ts', '/w');
    expect(a.id).not.toBe(b.id);
  });
});

describe('isAlreadyStaged', () => {
  const staged: Attachment[] = [
    { kind: 'file', id: 'att_1', path: '/w/a.ts', relPath: 'a.ts', bytes: 0 },
    { kind: 'image', id: 'att_2', dataUrl: 'data:,', mimeType: 'image/png', sourceLabel: 'x' },
  ];

  it('detects a file already staged, so a repeat drop is a no-op', () => {
    expect(isAlreadyStaged(staged, '/w/a.ts')).toBe(true);
  });

  it('returns false for a file not yet staged', () => {
    expect(isAlreadyStaged(staged, '/w/b.ts')).toBe(false);
  });

  it('ignores non-file attachments when matching', () => {
    expect(isAlreadyStaged(staged, 'data:,')).toBe(false);
  });

  it('handles an empty staging area', () => {
    expect(isAlreadyStaged([], '/w/a.ts')).toBe(false);
  });
});
