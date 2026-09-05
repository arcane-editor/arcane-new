// The prompt line the model actually reads. Until this block existed, the base
// prompt's static crib taught legacy `Input.GetAxis` to EVERY project --
// including projects where those calls throw at runtime -- and it was stated
// BEFORE the facts block that contradicted it. These tests pin the mode-correct
// wording, and that the two never both appear.

import { describe, it, expect } from 'bun:test';
import { inputFactLines, type InputActionsFacts } from './input-facts';

const ACTIONS: InputActionsFacts = {
  assetPaths: ['Assets/InputSystem_Actions.inputactions'],
  maps: [
    { name: 'Player', actions: ['Move', 'Look', 'Jump'] },
    { name: 'UI', actions: ['Navigate', 'Submit'] },
  ],
};

const text = (mode: Parameters<typeof inputFactLines>[0], a: InputActionsFacts | null) =>
  inputFactLines(mode, a).join('\n');

describe('inputFactLines — the API crib follows the project, not a default', () => {
  it('tells a New Input System project that Input.GetKey is wrong', () => {
    const out = text('New', ACTIONS);
    expect(out).toContain('InputAction');
    expect(out).toContain('never `Input.GetKey`');
    expect(out).toContain('OnDisable');
  });

  it('still teaches the legacy API to a legacy project', () => {
    const out = text('Legacy', null);
    expect(out).toContain('Input.GetAxis("Horizontal")');
    expect(out).toContain('NOT available');
    expect(out).not.toContain('InputAction`');
  });

  it('lets a Both project use either, and defers to the file being edited', () => {
    const out = text('Both', ACTIONS);
    expect(out).toContain('both work');
    expect(out).toContain('Prefer the Input System for new code');
  });
});

describe('inputFactLines — the action inventory', () => {
  it('names every map with its count and its actions', () => {
    const out = text('New', ACTIONS);
    expect(out).toContain('Assets/InputSystem_Actions.inputactions');
    expect(out).toContain('Player (3): Move, Look, Jump');
    expect(out).toContain('UI (2): Navigate, Submit');
  });

  it('warns that a wrong name fails silently, and points at the tool', () => {
    const out = text('New', ACTIONS);
    expect(out).toContain('silently never fires');
    expect(out).toContain('unity_input_actions');
  });

  it('omits the inventory entirely when the project has no assets', () => {
    const out = text('New', null);
    expect(out).not.toContain('Input actions');
    // The API crib still applies — the package is active either way.
    expect(out).toContain('InputAction');
  });

  it('truncates rather than blowing the frozen prompt budget', () => {
    const many: InputActionsFacts = {
      assetPaths: ['Assets/Big.inputactions'],
      maps: [
        {
          name: 'Huge',
          actions: Array.from({ length: 400 }, (_, i) => `Action${i}`),
        },
      ],
    };
    const out = text('New', many);
    expect(out).toContain('Huge (400):');
    expect(out).toContain('more');
    expect(out.length).toBeLessThan(1500);
  });
});
