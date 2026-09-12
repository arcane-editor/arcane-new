import { describe, it, expect, beforeEach } from 'bun:test';
import { runAgentModeSend, type AgentModeDeps, type PreplanAgentService } from './preplan-controller';
import { withTurnGovernor, resetTurnGovernor, endSubmitBudget, getSubmitCallCount } from './turn-governor';
import { getStreamExtras } from './stream-extras';
import { AssistantMessageEventStream } from './vendor/event-stream';
import type { Context, StreamFn, StreamOptions } from './vendor/types';
import type { Attachment, ChatMode, Effort } from './types';
import type { HostedPlanEntry } from '../../../stores/ai';
import type { ServerConfig } from '../../../stores/server-config';

// Minimal, valid /v1/config shapes — only `hasPreplanning` on the tier under
// test actually matters to `shouldPreplanTier`.
function configWithPreplan(enabled: boolean): ServerConfig {
  return {
    plan: 'pro',
    planLabel: 'Pro',
    features: { inline: true, acp: true, topups: true },
    tiers: [
      { id: 'low', label: 'Standard', description: '', allowed: true, hasPreplanning: false, contextWindow: 131_072, pricingCliffTokens: null },
      { id: 'mid', label: 'Deep Think', description: '', allowed: true, hasPreplanning: true, contextWindow: 131_072, pricingCliffTokens: null },
      { id: 'high', label: 'Max', description: '', allowed: true, hasPreplanning: enabled, contextWindow: 131_072, pricingCliffTokens: null },
    ],
  };
}

interface Call {
  text: string;
  opts: { mode: ChatMode; effort: Effort; attachments?: Attachment[]; promptMode?: 'preplanning' | 'agent' };
}

interface HarnessOpts {
  preplanEnabled: boolean;
  initialPlan: HostedPlanEntry[] | null;
  aborted?: boolean;
  /** Simulates side effects of a `sendMessage` call (todo_update, an error tail). */
  onSend?: (
    call: Call,
    mutableState: { hostedPlan: HostedPlanEntry[] | null; messages: Array<{ role: string }> },
  ) => void;
}

function makeHarness(opts: HarnessOpts) {
  const calls: Call[] = [];
  const systemMessages: string[] = [];
  const mutableState = {
    hostedPlan: opts.initialPlan,
    messages: [] as Array<{ role: string }>,
  };

  const agentService: PreplanAgentService = {
    async sendMessage(text, sendOpts) {
      const call = { text, opts: sendOpts };
      calls.push(call);
      opts.onSend?.(call, mutableState);
    },
    wasLastSendAborted: () => opts.aborted ?? false,
    wasLastSendCapped: () => false,
  };

  const deps: AgentModeDeps = {
    getAiState: () => ({
      mode: 'agent',
      effort: 'high',
      hostedPlan: mutableState.hostedPlan,
      messages: mutableState.messages,
      addSystemMessage: (text: string) => {
        systemMessages.push(text);
        return 'sys-1';
      },
    }),
    getServerConfig: () => configWithPreplan(opts.preplanEnabled),
    getAgentService: () => agentService,
  };

  return { deps, calls, systemMessages };
}

const ATTACHMENTS: Attachment[] = [
  { kind: 'file', id: 'a1', path: '/proj/Foo.cs', relPath: 'Foo.cs', bytes: 10 },
];

describe('runAgentModeSend — execute path', () => {
  it('passes straight through to sendMessage, untouched, when preplanning is disabled', async () => {
    const { deps, calls } = makeHarness({ preplanEnabled: false, initialPlan: null });

    await runAgentModeSend(deps, 'add a coin pickup', ATTACHMENTS);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe('add a coin pickup');
    expect(calls[0].opts).toEqual({ mode: 'agent', effort: 'high', attachments: ATTACHMENTS });
  });

  it('passes straight through when a todo list is already in progress (no re-preplan)', async () => {
    const { deps, calls } = makeHarness({
      preplanEnabled: true,
      initialPlan: [{ text: 'Step 1', status: 'in_progress' }],
    });

    await runAgentModeSend(deps, 'continue', []);

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.promptMode).toBeUndefined();
  });
});

