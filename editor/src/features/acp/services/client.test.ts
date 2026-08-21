import { describe, it, expect } from 'bun:test';
import { AcpClient, type AcpTransport } from './client';
import { AcpMethodNotFoundError } from './errors';
import { ACP_INTERNAL_ERROR, ACP_METHOD_NOT_FOUND } from './protocol';

/**
 * Drives the protocol through an injected transport, so these are real
 * end-to-end exercises of the framing and correlation logic with no webview.
 */

const AGENT = 'claude';

interface Harness {
  client: AcpClient;
  /** Every line the client wrote to the agent, parsed. */
  sent: Record<string, unknown>[];
  /** Feed a line from the agent's stdout. */
  emit(line: string): void;
  /** Feed a line tagged for a DIFFERENT agent sharing the same event channel. */
  emitForOther(line: string): void;
  /** Report the agent exiting. */
  exit(error?: string): void;
  stderr(line: string): void;
  unlistenCount(): number;
  stopCalls: string[];
}

async function harness(
  opts: Partial<Parameters<typeof makeClient>[0]> = {},
  transportOverrides: Partial<AcpTransport> = {},
): Promise<Harness> {
  return makeClient(opts, transportOverrides);
}

async function makeClient(
  opts: {
    onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
    onNotification?: (method: string, params: unknown) => void;
    onExit?: (info: { error?: string }) => void;
    onStderr?: (line: string) => void;
  } = {},
  transportOverrides: Partial<AcpTransport> = {},
): Promise<Harness> {
  const sent: Record<string, unknown>[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const stopCalls: string[] = [];
  let unlistened = 0;

  const transport: AcpTransport = {
    start: async () => {},
    send: async (_agentId, message) => {
      sent.push(JSON.parse(message) as Record<string, unknown>);
    },
    stop: async (agentId) => {
      stopCalls.push(agentId);
    },
    listen: async (event, handler) => {
      listeners.set(event, handler as (payload: unknown) => void);
      return () => {
        unlistened++;
      };
    },
    unlisten: (fn) => fn(),
    ...transportOverrides,
  };

  const client = new AcpClient({ agentId: AGENT, transport, ...opts });
  await client.start({ command: 'node', args: [], cwd: '/tmp' });

  return {
    client,
    sent,
    emit: (line) => listeners.get('acp-message')?.({ agentId: AGENT, body: line }),
    emitForOther: (line) => listeners.get('acp-message')?.({ agentId: 'codex', body: line }),
    exit: (error) => listeners.get('acp-exited')?.({ agentId: AGENT, error }),
    stderr: (line) => listeners.get('acp-stderr')?.({ agentId: AGENT, body: line }),
    unlistenCount: () => unlistened,
    stopCalls,
  };
}

describe('request/response correlation', () => {
  it('resolves a request with the matching id', async () => {
    const h = await harness();
    const pending = h.client.request('initialize', { protocolVersion: 1 });
    expect(h.sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    h.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }));
    expect(await pending).toEqual({ protocolVersion: 1 });
  });

  it('rejects with the agent error code, so callers can branch on auth_required', async () => {
    const h = await harness();
    const pending = h.client.request('session/new', {});
    h.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'auth' } }));

    await expect(pending).rejects.toMatchObject({ code: -32000, method: 'session/new' });
  });

  it('keeps two in-flight requests apart', async () => {
    const h = await harness();
    const a = h.client.request('one');
    const b = h.client.request('two');
    h.emit(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'B' }));
    h.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'A' }));
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });

  it('ignores a response to a request that already timed out', async () => {
    const h = await harness();
    const pending = h.client.request('slow', undefined, 1);
    await expect(pending).rejects.toThrow(/timed out/);
    // Late answer for id 1 — must not throw an unhandled rejection.
    expect(() => h.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'late' }))).not.toThrow();
  });
});

