import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  localReadOperations,
  localWriteOperations,
  localListOperations,
  localBashOperations,
} from './local-operations';

describe('local operations', () => {
  it('write→read→list→bash roundtrip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-ops-'));
    try {
      await localWriteOperations.mkdir(join(dir, 'sub'));
      await localWriteOperations.writeFile(join(dir, 'sub', 'a.cs'), 'class A {}');
      expect(await localReadOperations.readFile(join(dir, 'sub', 'a.cs'))).toBe('class A {}');
      const all = await localListOperations.scanAll(dir);
      expect(all.some((p) => p.endsWith('a.cs'))).toBe(true);
      const entries = await localListOperations.readDirectory(dir);
      expect(entries).toEqual([{ name: 'sub', isDir: true }]);
      const r = await localBashOperations.exec('echo hi', dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('hi');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
