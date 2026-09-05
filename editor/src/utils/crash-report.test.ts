import { describe, it, expect } from 'bun:test';
import { createCrashReporter, scrubHomePaths, type CrashMeta } from './crash-report';

const META: CrashMeta = {
  appVersion: '0.3.3',
  channel: 'dev',
  os: 'windows',
  sessionId: 'sess-1',
};

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

function reporterWith(
  fetchImpl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
  maxPerSession = 5,
) {
  return createCrashReporter({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    baseUrl: 'https://x.test',
    meta: () => META,
    getToken: () => null,
    maxPerSession,
  });
}

function recorder() {
  const sent: Sent[] = [];
  const fetchImpl = async (url: unknown, init?: unknown) => {
    const opts = init as { body?: string };
    sent.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
    return new Response('{}', { status: 202 });
  };
  return { sent, fetchImpl };
}

describe('createCrashReporter', () => {
  it('posts a crash to /v1/client-error', async () => {
    const { sent, fetchImpl } = recorder();
    const reporter = reporterWith(fetchImpl);

    await reporter.report({ kind: 'react-error-boundary', message: 'boom' });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://x.test/v1/client-error');
    expect(sent[0]!.body.message).toBe('boom');
    expect(sent[0]!.body.appVersion).toBe('0.3.3');
    expect(sent[0]!.body.channel).toBe('dev');
  });

  it('sends one report for a crash that repeats', async () => {
    // "Maximum update depth exceeded" re-throws every render. Without this,
    // one bad component floods the endpoint from a single session.
    const { sent, fetchImpl } = recorder();
    const reporter = reporterWith(fetchImpl);

    const crash = { kind: 'react-error-boundary', message: 'loop', stack: 'at Foo (a.js:1:1)' };
    await reporter.report(crash);
    await reporter.report(crash);
    await reporter.report(crash);

    expect(sent).toHaveLength(1);
  });

  it('stops after the per-session cap even for distinct crashes', async () => {
    const { sent, fetchImpl } = recorder();
    const reporter = reporterWith(fetchImpl, 3);

    for (let i = 0; i < 10; i++) {
      await reporter.report({ kind: 'window-error', message: `distinct-${i}` });
    }

    expect(sent).toHaveLength(3);
  });

  it('resolves instead of throwing when the network fails', async () => {
    // This runs inside componentDidCatch. A throw there turns a panel crash
    // into a blank app — the reporter must never be the thing that escalates.
    const reporter = reporterWith(async () => {
      throw new Error('offline');
    });

    await expect(
      reporter.report({ kind: 'react-error-boundary', message: 'boom' }),
    ).resolves.toBeUndefined();
  });

  it('truncates an oversized stack before sending it', async () => {
    const { sent, fetchImpl } = recorder();
    const reporter = reporterWith(fetchImpl);

    await reporter.report({
      kind: 'react-error-boundary',
      message: 'big',
      stack: 'x'.repeat(40_000),
    });

    expect((sent[0]!.body.stack as string).length).toBeLessThanOrEqual(8_300);
  });

  it('scrubs the user home directory out of what it sends', async () => {
    const { sent, fetchImpl } = recorder();
    const reporter = reporterWith(fetchImpl);

    await reporter.report({
      kind: 'react-error-boundary',
      message: 'at C:\\Users\\sourav\\Documents\\game\\Assets',
    });

    expect(sent[0]!.body.message).not.toContain('sourav');
    expect(sent[0]!.body.message).toContain('~');
  });
});

describe('scrubHomePaths', () => {
  it('replaces a Windows user directory with ~', () => {
    expect(scrubHomePaths('C:\\Users\\sourav\\Documents')).toBe('~\\Documents');
  });

  it('replaces a macOS home directory with ~', () => {
    expect(scrubHomePaths('/Users/sourav/Documents')).toBe('~/Documents');
  });

  it('replaces a Linux home directory with ~', () => {
    expect(scrubHomePaths('/home/sourav/projects')).toBe('~/projects');
  });

  it('leaves a path with no home prefix alone', () => {
    expect(scrubHomePaths('at AgentPicker (index.js:1:2)')).toBe('at AgentPicker (index.js:1:2)');
  });
});