describe('runAgentModeSend — preplan path', () => {
  it('sends promptMode "preplanning" first, then chains an "agent" send with the synthetic pointer', async () => {
    const { deps, calls, systemMessages } = makeHarness({
      preplanEnabled: true,
      initialPlan: null,
      onSend: (call, state) => {
        if (call.opts.promptMode === 'preplanning') {
          state.hostedPlan = [
            { text: 'Add CoinPickup component', status: 'pending' },
            { text: 'Wire pickup to scene', status: 'pending' },
          ];
        }
      },
    });

    await runAgentModeSend(deps, 'add a coin pickup', ATTACHMENTS);

    expect(calls).toHaveLength(2);
    expect(calls[0].opts.promptMode).toBe('preplanning');
    expect(calls[0].opts.attachments).toBe(ATTACHMENTS);
    expect(calls[0].text).toBe('add a coin pickup');

    // Send 2 is a synthetic pointer, NOT the user's own words, and carries no
    // attachments (send 1 already put them in history).
    expect(calls[1].opts.promptMode).toBe('agent');
    expect(calls[1].opts.mode).toBe('agent');
    expect(calls[1].opts.attachments).toBeUndefined();
    expect(calls[1].text).not.toBe('add a coin pickup');
    expect(calls[1].text).toContain('Pre-planning complete');
    expect(calls[1].text).toContain('todo_update');

    expect(systemMessages).toEqual(['Pre-planning complete — executing 2 tasks']);
  });

  it('chain-guard (i): an abort after send 1 skips send 2 entirely', async () => {
    const { deps, calls, systemMessages } = makeHarness({
      preplanEnabled: true,
      initialPlan: null,
      aborted: true,
      onSend: (call, state) => {
        if (call.opts.promptMode === 'preplanning') {
          state.hostedPlan = [{ text: 'Add CoinPickup component', status: 'pending' }];
        }
      },
    });

    await runAgentModeSend(deps, 'add a coin pickup');

    expect(calls).toHaveLength(1);
    expect(calls[0].opts.promptMode).toBe('preplanning');
    expect(systemMessages).toHaveLength(0);
  });

  it("chain-guard (ii): an error tail (last message role: 'error') skips send 2 entirely", async () => {
    const { deps, calls, systemMessages } = makeHarness({
      preplanEnabled: true,
      initialPlan: null,
      onSend: (call, state) => {
        if (call.opts.promptMode === 'preplanning') {
          // The T5 choke point's outcome inspection appended an error tail —
          // a live todo list may or may not exist; the error tail alone must
          // still suppress send 2.
          state.hostedPlan = [{ text: 'Add CoinPickup component', status: 'pending' }];
          state.messages.push({ role: 'assistant' }, { role: 'error' });
        }
      },
    });

    await runAgentModeSend(deps, 'add a coin pickup');

    expect(calls).toHaveLength(1);
    expect(systemMessages).toHaveLength(0);
  });

  it('chain-guard (iii): zero non-done todos FAILS OPEN with a plain agent send (same text, no promptMode)', async () => {
    const { deps, calls, systemMessages } = makeHarness({
      preplanEnabled: true,
      initialPlan: null,
      onSend: () => {
        // The model never called todo_update (or checked everything off
        // immediately) — hostedPlan stays null/empty.
      },
    });

    await runAgentModeSend(deps, 'add a coin pickup', ATTACHMENTS);

    expect(calls).toHaveLength(2);
    expect(calls[0].opts.promptMode).toBe('preplanning');
    // Fail-open send: the ORIGINAL user text, no promptMode override, and no
    // repeated attachments (send 1 already carried them into history).
    expect(calls[1].text).toBe('add a coin pickup');
    expect(calls[1].opts).toEqual({ mode: 'agent', effort: 'high' });
    expect(systemMessages).toHaveLength(0);
  });

  it('chain-guard (iii) also fires when the plan comes back all-done (nothing left to execute)', async () => {
    const { deps, calls } = makeHarness({
      preplanEnabled: true,
      initialPlan: null,
      onSend: (call, state) => {
        if (call.opts.promptMode === 'preplanning') {
          state.hostedPlan = [{ text: 'Already done somehow', status: 'done' }];
        }
      },
    });

    await runAgentModeSend(deps, 'add a coin pickup');

    expect(calls).toHaveLength(2);
    expect(calls[1].opts).toEqual({ mode: 'agent', effort: 'high' });
  });
});