describe('agent death', () => {
  it('rejects every in-flight request instead of hanging it', async () => {
    const h = await harness();
    const a = h.client.request('one');
    const b = h.client.request('two');

    h.exit('killed');

    await expect(a).rejects.toThrow(/killed/);
    await expect(b).rejects.toThrow(/killed/);
    expect(h.client.isRunning).toBe(false);
  });

  it('reports the exit once and detaches its listeners', async () => {
    const exits: { error?: string }[] = [];
    const h = await harness({ onExit: (info) => exits.push(info) });

    h.exit('boom');
    h.exit('boom again');

    expect(exits).toEqual([{ error: 'boom' }]);
    expect(h.unlistenCount()).toBe(3);
  });

  it('refuses to send once the agent is gone', async () => {
    const h = await harness();
    h.exit();
    await expect(h.client.request('anything')).rejects.toThrow(/not running/);
    await expect(h.client.notify('anything')).rejects.toThrow(/not running/);
  });

  it('stop() is idempotent and rejects what was in flight', async () => {
    const h = await harness();
    const pending = h.client.request('one');
    await h.client.stop();
    await h.client.stop();
    await expect(pending).rejects.toThrow(/stopped/);
    expect(h.stopCalls).toEqual([AGENT]);
  });
});

describe('inbound requests', () => {
  it('replies -32601 for a method we do not implement', async () => {
    const h = await harness({
      onRequest: (method) => {
        throw new AcpMethodNotFoundError(method);
      },
    });
    h.emit(JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'terminal/create' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.sent.at(-1)).toMatchObject({
      id: 'a',
      error: { code: ACP_METHOD_NOT_FOUND },
    });
  });

  it('replies -32603 when a handler fails for a real reason', async () => {
    const h = await harness({
      onRequest: () => {
        throw new Error('outside the workspace');
      },
    });
    h.emit(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/write_text_file' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.sent.at(-1)).toMatchObject({
      id: 7,
      error: { code: ACP_INTERNAL_ERROR, message: 'outside the workspace' },
    });
  });

  it('replies with a result, coercing undefined to null (JSON-RPC has no undefined)', async () => {
    const h = await harness({ onRequest: () => undefined });
    h.emit(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'fs/write_text_file' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 3, result: null });
  });

  it('answers -32601 when no handler is registered at all', async () => {
    const h = await harness();
    h.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'fs/read_text_file' }));
    await Promise.resolve();

    expect(h.sent.at(-1)).toMatchObject({ error: { code: ACP_METHOD_NOT_FOUND } });
  });
});

describe('stream hygiene', () => {
  it('ignores a non-JSON stdout line rather than dying', async () => {
    const notifications: string[] = [];
    const h = await harness({ onNotification: (m) => notifications.push(m) });

    expect(() => h.emit('Debugger listening on ws://127.0.0.1:9229')).not.toThrow();
    expect(() => h.emit('   ')).not.toThrow();
    h.emit(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} }));

    expect(notifications).toEqual(['session/update']);
  });

  it('survives a notification handler that throws', async () => {
    const h = await harness({
      onNotification: () => {
        throw new Error('render blew up');
      },
    });
    expect(() => h.emit(JSON.stringify({ jsonrpc: '2.0', method: 'session/update' }))).not.toThrow();
    expect(h.client.isRunning).toBe(true);
  });

  it('routes stderr to its handler and never to the protocol parser', async () => {
    const lines: string[] = [];
    const h = await harness({ onStderr: (l) => lines.push(l) });
    h.stderr('npm warn deprecated');
    expect(lines).toEqual(['npm warn deprecated']);
  });

  it('drops events addressed to a different agent on the shared channel', async () => {
    const notifications: string[] = [];
    const h = await harness({ onNotification: (m) => notifications.push(m) });
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'session/update' });

    h.emitForOther(line);
    expect(notifications).toEqual([]);

    h.emit(line);
    expect(notifications).toEqual(['session/update']);
  });
});

describe('start failures', () => {
  it('detaches listeners when the spawn fails, so a retry can re-attach', async () => {
    let unlistened = 0;
    const transport: AcpTransport = {
      start: async () => {
        throw 'ENOENT: node not found';
      },
      send: async () => {},
      stop: async () => {},
      listen: async () => () => {
        unlistened++;
      },
      unlisten: (fn) => fn(),
    };
    const client = new AcpClient({ agentId: AGENT, transport });

    // Tauri rejects with a bare string; it must still surface as a real Error.
    await expect(client.start({ command: 'node', args: [], cwd: '/tmp' })).rejects.toThrow(
      /ENOENT/,
    );
    expect(unlistened).toBe(3);
    expect(client.isRunning).toBe(false);
  });
});
