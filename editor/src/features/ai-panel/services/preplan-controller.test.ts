import { describe, it, expect } from 'bun:test';
import { runAgentModeSend, type AgentModeDeps, type PreplanAgentService } from './preplan-controller';
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
