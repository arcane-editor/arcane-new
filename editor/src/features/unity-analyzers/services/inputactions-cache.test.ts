// The index carries two audiences. The analyzer rules only ever needed "does
// this action exist, and what does it read as" -- enough to lint a literal.
// The AI harness has to WRITE input code, which needs the bindings themselves:
// "does Jump already have a gamepad binding?" cannot be answered from a name
// and a control type. These tests pin the second set of fields, since nothing
// in the rule suites touches them.

import { describe, it, expect } from 'bun:test';
import { buildInputActionsIndex } from './inputactions-cache';

const ASSET = JSON.stringify({
  name: 'PlayerControls',
  maps: [
    {
      name: 'Player',
      id: 'm1',
      actions: [
        { name: 'Move', type: 'Value', id: 'a1', expectedControlType: 'Vector2' },
        { name: 'Jump', type: 'Button', id: 'a2', expectedControlType: 'Button' },
        { name: 'Reload', type: 'Button', id: 'a3', expectedControlType: 'Button' },
      ],
      bindings: [
        // A composite: the parent holds no control, the parts do.
        {
          id: 'b0',
          name: 'WASD',
          path: '2DVector',
          action: 'Move',
          isComposite: true,
          groups: '',
        },
        {
          id: 'b1',
          name: 'up',
          path: '<Keyboard>/w',
          action: 'Move',
          isPartOfComposite: true,
          groups: 'Keyboard&Mouse',
        },
        {
          id: 'b2',
          name: 'down',
          path: '<Keyboard>/s',
          action: 'Move',
          isPartOfComposite: true,
          groups: 'Keyboard&Mouse',
        },
        { id: 'b3', path: '<Gamepad>/leftStick', action: 'Move', groups: 'Gamepad' },
        { id: 'b4', path: '<Gamepad>/buttonSouth', action: 'Jump', groups: 'Gamepad' },
        // Same control as Jump: Jump is declared first, so Reload is starved.
        { id: 'b5', path: '<Gamepad>/buttonSouth', action: 'Reload', groups: 'Gamepad' },
      ],
    },
  ],
});

const PATH = '/proj/Assets/PlayerControls.inputactions';
const index = buildInputActionsIndex([{ path: PATH, content: ASSET }], 'New');

describe('buildInputActionsIndex — the fields the AI tool reads', () => {
  it('carries every binding, with a composite rendered as its label', () => {
    const move = index.byQualifiedName.get('Player/Move');
    expect(move?.bindings).toEqual(['WASD', '<Gamepad>/leftStick']);
  });

  it('unions the control schemes a composite\'s parts declare', () => {
    const move = index.byQualifiedName.get('Player/Move');
    expect(move?.schemes).toEqual(['Keyboard&Mouse', 'Gamepad']);
  });

  it('records the action type and the owning asset', () => {
    const jump = index.byQualifiedName.get('Player/Jump');
    expect(jump?.actionType).toBe('Button');
    expect(jump?.assetPath).toBe(PATH);
    expect(index.assetPaths).toEqual([PATH]);
  });

  it('still flags the starved side of a binding conflict', () => {
    expect(index.byQualifiedName.get('Player/Jump')?.starved).toBe(false);
    expect(index.byQualifiedName.get('Player/Reload')?.starved).toBe(true);
  });

  it('leaves an unparseable asset out without losing the good ones', () => {
    const mixed = buildInputActionsIndex(
      [
        { path: '/p/broken.inputactions', content: '{ not json' },
        { path: PATH, content: ASSET },
      ],
      'New',
    );
    expect(mixed.assetCount).toBe(1);
    expect(mixed.assetPaths).toEqual([PATH]);
  });

  it('reports no actions for an empty project rather than throwing', () => {
    const empty = buildInputActionsIndex([], 'Legacy');
    expect(empty.assetCount).toBe(0);
    expect(empty.assetPaths).toEqual([]);
    expect(empty.byQualifiedName.size).toBe(0);
  });
});
