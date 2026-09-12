import { describe, it, expect } from 'bun:test';
import {
  findActionReferencesInText,
  buildWrapperCatalog,
  makeIdentifier,
  type ActionReference,
} from './action-refs';

/**
 * The generated C# wrapper class is the blind spot these tests pin.
 *
 * `controls.Player.Jump` carries no string literal, so every literal-based
 * pattern misses it, and the subscribe pattern captures `Jump` as a receiver it
 * cannot resolve. In a project with `generateWrapperCode: 1` that meant every
 * action reported zero references while the UI stated outright that nothing
 * read them. Wrong, and confidently so.
 */

const ACTIONS = [
  { name: 'Jump', mapName: 'Player' },
  { name: 'Fire', mapName: 'Player' },
  { name: 'Move Camera', mapName: 'Player' },
  { name: 'Submit', mapName: 'UI' },
];
const NAMES = ACTIONS.map((a) => a.name);
const CATALOG = buildWrapperCatalog(ACTIONS);

const find = (src: string) => findActionReferencesInText('/p/X.cs', src, NAMES, CATALOG);
const kinds = (refs: ActionReference[], name: string) =>
  refs.filter((r) => r.actionName === name).map((r) => r.kind);

describe('makeIdentifier — mirrors Unity CSharpCodeHelpers', () => {
  it('removes invalid characters rather than replacing them', () => {
    // Replacing with `_` would give `Move_Camera`, which is NOT what the
    // wrapper generates, so the property would never match.
    expect(makeIdentifier('Move Camera')).toBe('MoveCamera');
    expect(makeIdentifier('Look-Around')).toBe('LookAround');
  });

  it('prefixes an underscore when the name starts with a digit', () => {
    expect(makeIdentifier('2D Vector')).toBe('_2DVector');
  });

  it('leaves an already-valid identifier alone', () => {
    expect(makeIdentifier('Jump')).toBe('Jump');
  });
});

describe('wrapper access', () => {
  it('sees a polling read that has no literal and no handler', () => {
    // The case that was completely invisible before: no string, no subscription,
    // no `OnFire` method. Previously reported as "nothing reads Fire".
    const refs = find('if (controls.Player.Fire.IsPressed()) Shoot();');
    expect(kinds(refs, 'Fire')).toContain('wrapper');
  });

  it('resolves a wrapper subscription end to end', () => {
    const refs = find(`
      controls.Player.Jump.performed += OnJump;
      private void OnJump(InputAction.CallbackContext ctx) { }
    `);
    expect(kinds(refs, 'Jump')).toContain('wrapper');
    expect(kinds(refs, 'Jump')).toContain('subscription');
    const sub = refs.find((r) => r.kind === 'subscription')!;
    expect(sub.handler).toBe('OnJump');
    expect(sub.phase).toBe('performed');
  });

  it('matches the sanitised property, not the raw asset name', () => {
    const refs = find('var v = controls.Player.MoveCamera.ReadValue<Vector2>();');
    // Reported under the REAL name, so everything downstream keys consistently.
    expect(kinds(refs, 'Move Camera')).toContain('wrapper');
  });

  it('keeps maps apart — Submit lives in UI, not Player', () => {
    expect(find('x = controls.Player.Submit;')).toEqual([]);
    expect(kinds(find('x = controls.UI.Submit;'), 'Submit')).toContain('wrapper');
  });

  it('ignores an unrelated property chain', () => {
    // The regex is deliberately loose; the catalog is what makes it safe.
    expect(find('var p = transform.position.x; var r = a.b.c;')).toEqual([]);
  });

  it('does nothing without a catalog, so existing callers are unaffected', () => {
    expect(findActionReferencesInText('/p/X.cs', 'controls.Player.Fire.IsPressed();', NAMES))
      .toEqual([]);
  });

  it('records the qualified Map/Action for the reference list', () => {
    expect(find('x = controls.UI.Submit;')[0].qualifiedName).toBe('UI/Submit');
  });

  it('points the column at the action, not at the map', () => {
    const src = 'x = controls.Player.Fire;';
    const ref = find(src)[0];
    expect(src.slice(ref.column - 1)).toStartWith('Fire');
  });

  it('finds several distinct actions in one file', () => {
    const refs = find(`
      controls.Player.Jump.performed += OnJump;
      controls.Player.Fire.performed += OnFire;
      controls.UI.Submit.performed += OnSubmit;
    `);
    const wrapped = refs.filter((r) => r.kind === 'wrapper').map((r) => r.actionName).sort();
    expect(wrapped).toEqual(['Fire', 'Jump', 'Submit']);
  });
});

describe('the existing patterns still work alongside it', () => {
  it('still finds FindAction literals', () => {
    const refs = find('jump = player.FindAction("Jump");');
    expect(kinds(refs, 'Jump')).toContain('find-action');
  });

  it('still finds the Send Messages naming convention', () => {
    const refs = find('private void OnJump(InputValue v) { }');
    expect(kinds(refs, 'Jump')).toContain('handler');
  });
});
