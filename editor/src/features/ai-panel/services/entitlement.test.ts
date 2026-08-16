import { describe, it, expect } from 'bun:test';
import { maxEntitledEffort } from './entitlement';

// Mirrors ALLOWED_TIERS in arcane-server/src/config/tiers.ts — free: ['low'],
// paid plans: ['low','mid','high'], unknown plan ids coerce to free.
describe('maxEntitledEffort', () => {
  it('free (and unknown/missing) plans cap at low', () => {
    expect(maxEntitledEffort('free')).toBe('low');
    expect(maxEntitledEffort(null)).toBe('low');
    expect(maxEntitledEffort(undefined)).toBe('low');
    expect(maxEntitledEffort('legacy-weird-plan')).toBe('low');
  });

  it('paid plans cap at high', () => {
    expect(maxEntitledEffort('pro')).toBe('high');
    expect(maxEntitledEffort('proplus')).toBe('high');
    expect(maxEntitledEffort('ultra')).toBe('high');
  });
});