// Task 3: the preplan branch's two chained sends must share ONE turn-governor
// submit budget (beginSubmitBudget/endSubmitBudget), not a fresh cap per
// send. These tests drive the REAL turn-governor module (not a fake) through
// a `PreplanAgentService.sendMessage` that mimics what `agent-service.ts`'s
// real `sendMessage` does on every call: `resetTurnGovernor()` first (which,
// per `turn-governor.ts`'s SUBMIT SCOPE note, leaves the running count alone
// while a submit is open), then some governed stream calls.
describe('runAgentModeSend — turn-governor submit scope (Task 3)', () => {
  const CTX: Context = {
    systemPrompt: 'SYS',
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
    tools: [{ name: 't', description: 'd', parameters: {} as never }],
  };

  function streamOpts(): StreamOptions {
    return { model: { id: 'm', name: 'm', provider: 'x' }, reasoning: 'high' };
  }

  function isGoverned(c: Context): boolean {
    return getStreamExtras(c)?.toolChoice === 'none';
  }

  /** Records every Context it was called with and returns an immediately-done text response. */
  function recordingStreamFn(): { streamFn: StreamFn; calls: () => Context[] } {
    const recorded: Context[] = [];
    const streamFn: StreamFn = (context) => {
      recorded.push(context);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: 'start' });
      stream.push({
        type: 'done',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: Date.now() },
      });
      return stream;
    };
    return { streamFn, calls: () => recorded };
  }

  /**
   * `sendBehavior` runs after the two governed calls, with direct access to
   * the harness's own mutable hostedPlan — so a test can seed the todo list
   * (to drive the chain into send 2) and/or throw (to prove the `finally`
   * still closes the submit scope), all from one place.
   */
  function makeGovernedHarness(
    sendBehavior: (
      sendOpts: Call['opts'],
      mutableState: { hostedPlan: HostedPlanEntry[] | null },
    ) => void,
  ) {
    const { streamFn, calls } = recordingStreamFn();
    // Explicit no-op notice handlers: the cap (3) and soft-limit threshold
    // are both crossed by these tests' call counts, and the module's
    // DEFAULT handlers dynamically `import('../../../stores/ai')` for real —
    // exactly the Bun-DOM-touching import this whole file's DI seam exists
    // to avoid (see this file's own header). Supplying no-ops keeps the test
    // on the real `withTurnGovernor`/`resetTurnGovernor` machinery without
    // ever reaching that import.
    const governed = withTurnGovernor(streamFn, () => ({
      caps: { high: 3 },
      onSoftLimit: () => {},
      onCapReached: () => {},
    }));
    const sentCalls: Call[] = [];
    const mutableState = {
      hostedPlan: null as HostedPlanEntry[] | null,
      messages: [] as Array<{ role: string }>,
    };

    const agentService: PreplanAgentService = {
      async sendMessage(text, sendOpts) {
        sentCalls.push({ text, opts: sendOpts });
        resetTurnGovernor(); // the same call site agent-service.ts's runSend uses
        governed(CTX, streamOpts());
        governed(CTX, streamOpts());
        sendBehavior(sendOpts, mutableState); // may throw — propagates like a real send failure
      },
      wasLastSendAborted: () => false,
      wasLastSendCapped: () => false,
    };

    const deps: AgentModeDeps = {
      getAiState: () => ({
        mode: 'agent',
        effort: 'high',
        hostedPlan: mutableState.hostedPlan,
        messages: mutableState.messages,
        addSystemMessage: () => 'sys-1',
      }),
      getServerConfig: () => configWithPreplan(true),
      getAgentService: () => agentService,
    };

    return { deps, sentCalls, calls };
  }

  // Module state persists across tests (same discipline turn-governor.test.ts
  // uses): a leaked open submit or non-zero count from one test must not leak
  // into the next.
  beforeEach(() => {
    endSubmitBudget();
    resetTurnGovernor();
  });

  it('accumulates the call count across the chained preplan + execute sends: the 3rd call overall is governed', async () => {
    const { deps, sentCalls, calls } = makeGovernedHarness((sendOpts, state) => {
      if (sendOpts.promptMode === 'preplanning') {
        state.hostedPlan = [{ text: 'Step', status: 'pending' }];
      }
    });

    await runAgentModeSend(deps, 'add a coin pickup');

    // send 1 (preplanning) + send 2 (chained execute) — 2 governed calls each.
    expect(sentCalls).toHaveLength(2);
    expect(calls()).toHaveLength(4);
    expect(isGoverned(calls()[0])).toBe(false); // send 1, call 1
    expect(isGoverned(calls()[1])).toBe(false); // send 1, call 2
    expect(isGoverned(calls()[2])).toBe(true); // send 2, call 1 — 3rd overall, AT cap
    expect(isGoverned(calls()[3])).toBe(true); // send 2, call 2 — beyond cap

    // The submit scope closed when runAgentModeSend resolved: a fresh
    // resetTurnGovernor() now actually zeroes the count (it wouldn't if
    // `submitOpen` were still true — see turn-governor.ts's `resetTurnGovernor`).
    resetTurnGovernor();
    expect(getSubmitCallCount()).toBe(0);
  });

  it('closes the submit scope in `finally` even when the chained send throws mid-chain', async () => {
    const { deps, sentCalls } = makeGovernedHarness((sendOpts, state) => {
      if (sendOpts.promptMode === 'preplanning') {
        // A remaining todo so the chain proceeds into send 2.
        state.hostedPlan = [{ text: 'Step', status: 'pending' }];
        return;
      }
      // Send 2 (the chained execute) throws — before `endSubmitBudget()`
      // could run anywhere except the `finally`.
      throw new Error('boom mid-chain');
    });

    await expect(runAgentModeSend(deps, 'add a coin pickup')).rejects.toThrow('boom mid-chain');
    expect(sentCalls).toHaveLength(2); // preplanning ran, then the chained send threw

    // Despite the throw, the `finally` ran `endSubmitBudget()` — proven the
    // same way as above: a fresh reset now actually zeroes the count.
    resetTurnGovernor();
    expect(getSubmitCallCount()).toBe(0);
  });
});
