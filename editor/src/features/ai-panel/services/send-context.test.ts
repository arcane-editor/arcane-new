import { beforeEach, describe, expect, it } from 'bun:test';
import { getSendPlanPhase, resetSendContext, setSendPromptMode } from './send-context';

describe('send-context', () => {
  beforeEach(() => resetSendContext());

  it('maps plan promptModes to the server planPhase vocabulary', () => {
    setSendPromptMode('plan-planning');
    expect(getSendPlanPhase()).toBe('planning');
    setSendPromptMode('plan-execution');
    expect(getSendPlanPhase()).toBe('executing');
  });

  it('is undefined outside plan mode and before any send', () => {
    expect(getSendPlanPhase()).toBeUndefined();
    setSendPromptMode('agent');
    expect(getSendPlanPhase()).toBeUndefined();
    setSendPromptMode('ask');
    expect(getSendPlanPhase()).toBeUndefined();
  });
});
