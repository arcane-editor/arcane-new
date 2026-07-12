import { describe, expect, test } from 'bun:test';
import { isIgnoreFile } from './ignore-file';

describe('isIgnoreFile', () => {
  test('matches .gitignore and .ignore by basename anywhere in the tree', () => {
    expect(isIgnoreFile('/ws/.gitignore')).toBe(true);
    expect(isIgnoreFile('/ws/packages/app/.gitignore')).toBe(true);
    expect(isIgnoreFile('/ws/.ignore')).toBe(true);
  });

  test('does not match other files, including lookalikes', () => {
    expect(isIgnoreFile('/ws/src/main.ts')).toBe(false);
    expect(isIgnoreFile('/ws/gitignore')).toBe(false);
    expect(isIgnoreFile('/ws/.gitignore.bak')).toBe(false);
    expect(isIgnoreFile('/ws/.eslintignore')).toBe(false);
  });
});
