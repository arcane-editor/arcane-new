import { describe, it, expect } from 'bun:test';
import {
  runPlanExecution,
  resolvePostExecutionPhase,
  type PlanRunDeps,
  type PlanRunAiState,
  type PlanRunAgentService,
} from './plan-run';
import type { Effort } from './types';
import type { HostedPlanEntry, PlanPhase } from '../../../stores/ai';
import type { PlanRef } from './session-persistence';

interface Call {
  text: string;
  opts: {
    mode: 'plan';
    effort: Effort;
    promptMode: 'plan-execution';
    planExecution: { planPath: string; planContent: string };
  };
}

/** Test fixtures encode steps as one marker per (trimmed) line: 'x' done, '_' pending. */
function defaultStepsOf(markdown: string): { done: boolean }[] {
  return markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l === 'x' || l === '_')
    .map((l) => ({ done: l === 'x' }));
}

interface HarnessOpts {
  planPath?: string;
  /** First `readPlan` result (before the send). Throws if an `Error`. */
  before: string | Error;
  /** Second `readPlan` result (the `finally`'s re-read). Defaults to `before`. */
  after?: string | Error;
  dirty?: boolean;
  aborted?: boolean;
  capped?: boolean;
  stepsOf?: (markdown: string) => { done: boolean }[];
  /** Runs after `sendMessage` records its call — `pushErrorTail` simulates the
   *  T5 choke point's outcome inspection appending a `role: 'error'` message. */
  onSend?: (call: Call, ctx: { pushErrorTail: () => void }) => void;
}

function makeHarness(opts: HarnessOpts) {
  const planPath = opts.planPath ?? '/ws/.unityide/plans/p.aplan';
  const log: string[] = [];
  const calls: Call[] = [];
  const errors: (string | null)[] = [];
  const phases: PlanPhase[] = [];
  const activePaths: (string | null)[] = [];
  const hostedPlans: (HostedPlanEntry[] | null)[] = [];
  const refStatusCalls: { path: string; status: PlanRef['status'] }[] = [];
  const messages: Array<{ role: string }> = [];
  const sessionPlans: PlanRef[] = [];

  const aiState: PlanRunAiState = {
    effort: 'high',
    messages,
    setPlanPhase: (p) => {
      phases.push(p);
      log.push(`setPlanPhase:${p}`);
    },
    setActivePlanPath: (p) => {
      activePaths.push(p);
      log.push(`setActivePlanPath:${p}`);
    },
    setHostedPlan: (p) => {
      hostedPlans.push(p);
      log.push('setHostedPlan');
    },
    setError: (e) => {
      errors.push(e);
      log.push(`setError:${e}`);
    },
    sessionPlans,
    addSessionPlan: (ref) => {
      sessionPlans.push(ref);
    },
    setPlanRefStatus: (path, status) => {
      refStatusCalls.push({ path, status });
      log.push(`setPlanRefStatus:${status}`);
    },
  };

  const agentService: PlanRunAgentService = {
    async sendMessage(text, sendOpts) {
      const call = { text, opts: sendOpts };
      calls.push(call);
      log.push('sendMessage');
      opts.onSend?.(call, {
        pushErrorTail: () => messages.push({ role: 'assistant' }, { role: 'error' }),
      });
    },
    wasLastSendAborted: () => opts.aborted ?? false,
    wasLastSendCapped: () => opts.capped ?? false,
  };

  let readCount = 0;
  const deps: PlanRunDeps = {
    getAiState: () => aiState,
    getAgentService: () => agentService,
    readPlan: async () => {
      readCount++;
      const content = readCount === 1 ? opts.before : (opts.after ?? opts.before);
      log.push(`readPlan#${readCount}`);
      if (content instanceof Error) throw content;
      return content;
    },
    isPlanTabDirty: () => opts.dirty ?? false,
    planStepsOf: opts.stepsOf ?? defaultStepsOf,
  };

  return { deps, planPath, log, calls, errors, phases, activePaths, hostedPlans, refStatusCalls, messages };
}

