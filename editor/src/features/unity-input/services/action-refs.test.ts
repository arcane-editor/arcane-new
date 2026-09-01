import { describe, it, expect } from 'bun:test';
import { findActionReferencesInText, type ActionReference } from './action-refs';

const KNOWN = ['Move', 'Jump', 'Sprint', 'Reload'];

const SOURCE = `using UnityEngine;
using UnityEngine.InputSystem;

public class PlayerMotor : MonoBehaviour
{
    private InputAction move, jump, reload;

    private void Awake()
    {
        var player = controls.FindActionMap("Player");
        move   = player.FindAction("Move");
        jump   = player.FindAction("Jump");
        reload = controls.actions["Player/Reload"];
    }

    private void OnEnable()
    {
        jump.performed += OnJump;
    }

    private void OnJump(InputAction.CallbackContext ctx) => velocity.y = jumpForce;

    // Not a reference: the word Jump in a comment, and an unrelated action.
    private void OnCrouch(InputAction.CallbackContext ctx) { }
    private string label = "Jump the gap";
}
`;

function at(refs: ActionReference[], kind: string, name: string) {
  return refs.find((r) => r.kind === kind && r.actionName === name);
}

describe('findActionReferencesInText', () => {
  const refs = findActionReferencesInText('/p/PlayerMotor.cs', SOURCE, KNOWN);

  it('finds FindAction string literals', () => {
    const move = at(refs, 'find-action', 'Move');
    expect(move).toBeDefined();
    expect(move!.line).toBe(11);
    expect(SOURCE.split('\n')[move!.line - 1].slice(move!.column - 1)).toStartWith('"Move"');
  });

  it('finds indexer lookups and keeps the map qualifier', () => {
    const reload = at(refs, 'indexer', 'Reload');
    expect(reload).toBeDefined();
    expect(reload!.qualifiedName).toBe('Player/Reload');
    expect(reload!.line).toBe(13);
  });

  it('finds the action map literal separately from actions', () => {
    const map = refs.find((r) => r.kind === 'find-map');
    expect(map?.actionName).toBe('Player');
    expect(map?.line).toBe(10);
  });

  it('finds Send Messages / callback handlers by naming convention', () => {
    const handler = at(refs, 'handler', 'Jump');
    expect(handler).toBeDefined();
    expect(handler!.line).toBe(21);
  });

  it('ignores handlers whose name matches no action', () => {
    expect(refs.some((r) => r.actionName === 'Crouch')).toBe(false);
  });

  it('ignores an action name appearing in unrelated prose', () => {
    // `"Jump the gap"` is a plain string, not an action lookup.
    expect(refs.every((r) => r.line !== 25)).toBe(true);
  });

  it('reports 1-based line and column so the editor can land on it', () => {
    for (const r of refs) {
      expect(r.line).toBeGreaterThan(0);
      expect(r.column).toBeGreaterThan(0);
    }
  });

  it('carries a trimmed snippet for the peek list', () => {
    expect(at(refs, 'find-action', 'Jump')!.snippet).toBe('jump   = player.FindAction("Jump");');
  });

  it('returns nothing when no action names are known', () => {
    expect(findActionReferencesInText('/p/X.cs', SOURCE, [])).toEqual([]);
  });

  it('sorts by position so the peek list reads top to bottom', () => {
    const lines = refs.map((r) => r.line);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });
});
