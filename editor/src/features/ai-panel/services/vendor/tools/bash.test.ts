import { describe, it, expect } from 'bun:test';
import { createBashTool, type BashOperations } from './bash';

const WS = '/ws';

function tool(
  exec: BashOperations['exec'],
  onUncheckpointedChange?: (command: string, reason: string) => void,
) {
  return createBashTool(WS, { operations: { exec }, onUncheckpointedChange });
}

const ok = (stdout = '') => async () => ({ stdout, stderr: '', exitCode: 0 });

async function run(t: ReturnType<typeof tool>, params: unknown): Promise<string> {
  const r = await t.execute('c1', params);
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

// Every write-side guarantee in this app wraps the write/edit tools: checkpoints,
// the compile and analyzer gates, the verified pass. bash has none of them, so a
// clean exit code used to read to the model as "changed and verified".
describe('bash — uncheckpointed change reporting', () => {
  it('warns when the command modified files', async () => {
    const text = await run(tool(ok()), { command: 'rm Assets/A.cs' });
    expect(text).toContain('NOT covered');
    expect(text).toContain('checkpoint');
  });

  it('says nothing extra for a read-only command', async () => {
    const text = await run(tool(ok('a.cs\nb.cs')), { command: 'ls Assets' });
    expect(text).not.toContain('NOT covered');
  });

  it('does not warn when the mutating command failed', async () => {
    const failing: BashOperations['exec'] = async () => ({
      stdout: '',
      stderr: 'no such file',
      exitCode: 1,
    });
    const text = await run(tool(failing), { command: 'rm Assets/Missing.cs' });
    expect(text).not.toContain('NOT covered');
  });

  it('notifies the checkpoint store so the UI can flag the turn', async () => {
    const seen: string[] = [];
    await run(tool(ok(), (command) => seen.push(command)), {
      command: 'sed -i "" "s/a/b/" Assets/A.cs',
    });
    expect(seen).toEqual(['sed -i "" "s/a/b/" Assets/A.cs']);
  });

  it('does not notify for a read-only command', async () => {
    const seen: string[] = [];
    await run(tool(ok(), (c) => seen.push(c)), { command: 'git status' });
    expect(seen).toEqual([]);
  });
});

describe('bash — timeout budget', () => {
  it('defaults to the shared default rather than the old 30s', async () => {
    let seenTimeout: number | undefined;
    const exec: BashOperations['exec'] = async (_c, _d, opts) => {
      seenTimeout = opts?.timeout;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await run(tool(exec), { command: 'ls' });
    expect(seenTimeout).toBe(120_000);
  });

  it('caps a model-supplied timeout below the loop budget, so the backend finishes first', async () => {
    let seenTimeout: number | undefined;
    const exec: BashOperations['exec'] = async (_c, _d, opts) => {
      seenTimeout = opts?.timeout;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    await run(tool(exec), { command: 'ls', timeout: 60 * 60_000 });
    expect(seenTimeout).toBe(14 * 60_000);
  });
});
