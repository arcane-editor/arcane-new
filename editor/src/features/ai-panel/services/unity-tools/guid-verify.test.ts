import { describe, it, expect, afterEach } from 'bun:test';
import {
  registerPendingGuidCheck,
  takePendingGuidChecks,
  resetPendingGuidChecks,
  compareMetaGuid,
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

describe('compareMetaGuid', () => {
  const GUID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const META = `fileFormatVersion: 2\nguid: ${GUID}\nScriptedImporter:\n  script: {fileID: 13804}\n`;

  it('matches when the .meta carries the guid this session allocated', () => {
    expect(compareMetaGuid(GUID, META)).toEqual({ kind: 'match' });
  });

  it('matches case-insensitively — an allocated guid is always lowercase, but a template need not be', () => {
    expect(compareMetaGuid(GUID.toUpperCase(), META)).toEqual({ kind: 'match' });
  });

  it('reports a mismatch with the guid Unity actually assigned, on a collision reassignment', () => {
    const other = 'f0e0d0c0b0a090807060504030201000';
    const meta = `fileFormatVersion: 2\nguid: ${other}\n`;
    expect(compareMetaGuid(GUID, meta)).toEqual({ kind: 'mismatched', actual: other });
  });

  it('reports unreadable when the .meta has no guid: line at all', () => {
    expect(compareMetaGuid(GUID, 'fileFormatVersion: 2\n')).toEqual({ kind: 'unreadable' });
  });
});