describe('runPlanExecution — guards', () => {
  it('a dirty plan tab errors and never sends', async () => {
    const { deps, planPath, calls, errors, phases } = makeHarness({ dirty: true, before: 'irrelevant' });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(calls).toHaveLength(0);
    expect(errors).toEqual(['Save the plan file (Cmd+S) before executing.']);
    expect(phases).toHaveLength(0);
  });

  it('an unreadable plan file clears the path/phase and never sends', async () => {
    const { deps, planPath, calls, errors, phases, activePaths } = makeHarness({
      before: new Error('EPERM: permission denied'),
    });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(calls).toHaveLength(0);
    expect(activePaths).toEqual([null]);
    expect(phases).toEqual(['idle']);
    expect(errors).toEqual([
      'Could not read plan file: EPERM: permission denied — plan cleared; send a message to plan again.',
    ]);
  });

  it('an empty plan file clears the path/phase and never sends', async () => {
    const { deps, planPath, calls, errors, phases, activePaths } = makeHarness({ before: '   \n  \t  ' });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(calls).toHaveLength(0);
    expect(activePaths).toEqual([null]);
    expect(phases).toEqual(['idle']);
    expect(errors).toEqual(['Plan file is empty — plan cleared; send a message to plan again.']);
  });
});

describe('runPlanExecution — happy path', () => {
  it('pins phase/path, seeds hostedPlan BEFORE sending, and sends plan-execution with the file content', async () => {
    const content = '- [ ] T1 Step one\n- [ ] T2 Step two\n';
    const { deps, planPath, calls, log, phases, activePaths, hostedPlans, refStatusCalls } = makeHarness({
      before: content,
      after: content,
      stepsOf: () => [{ done: false }, { done: false }],
    });

    await runPlanExecution(deps, planPath, `Execute the plan at ${planPath}.`);

    expect(phases[0]).toBe('executing');
    expect(activePaths[0]).toBe(planPath);
    expect(refStatusCalls[0]).toEqual({ path: planPath, status: 'executing' });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe(`Execute the plan at ${planPath}.`);
    expect(calls[0].opts).toEqual({
      mode: 'plan',
      effort: 'high',
      promptMode: 'plan-execution',
      planExecution: { planPath, planContent: content },
    });

    expect(hostedPlans[0]).toEqual([
      { text: 'Step one', status: 'pending' },
      { text: 'Step two', status: 'pending' },
    ]);

    // hostedPlan seeded BEFORE the send, not merely both having happened.
    expect(log.indexOf('setHostedPlan')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('sendMessage')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('setHostedPlan')).toBeLessThan(log.indexOf('sendMessage'));
  });
});

describe('runPlanExecution — post-run phase', () => {
  it('all steps ticked after the send resolves awaiting-execute and marks the ref done', async () => {
    const { deps, planPath, phases, refStatusCalls } = makeHarness({
      before: '- [ ] T1 Step one\n',
      after: '- [x] T1 Step one\n',
      stepsOf: (md) => (md.includes('[x]') ? [{ done: true }] : [{ done: false }]),
    });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(phases).toEqual(['executing', 'awaiting-execute']);
    expect(refStatusCalls).toEqual([
      { path: planPath, status: 'executing' },
      { path: planPath, status: 'done' },
    ]);
  });

  it('steps remaining after the send resolves interrupted and leaves the ref status alone', async () => {
    const { deps, planPath, phases, refStatusCalls } = makeHarness({
      before: '- [ ] T1 Step one\n- [ ] T2 Step two\n',
      after: '- [x] T1 Step one\n- [ ] T2 Step two\n',
      stepsOf: () => [{ done: true }, { done: false }],
    });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(phases).toEqual(['executing', 'interrupted']);
    // Only the top-of-run 'executing' pin — never told 'done' with work left.
    expect(refStatusCalls).toEqual([{ path: planPath, status: 'executing' }]);
  });

  it('a capped send with no checkboxes in the file resolves interrupted', async () => {
    const { deps, planPath, phases } = makeHarness({
      before: 'no todos here',
      after: 'no todos here',
      capped: true,
      stepsOf: () => [],
    });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(phases).toEqual(['executing', 'interrupted']);
  });

  it('an aborted send with no checkboxes in the file resolves interrupted', async () => {
    const { deps, planPath, phases } = makeHarness({
      before: 'no todos here',
      after: 'no todos here',
      aborted: true,
      stepsOf: () => [],
    });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(phases).toEqual(['executing', 'interrupted']);
  });

  it('an error-tail send with no checkboxes in the file resolves interrupted', async () => {
    const { deps, planPath, phases } = makeHarness({
      before: 'no todos here',
      after: 'no todos here',
      stepsOf: () => [],
      onSend: (_call, ctx) => ctx.pushErrorTail(),
    });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(phases).toEqual(['executing', 'interrupted']);
  });

  it('a clean finish with no checkboxes in the file resolves awaiting-execute', async () => {
    const { deps, planPath, phases } = makeHarness({
      before: 'no todos here',
      after: 'no todos here',
      stepsOf: () => [],
    });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(phases).toEqual(['executing', 'awaiting-execute']);
  });

  it('sendMessage throwing still resolves the phase in the finally', async () => {
    const { deps, planPath, phases } = makeHarness({
      before: 'no todos here',
      after: 'no todos here',
      stepsOf: () => [],
      onSend: () => {
        throw new Error('boom mid-send');
      },
    });

    await expect(runPlanExecution(deps, planPath, 'Execute the plan.')).rejects.toThrow('boom mid-send');

    // Not aborted, not capped, no error-tail recorded by this fake (that's the
    // real AgentService's job) — a clean-looking outcome resolves awaiting-execute,
    // proving the finally's phase resolution runs despite the throw.
    expect(phases).toEqual(['executing', 'awaiting-execute']);
  });

  it('an unreadable re-read (finally) falls through to the send outcome, same as unknown steps', async () => {
    const { deps, planPath, phases } = makeHarness({
      before: 'no todos here',
      after: new Error('gone'),
      aborted: true,
    });

    await runPlanExecution(deps, planPath, 'Execute the plan.');

    expect(phases).toEqual(['executing', 'interrupted']);
  });
});

