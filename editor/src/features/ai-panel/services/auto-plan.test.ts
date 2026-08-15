import { describe, expect, it } from 'bun:test';
import { assessTaskSize, TODO_FIRST_TEXT } from './auto-plan';

describe('assessTaskSize', () => {
  it('small conversational asks stay normal', () => {
    expect(assessTaskSize('what does this method do?')).toBe('normal');
    expect(assessTaskSize('fix the typo in PlayerController')).toBe('normal');
    expect(assessTaskSize('rename speed to moveSpeed')).toBe('normal');
  });

  it('one signal alone is not enough (conservative default)', () => {
    // multi-step verb only
    expect(assessTaskSize('implement the jump')).toBe('normal');
    // length only — long but flat prose with no other structure
    expect(assessTaskSize('word '.repeat(130).trim())).toBe('normal');
    // two attachments only
    expect(assessTaskSize('look at these', 2)).toBe('normal');
  });

  it('two signals flip to large', () => {
    // verb + enumeration
    expect(
      assessTaskSize('implement saving:\n1. serialize state\n2. write to disk'),
    ).toBe('large');
    // verb + multi-target
    expect(assessTaskSize('refactor all the enemy scripts to use the event bus')).toBe('large');
    // length + enumeration
    const brief = `here is what I need\n- ${'context '.repeat(80)}\n- second part`;
    expect(assessTaskSize(brief)).toBe('large');
    // verb + attachments
    expect(assessTaskSize('integrate these shaders', 2)).toBe('large');
  });

  it('the instruction names todo_update and demands todos before execution', () => {
    expect(TODO_FIRST_TEXT).toContain('todo_update');
    expect(TODO_FIRST_TEXT.toLowerCase()).toContain('first');
  });
});
