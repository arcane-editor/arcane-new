import { beforeEach, describe, expect, it } from 'bun:test';
import { getSendPlanPhase, getSendPromptMode, resetSendContext, setSendPromptMode } from './send-context';

describe('send-context', () => {
  beforeEach(() => resetSendContext());

  it('maps plan promptModes to the server planPhase vocabulary', () => {
    setSendPromptMode('plan-planning');
    expect(getSendPlanPhase()).toBe('planning');
    setSendPromptMode('plan-execution');
    expect(getSendPlanPhase()).toBe('executing');
  });

  it('maps preplanning to its own planPhase value', () => {
    setSendPromptMode('preplanning');
    expect(getSendPlanPhase()).toBe('preplanning');
  });

  it('is undefined outside plan mode and before any send', () => {
    expect(getSendPlanPhase()).toBeUndefined();
    setSendPromptMode('agent');
    expect(getSendPlanPhase()).toBeUndefined();
    setSendPromptMode('ask');
    expect(getSendPlanPhase()).toBeUndefined();
  });

  describe('getSendPromptMode', () => {
    it('is null before any send', () => {
      expect(getSendPromptMode()).toBeNull();
    });

    it('returns the raw stored mode for every prompt mode', () => {
      setSendPromptMode('ask');
      expect(getSendPromptMode()).toBe('ask');
      setSendPromptMode('agent');
      expect(getSendPromptMode()).toBe('agent');
      setSendPromptMode('preplanning');
      expect(getSendPromptMode()).toBe('preplanning');
      setSendPromptMode('plan-planning');
      expect(getSendPromptMode()).toBe('plan-planning');
      setSendPromptMode('plan-execution');
      expect(getSendPromptMode()).toBe('plan-execution');
    });
  });
});
