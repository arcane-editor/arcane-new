import { describe, it, expect, afterEach } from 'bun:test';
import {
  registerPendingGuidCheck,
  takePendingGuidChecks,
  resetPendingGuidChecks,
} from './guid-verify';

describe('guid-verify', () => {
  afterEach(() => {
    resetPendingGuidChecks();
  });

  it('starts empty', () => {
    expect(takePendingGuidChecks()).toEqual([]);
  });

  it('returns registered path/guid pairs in order', () => {
    registerPendingGuidCheck('Assets/UI/HUD.uxml', 'a'.repeat(32));
    registerPendingGuidCheck('Assets/UI/HUD.uss', 'b'.repeat(32));
    expect(takePendingGuidChecks()).toEqual([
      { path: 'Assets/UI/HUD.uxml', guid: 'a'.repeat(32) },
      { path: 'Assets/UI/HUD.uss', guid: 'b'.repeat(32) },
    ]);
  });

  it('take drains the registry — a second take is empty', () => {
    registerPendingGuidCheck('Assets/UI/HUD.uxml', 'a'.repeat(32));
    takePendingGuidChecks();
    expect(takePendingGuidChecks()).toEqual([]);
  });

  it('reset clears pending registrations without returning them', () => {
    registerPendingGuidCheck('Assets/UI/HUD.uxml', 'a'.repeat(32));
    resetPendingGuidChecks();
    expect(takePendingGuidChecks()).toEqual([]);
  });

  it('registering the same path twice keeps only the latest guid', () => {
    registerPendingGuidCheck('Assets/UI/HUD.uxml', 'a'.repeat(32));
    registerPendingGuidCheck('Assets/UI/HUD.uxml', 'b'.repeat(32));
    expect(takePendingGuidChecks()).toEqual([{ path: 'Assets/UI/HUD.uxml', guid: 'b'.repeat(32) }]);
  });
});