describe('resolvePostExecutionPhase', () => {
  const DONE_STEPS = [{ done: true }, { done: true }];
  const REMAINING_STEPS = [{ done: true }, { done: false }];
  const FLAG_COMBOS = [
    { aborted: false, capped: false, errored: false },
    { aborted: true, capped: false, errored: false },
    { aborted: false, capped: true, errored: false },
    { aborted: false, capped: false, errored: true },
  ];

  it('non-empty steps, all done ⇒ awaiting-execute/done, whatever aborted/capped/errored say', () => {
    for (const flags of FLAG_COMBOS) {
      expect(resolvePostExecutionPhase({ ...flags, steps: DONE_STEPS })).toEqual({
        planPhase: 'awaiting-execute',
        refStatus: 'done',
      });
    }
  });

  it('non-empty steps, some remaining ⇒ interrupted/executing, whatever aborted/capped/errored say', () => {
    for (const flags of FLAG_COMBOS) {
      expect(resolvePostExecutionPhase({ ...flags, steps: REMAINING_STEPS })).toEqual({
        planPhase: 'interrupted',
        refStatus: 'executing',
      });
    }
  });

  it('steps null (unreadable) ⇒ interrupted iff aborted, capped, or errored', () => {
    expect(resolvePostExecutionPhase({ aborted: false, capped: false, errored: false, steps: null })).toEqual({
      planPhase: 'awaiting-execute',
      refStatus: 'executing',
    });
    expect(resolvePostExecutionPhase({ aborted: true, capped: false, errored: false, steps: null })).toEqual({
      planPhase: 'interrupted',
      refStatus: 'executing',
    });
    expect(resolvePostExecutionPhase({ aborted: false, capped: true, errored: false, steps: null })).toEqual({
      planPhase: 'interrupted',
      refStatus: 'executing',
    });
    expect(resolvePostExecutionPhase({ aborted: false, capped: false, errored: true, steps: null })).toEqual({
      planPhase: 'interrupted',
      refStatus: 'executing',
    });
  });

  it('steps [] (no checkboxes in the plan) follows the same rule as unknown', () => {
    expect(resolvePostExecutionPhase({ aborted: false, capped: false, errored: false, steps: [] })).toEqual({
      planPhase: 'awaiting-execute',
      refStatus: 'executing',
    });
    expect(resolvePostExecutionPhase({ aborted: true, capped: false, errored: false, steps: [] })).toEqual({
      planPhase: 'interrupted',
      refStatus: 'executing',
    });
  });
});
