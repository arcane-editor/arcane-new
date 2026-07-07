/**
 * node:fs / child_process implementations of the vendor tool operation
 * interfaces — lets the eval drive the REAL agent tools without Tauri.
 */

import { readFile, writeFile, access, mkdir, readdir } from 'node:fs/promises';
import { exec as cpExec } from 'node:child_process';
import { join } from 'node:path';
import type { ReadOperations } from '../../src/features/ai-panel/services/vendor/tools/read';
import type { WriteOperations } from '../../src/features/ai-panel/services/vendor/tools/write';
import type { EditOperations } from '../../src/features/ai-panel/services/vendor/tools/edit';
import type { BashOperations } from '../../src/features/ai-panel/services/vendor/tools/bash';
import type { ListOperations } from '../../src/features/ai-panel/services/vendor/tools/list';

export const localReadOperations: ReadOperations = {
  readFile: (p) => readFile(p, 'utf8'),
  access: (p) => access(p),
};

export const localWriteOperations: WriteOperations = {
  writeFile: (p, content) => writeFile(p, content, 'utf8'),
  mkdir: (p) => mkdir(p, { recursive: true }).then(() => undefined),
};

export const localEditOperations: EditOperations = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, content) => writeFile(p, content, 'utf8'),
  access: (p) => access(p),
};

export const localBashOperations: BashOperations = {
  exec: (command, cwd, options) =>
    new Promise((resolve) => {
      cpExec(
        command,
        { cwd, timeout: options?.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            stdout: String(stdout),
            stderr: String(stderr),
            exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          });
        },
      );
    }),
};

async function scanAllRec(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await scanAllRec(p, out);
    else out.push(p);
  }
}

export const localListOperations: ListOperations = {
  scanAll: async (p) => {
    const out: string[] = [];
    await scanAllRec(p, out);
    return out;
  },
  readDirectory: async (p) => {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  },
};
