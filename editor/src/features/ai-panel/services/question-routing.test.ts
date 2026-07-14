import { describe, it, expect } from 'bun:test';
import { shouldRouteToQuestion } from './question-routing';

describe('shouldRouteToQuestion', () => {
  it('routes to the question when one is pending and the text is non-empty', () => {
    expect(shouldRouteToQuestion({ pendingQuestion: true, text: 'the blue approach' })).toBe(true);
  });

  it('does not route when the text is whitespace-only', () => {
    expect(shouldRouteToQuestion({ pendingQuestion: true, text: '   ' })).toBe(false);
  });

  it('does not route when there is no pending question', () => {
    expect(shouldRouteToQuestion({ pendingQuestion: false, text: 'the blue approach' })).toBe(false);
  });
});
