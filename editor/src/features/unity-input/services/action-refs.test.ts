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

// -- "What runs when this fires?" --------------------------------------------
// The answer is two hops from the action: a local is bound to the action, the
// local's event is bound to a handler, and the handler's body is the behaviour.
// Following only the first hop lands you on a lookup, which is not what anyone
// clicking "go to usage" is actually after.

const WIRED = `using UnityEngine.InputSystem;

public class PlayerMotor : MonoBehaviour
{
    private InputAction jump, sprint;

    private void Awake()
    {
        jump = controls.FindAction("Jump");
        sprint = controls.FindAction("Sprint");
    }

    private void OnEnable()
    {
        jump.performed += OnJumpPressed;
        sprint.started += HandleSprint;
    }

    private void OnJumpPressed(InputAction.CallbackContext ctx)
    {
        velocity.y = jumpForce;
    }

    private void HandleSprint(InputAction.CallbackContext ctx) { }
}
`;

describe('resolving the behaviour behind an action', () => {
  const refs = findActionReferencesInText('/p/PlayerMotor.cs', WIRED, KNOWN);
  const of = (kind: string, name: string) =>
    refs.filter((r) => r.kind === kind && r.actionName === name);

  it('records the subscription and which phase it fires on', () => {
    const [sub] = of('subscription', 'Jump');
    expect(sub).toBeDefined();
    expect(sub.handler).toBe('OnJumpPressed');
    expect(sub.phase).toBe('performed');
    expect(sub.line).toBe(15);
  });

  it('follows the handler to its declaration, whatever it is named', () => {
    // `HandleSprint` breaks the OnX convention entirely, so only the
    // subscription can connect it to Sprint.
    const [handler] = of('handler', 'Sprint');
    expect(handler).toBeDefined();
    expect(handler.handler).toBe('HandleSprint');
    expect(handler.line).toBe(24);
  });

  it('lands on the method name, so the caret sits on the declaration', () => {
    const [handler] = of('handler', 'Jump');
    const line = WIRED.split('\n')[handler.line - 1];
    expect(line.slice(handler.column - 1)).toStartWith('OnJumpPressed(');
  });

  it('does not mistake the subscription line for a second declaration', () => {
    // `jump.performed += OnJumpPressed;` has no return type, so it is a
    // subscription; only line 20 declares the method.
    expect(of('handler', 'Jump')).toHaveLength(1);
    expect(of('handler', 'Jump')[0].line).toBe(19);
  });

  it('still recognises the Send Messages convention with no subscription', () => {
    const sendMessages = `public class P : MonoBehaviour {
      private void OnCrouch(InputValue v) { }
    }`;
    const found = findActionReferencesInText('/p/P.cs', sendMessages, ['Crouch']);
    expect(found.map((r) => r.kind)).toEqual(['handler']);
    expect(found[0].handler).toBe('OnCrouch');
  });

  it('ignores a subscription on a local that is not an action', () => {
    const unrelated = `void OnEnable() { health.performed += OnHealth; }`;
    expect(findActionReferencesInText('/p/P.cs', unrelated, KNOWN)).toEqual([]);
  });
});
