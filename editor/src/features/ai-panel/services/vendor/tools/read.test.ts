import { describe, it, expect } from 'bun:test';
import { createReadTool, type ReadOperations } from './read';

const CWD = '/ws';

function tool(ops: Partial<ReadOperations>) {
  return createReadTool(CWD, {
    operations: {
      access: async () => {},
      readFile: async () => '',
      ...ops,
    },
  });
}

async function run(t: ReturnType<typeof tool>, params: unknown): Promise<string> {
  const r = await t.execute('call-1', params);
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('read — a binary file is not "not found"', () => {
  // `access` used to be implemented as a full `read_file`, so a non-UTF-8 file
  // failed the existence probe and the tool answered "File not found". The model
  // concludes the file does not exist, and in a Unity project the next move is
  // often to CREATE it — overwriting a .png/.fbx/.asset with source text.
  it('reports a UTF-8 decode failure as binary, never as missing', async () => {
    const t = tool({
      access: async () => {},
      readFile: async () => {
        throw new Error('stream did not contain valid UTF-8');
      },
    });

    const text = await run(t, { path: 'Assets/Art/logo.png' });

    expect(text).not.toContain('File not found');
    expect(text.toLowerCase()).toContain('binary');
    // It must be unambiguous that the file EXISTS, or the model will create it.
    expect(text).toMatch(/exists/i);
  });

  it('still reports a genuinely missing file as not found', async () => {
    const t = tool({
      access: async () => {
        throw new Error('No such file or directory (os error 2)');
      },
    });

    const text = await run(t, { path: 'Assets/Missing.cs' });
    expect(text).toContain('File not found');
  });

  it('surfaces an unrelated read failure as-is, not as binary', async () => {
    const t = tool({
      access: async () => {},
      readFile: async () => {
        throw new Error('Permission denied (os error 13)');
      },
    });

    const text = await run(t, { path: 'Assets/Locked.cs' });
    expect(text).toContain('Permission denied');
    expect(text.toLowerCase()).not.toContain('binary');
  });
});
