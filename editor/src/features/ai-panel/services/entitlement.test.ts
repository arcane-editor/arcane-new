import { describe, it, expect } from 'bun:test';
import { maxEntitledEffort } from './entitlement';

// Mirrors ALLOWED_TIERS in arcane-server/src/config/tiers.ts — free/starter:
// ['low'], pro: ['low','mid'], max: ['low','mid','high'], unknown plan ids
// (including retired ones like proplus/ultra) coerce to free.
describe('maxEntitledEffort', () => {
  it('free, starter (and unknown/missing) plans cap at low', () => {
    expect(maxEntitledEffort('free')).toBe('low');
    expect(maxEntitledEffort('starter')).toBe('low');
    expect(maxEntitledEffort(null)).toBe('low');
    expect(maxEntitledEffort(undefined)).toBe('low');
    expect(maxEntitledEffort('legacy-weird-plan')).toBe('low');
  });

  it('retired plan ids fail closed to low', () => {
    expect(maxEntitledEffort('proplus')).toBe('low');
    expect(maxEntitledEffort('ultra')).toBe('low');
    expect(maxEntitledEffort('garbage')).toBe('low');
  });

  it('pro caps at mid', () => {
    expect(maxEntitledEffort('pro')).toBe('mid');
  });

  it('max caps at high', () => {
    expect(maxEntitledEffort('max')).toBe('high');
  });
});
