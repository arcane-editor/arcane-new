/** Durable activation reporting. The native outbox validates the live Unity
 * handshake and owns install identity, persistence and a lease shared by windows.
 * Network bodies are explicit allowlists: no project or auth callback data. */

export interface ActivationRecord {
  installId: string;
  installProof: string;
  os: string;
  appVersion: string;
  channel: string;
  registered: boolean;
  reported: boolean;
  associated: boolean;
}

interface Claim { leaseId: number; record: ActivationRecord }

export interface ActivationDeps {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  fetchImpl: typeof fetch;
  baseUrl: string;
  getToken: () => string | null;
  metadata: { os: string; appVersion: string; channel: string };
  newId: () => string;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createActivationReporter(deps: ActivationDeps) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<boolean> | null = null;
  let started = false;
  let failures = 0;
  const schedule: NonNullable<ActivationDeps['schedule']> = deps.schedule
    ?? ((callback, ms) => setTimeout(callback, ms) as ReturnType<typeof setTimeout>);
  const cancel = deps.cancel ?? clearTimeout;
  // WebKit requires the native fetch receiver to be the global object.
  const fetchImpl = deps.fetchImpl;

  async function post(path: string, body: Record<string, unknown>, token?: string): Promise<void> {
    const response = await fetchImpl(`${deps.baseUrl}/v1/install/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    // A 2xx with no acknowledgement can be a proxy or a partial response.
    // Retain the outbox in every non-acknowledged case, including 429 and 4xx.
    if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) {
      throw new Error('Activation not acknowledged');
    }
  }

  async function sendPending(): Promise<boolean> {
    let claim: Claim | null = null;
    try {
      claim = await deps.invoke<Claim | null>('activation_claim', { hasAuth: !!deps.getToken() });
      if (!claim) return true;
      const { leaseId, record } = claim;
      const identity = { installId: record.installId, installProof: record.installProof };
      const body = { ...identity, os: record.os, appVersion: record.appVersion, channel: record.channel };
      if (!record.registered) {
        await post('register', body);
        await deps.invoke('activation_ack', { leaseId, stage: 'registered' });
      }
      if (!record.reported) {
        await post('activation', body);
        await deps.invoke('activation_ack', { leaseId, stage: 'reported' });
      }
      // Read the existing session only at the time of association; never start
      // sign-in or persist a token in the outbox. Anonymous activation works.
      const token = deps.getToken();
      if (token && !record.associated) {
        await post('associate', identity, token);
        await deps.invoke('activation_ack', { leaseId, stage: 'associated' });
      }
      return true;
    } catch {
      return false;
    } finally {
      if (claim) {
        await deps.invoke('activation_release', { leaseId: claim.leaseId }).catch(() => {});
      }
    }
  }

  function flush(): Promise<boolean> {
    if (inFlight) return inFlight;
    inFlight = sendPending().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function tick(): Promise<void> {
    const ok = await flush();
    failures = ok ? 0 : failures + 1;
    if (!started) return;
    if (timer !== undefined) cancel(timer);
    // Other windows may enqueue work or close while holding a lease. Periodic
    // attempts recover those cases as well as an offline launch, without bursts.
    const delay = ok ? 60_000 : Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4));
    timer = schedule(() => { void tick(); }, delay);
  }

  function wake(): void {
    if (!started) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => { void tick(); }, 0);
  }

  return {
    flush,
    wake,
    start() { if (!started) { started = true; wake(); } },
    stop() { started = false; if (timer !== undefined) cancel(timer); },
    async observe(workspacePath: string): Promise<boolean> {
      try {
        const accepted = await deps.invoke<boolean>('activation_observe', {
          workspacePath,
          candidate: deps.newId(),
          proofCandidate: (deps.newId() + deps.newId()).replace(/-/g, '').toLowerCase(),
          os: deps.metadata.os,
          appVersion: deps.metadata.appVersion,
          channel: deps.metadata.channel,
        });
        if (accepted) wake();
        return accepted;
      } catch {
        return false;
      }
    },
  };
}
