/**
 * Task-class recipes, injected into the PLANNING prompt only.
 *
 * `unity-facts.ts` states what this project IS; `unity-contrast.ts` corrects
 * training defaults that are wrong for it. Neither says anything about how to
 * do a particular KIND of job — and for the jobs users actually ask for, the
 * gap is total. A repo-wide grep for `CharacterController` finds it once, in a
 * syntax-highlighting token list; `stepOffset`, `slopeLimit` and `stairs`
 * appear nowhere at all. So "a capsule that walks up stairs without any
 * issues" — a request with one well-known correct answer — was planned
 * entirely from the model's own recall, against a budget model, with nothing
 * to check it.
 *
 * Two rules keep these from becoming a second, competing source of truth:
 *
 * 1. **Planning only.** `unity-context.ts` is injected into every prompt in
 *    every mode, so anything put there is paid for on every send forever.
 *    These are selected by keyword and only while drafting a plan.
 * 2. **Never state anything project-specific.** No input API, no render
 *    pipeline, no version. `input-facts.ts` and `unity-facts.ts` own those and
 *    are computed from the actual project — a recipe that also taught an input
 *    API would be wrong for half of all projects, which is the exact bug that
 *    caused the input crib to be split out of `unity-context.ts`.
 */

export interface UnityRecipe {
  heading: string;
  /** Lowercased substrings; any match selects the recipe. */
  keywords: string[];
  body: string;
}

export const UNITY_RECIPES: UnityRecipe[] = [
  {
    heading: '### Character controllers',
    keywords: [
      'character controller',
      'player controller',
      'playercontroller',
      'first person',
      'first-person',
      'third person',
      'third-person',
      'player movement',
      'move the player',
      'player move',
      'wasd',
      'walk',
      'jump',
      'capsule',
      'stairs',
      'staircase',
      'locomotion',
    ],
    body: `- **Pick one and say why.** \`CharacterController\` for direct, responsive movement that
  should not be pushed around by physics — the usual choice for a player capsule.
  A \`Rigidbody\` only when the player must be shoved by forces, collide dynamically,
  or ride moving platforms. Do not mix: driving a Rigidbody's transform directly
  fights the solver.
- **\`CharacterController.Move(motion)\` takes a per-frame DELTA in world space**, not a
  velocity — multiply by \`Time.deltaTime\` yourself. Call it once per frame with the
  combined horizontal and vertical motion; calling it twice applies collision
  resolution twice and jitters.
- **\`SimpleMove\` is a trap for anything that jumps**: it applies gravity itself and
  discards the Y component, so a jump written on top of it does nothing.
- **\`isGrounded\` is only meaningful right after a \`Move\` call**, and it flickers false on
  flat ground unless the controller is being pushed down. Keep a vertical velocity
  float and, when grounded and not jumping, clamp it to a small negative value
  (about \`-2f\`) rather than zero so the capsule stays in contact.
- **Gravity is yours to integrate**: \`velocity.y += Physics.gravity.y * Time.deltaTime\`
  every frame, then feed \`velocity.y * Time.deltaTime\` into the same \`Move\` call.
  For a jump of a chosen height, \`velocity.y = Mathf.Sqrt(height * -2f * Physics.gravity.y)\`.
- **Stairs are \`stepOffset\`.** It is the tallest riser the controller will step onto
  (default 0.3). A step taller than it reads as a wall. It must stay below the
  controller's height, and values above roughly the radius behave unpredictably —
  for taller steps, ramp the geometry or add an invisible ramp collider instead of
  inflating it.
- **\`slopeLimit\`** (degrees, default 45) decides what counts as walkable rather than a
  wall; **\`skinWidth\`** (about 10% of the radius) prevents jitter and stuck contacts;
  **\`minMoveDistance\` should be 0** or small movements are silently discarded.
- **Capsule sizing**: a human-scale player is roughly height 2, radius 0.5, centre
  (0, 1, 0) so the capsule's feet sit on the origin. A visual mesh child must not
  carry its own collider.
- Read input through whatever this project's Unity project facts say it uses; do not
  assume an input API.`,
  },
  {
    heading: '### Setting up a scene',
    keywords: [
      'scene',
      'set up',
      'setup',
      'bootstrap',
      'play right away',
      'playable',
      'prefab',
      'level',
    ],
    body: `- **A generated level is authored content.** It must exist as saved, selectable
  GameObjects and assets in Edit Mode and be visible in the Scene view before Play.
- **Use \`unity_author\` after scripts compile.** For large layouts, write an Editor builder
  that runs once through the authoring operation, updates a declared root, and saves all
  generated meshes, materials and prefabs. Do not run it from Awake, Start,
  RuntimeInitializeOnLoadMethod, InitializeOnLoad or ExecuteAlways.
- **Convert runtime-built levels completely.** Move construction to the Editor builder,
  execute it, save the scene, wire gameplay scripts to the saved objects, and remove the
  runtime construction trigger. Play must use the designer-editable scene rather than
  replace it.
- **Modify existing scenes surgically.** Inspect the hierarchy first, target the intended
  saved objects, and preserve unrelated roots, prefab overrides and designer changes.
- **Do not hand-write \`.unity\` or \`.prefab\` YAML.** Use structured Unity authoring and
  verify that the scene reopens with its persistent dependencies.`,
  },
];

/**
 * The recipes matching a request, as a markdown block, or '' when none do.
 * Matching is on plain lowercased substrings — deliberately blunt, since a
 * false positive costs a few hundred tokens and a false negative costs the
 * grounding the plan needed.
 */
export function unityRecipesFor(prompt: string): string {
  if (typeof prompt !== 'string' || !prompt.trim()) return '';
  const haystack = prompt.toLowerCase();

  const matched = UNITY_RECIPES.filter((r) => r.keywords.some((k) => haystack.includes(k)));
  if (matched.length === 0) return '';

  return (
    `\n## How to do this kind of work in Unity\n\n` +
    `Authoritative for the topics they cover — prefer them over recall, and fold the ` +
    `specifics into the Guide entries rather than restating them as prose.\n\n` +
    matched.map((r) => `${r.heading}\n${r.body}`).join('\n\n')
  );
}
