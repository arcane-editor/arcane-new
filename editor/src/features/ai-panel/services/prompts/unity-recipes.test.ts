import { describe, it, expect } from 'bun:test';
import { unityRecipesFor, UNITY_RECIPES } from './unity-recipes';

describe('unityRecipesFor — selection', () => {
  it('says nothing for a request no recipe covers', () => {
    expect(unityRecipesFor('rename the Health field on Enemy.cs')).toBe('');
    expect(unityRecipesFor('')).toBe('');
  });

  it('matches the character-controller family however it is phrased', () => {
    for (const prompt of [
      'build a full fledged character controller with wasd and jump with space',
      'I want first-person movement',
      'make the player move around',
      'add a third person controller',
      'the capsule should be able to walk up stairs',
    ]) {
      expect(unityRecipesFor(prompt)).toContain('CharacterController');
    }
  });

  it('matches scene setup', () => {
    for (const prompt of [
      'set up a basic scene so I can play the game right away',
      'create a test scene with some stairs',
    ]) {
      expect(unityRecipesFor(prompt)).toContain('scene');
    }
  });

  it('includes both when a request asks for both', () => {
    const out = unityRecipesFor(
      'character controller with wasd and jump, and set up a basic scene with stairs',
    );
    expect(out).toContain('CharacterController');
    expect(out).toContain('Inspector');
  });

  it('never repeats a recipe that matched on two different keywords', () => {
    const out = unityRecipesFor('player movement controller with wasd for the player');
    expect(out.split('stepOffset').length - 1).toBeGreaterThan(0);
    expect(out.match(/### Character controllers/g)?.length).toBe(1);
  });
});

describe('character-controller recipe — the things the model gets wrong', () => {
  const r = unityRecipesFor('character controller wasd jump stairs');

  it('answers the stairs question explicitly', () => {
    // The whole reason this recipe exists: `stepOffset` appears nowhere else
    // in this codebase, and "walks up stairs without issues" is unanswerable
    // without it.
    expect(r).toContain('stepOffset');
    expect(r).toContain('slopeLimit');
  });

  it('warns that isGrounded needs a sustained downward velocity', () => {
    expect(r).toContain('isGrounded');
    expect(r.toLowerCase()).toMatch(/downward|negative|-2f|stick/);
  });

  it('says Move takes a per-frame delta, not a velocity', () => {
    expect(r).toContain('CharacterController.Move');
    expect(r).toContain('Time.deltaTime');
  });

  it('mentions SimpleMove as the trap it is for jumping', () => {
    expect(r).toContain('SimpleMove');
  });

  it('does not hardcode an input API — that comes from the project facts', () => {
    // `input-facts.ts` states the project's ACTUAL input system. A recipe that
    // also taught one would contradict it for half of all projects, which is
    // the exact bug that split input-facts out of unity-context in the first
    // place.
    expect(r).not.toContain('Input.GetAxis');
    expect(r).not.toContain('Keyboard.current');
  });
});

describe('scene-setup recipe — what the agent actually cannot do', () => {
  const r = unityRecipesFor('set up a basic scene so I can play right away');

  it('states that there is no tool to create or configure a GameObject', () => {
    expect(r.toLowerCase()).toMatch(/cannot|no tool/);
    expect(r).toContain('GameObject');
  });

  it('tells the planner to write the manual steps down instead of pretending', () => {
    expect(r).toContain('Inspector');
  });

  it('warns off hand-writing scene YAML', () => {
    expect(r).toContain('.unity');
    expect(r.toLowerCase()).toContain('yaml');
  });
});

describe('UNITY_RECIPES — shape', () => {
  it('gives every recipe a heading, keywords and a body', () => {
    for (const recipe of UNITY_RECIPES) {
      expect(recipe.heading.length).toBeGreaterThan(0);
      expect(recipe.keywords.length).toBeGreaterThan(0);
      expect(recipe.body.length).toBeGreaterThan(200);
    }
  });

  it('stays small enough to inject on every planning send', () => {
    const all = UNITY_RECIPES.map((r) => r.body).join('');
    expect(all.length).toBeLessThan(4000);
  });
});
