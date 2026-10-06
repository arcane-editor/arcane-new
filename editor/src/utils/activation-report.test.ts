import { describe, expect, it } from 'bun:test';
import { createActivationReporter, type ActivationRecord } from './activation-report';

function harness() {
  const record: ActivationRecord = {
    installId: '11111111-2222-3333-4444-555555555555', installProof: 'a'.repeat(64),
    os: 'macos', appVersion: '0.3.3', channel: 'dev',
    registered: false, reported: false, associated: false,
  };
  let observed = false;
  let validConnection = true;
  let leased = false;
  let token: string | null = null;
  let failure: 'network' | '429' | '503' | 'unacknowledged' | null = null;
  let failAck: string | null = null;
  const sent: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let sequence = 0;
  const deps = {
    invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      if (command === 'activation_observe') {
        observed ||= validConnection;
        return validConnection as T;
      }
      if (command === 'activation_claim') {
        if (!observed || leased || (record.reported && (record.associated || !args?.hasAuth))) return null as T;
        leased = true;
        return { leaseId: 1, record: { ...record } } as T;
      }
      if (command === 'activation_ack') {
        if (args?.stage === failAck) throw new Error('disk unavailable');
        record[args?.stage as 'registered' | 'reported' | 'associated'] = true;
      }
      if (command === 'activation_release') leased = false;
      return undefined as T;
    },
    fetchImpl: (async (input, init) => {
      const path = String(input).split('/').pop()!;
      sent.push({ path, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
      if (failure === 'network') throw new Error('offline');
      if (failure === '429' || failure === '503') return new Response('{}', { status: Number(failure) });
      return new Response(JSON.stringify({ ok: failure !== 'unacknowledged' }), { status: 202 });
    }) as typeof fetch,
    baseUrl: 'https://api.example.test',
    getToken: () => token,
    metadata: { os: 'macos', appVersion: '0.3.3', channel: 'dev' },
    newId: () => '11111111-2222-3333-4444-555555555555',
    schedule: ((callback: () => void, delay: number) => {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      return id;
    }) as unknown as (callback: () => void, delay: number) => ReturnType<typeof setTimeout>,
    cancel: ((id: number) => { timers.delete(id); }) as unknown as (id: ReturnType<typeof setTimeout>) => void,
  };
  return {
    record, sent, timers, deps, create: () => createActivationReporter(deps),
    setToken(value: string | null) { token = value; },
    setValidConnection(value: boolean) { validConnection = value; },
    setFailure(value: typeof failure) { failure = value; },
    setFailAck(value: typeof failAck) { failAck = value; },
  };
}

describe('activation outbox delivery', () => {
  it('calls browser fetch without a dependency-object receiver', async () => {
    const h = harness();
    const original = h.deps.fetchImpl;
    h.deps.fetchImpl = async function (this: unknown, input, init) {
      expect(this === undefined || this === globalThis).toBe(true);
      return original(input, init);
    } as typeof fetch;
    const reporter = h.create();
    await reporter.observe('/private/project');
    expect(await reporter.flush()).toBe(true);
    expect(h.record.reported).toBe(true);
  });
  it('sends nothing before a valid native observation, including a mismatched bridge', async () => {
    const h = harness();
    const reporter = h.create();
    await reporter.flush();
    h.setValidConnection(false);
    expect(await reporter.observe('/private/project')).toBe(false);
    await reporter.flush();
    expect(h.sent).toHaveLength(0);
  });

  it('reports anonymously once across reconnections, windows and launches', async () => {
    const h = harness();
    const first = h.create();
    await first.observe('/private/project');
    await Promise.all([first.flush(), first.flush(), h.create().flush()]);
    await first.observe('/private/project');
    await h.create().flush();
    expect(h.sent.map(s => s.path)).toEqual(['register', 'activation']);
    expect(h.sent.every(s => !s.headers.has('Authorization'))).toBe(true);
  });

  it('retries offline activation after restart using the same install and proof', async () => {
    const h = harness();
    const first = h.create();
    await first.observe('/private/project');
    h.setFailure('network');
    expect(await first.flush()).toBe(false);
    expect(h.record.reported).toBe(false);
    h.setFailure(null);
    expect(await h.create().flush()).toBe(true);
    expect(h.sent[0]!.body).toEqual(h.sent[1]!.body);
    expect(h.record.reported).toBe(true);
  });

  for (const failure of ['429', '503', 'unacknowledged'] as const) {
    it(`keeps pending work on ${failure} and retries until a real acknowledgement`, async () => {
      const h = harness();
      const reporter = h.create();
      await reporter.observe('/private/project');
      h.setFailure(failure);
      expect(await reporter.flush()).toBe(false);
      expect(h.record.registered).toBe(false);
      h.setFailure(null);
      await reporter.flush();
      expect(h.record.reported).toBe(true);
    });
  }

  it('associates a previously anonymous activation on existing login without resending activation', async () => {
    const h = harness();
    const reporter = h.create();
    await reporter.observe('/private/project');
    await reporter.flush();
    h.setToken('existing-session-token');
    await h.create().flush();
    expect(h.sent.map(s => s.path)).toEqual(['register', 'activation', 'associate']);
    expect(h.sent[2]!.headers.get('Authorization')).toBe('Bearer existing-session-token');
    expect(Object.keys(h.sent[2]!.body).sort()).toEqual(['installId', 'installProof']);
    h.setToken('another-session-token');
    await reporter.flush();
    expect(h.sent).toHaveLength(3);
  });

  it('retains association retries when auth is temporarily rejected', async () => {
    const h = harness();
    const reporter = h.create();
    await reporter.observe('/private/project');
    await reporter.flush();
    h.setToken('existing-session-token');
    h.setFailure('network');
    expect(await reporter.flush()).toBe(false);
    expect(h.record.associated).toBe(false);
    h.setFailure(null);
    await reporter.flush();
    expect(h.sent.map(s => s.path)).toEqual(['register', 'activation', 'associate', 'associate']);
    expect(h.record.associated).toBe(true);
  });

  it('replays only an unacknowledged stage after a local persistence failure', async () => {
    const h = harness();
    const reporter = h.create();
    await reporter.observe('/private/project');
    h.setFailAck('reported');
    expect(await reporter.flush()).toBe(false);
    h.setFailAck(null);
    await h.create().flush();
    expect(h.sent.map(s => s.path)).toEqual(['register', 'activation', 'activation']);
  });

  it('allowlists network fields instead of serializing local state or project details', async () => {
    const h = harness();
    Object.assign(h.record, { projectPath: '/private/project', name: 'Secret game', code: 'private', callbackUrl: 'unityide://auth?code=secret' });
    const reporter = h.create();
    await reporter.observe('/private/project');
    await reporter.flush();
    for (const request of h.sent) {
      expect(Object.keys(request.body).sort()).toEqual(['appVersion', 'channel', 'installId', 'installProof', 'os']);
      expect(JSON.stringify(request.body)).not.toContain('private');
    }
  });

  it('schedules bounded retries within the same launch and can wake on connectivity or login', async () => {
    const h = harness();
    const reporter = h.create();
    await reporter.observe('/private/project');
    h.setFailure('network');
    reporter.start();
    const scheduled = [...h.timers.values()][0]!;
    expect(scheduled.delay).toBe(0);
    scheduled.callback();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect([...h.timers.values()].at(-1)!.delay).toBe(30_000);
    reporter.wake();
    expect([...h.timers.values()].at(-1)!.delay).toBe(0);
    reporter.stop();
  });
});
