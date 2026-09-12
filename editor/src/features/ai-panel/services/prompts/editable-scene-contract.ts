export const EDITABLE_SCENE_CONTRACT = `
## Editable scene authoring

- A generated level must exist as saved GameObjects, prefabs, materials and other assets in Edit Mode. Leave representative level content visible and selectable in the Unity Scene view before Play.
- Do not build the whole level from Awake, Start, a runtime initialization attribute, or another runtime-only trigger. Runtime code controls gameplay using the saved scene objects. Procedural games may spawn or recycle saved prefab chunks from a representative authored layout.
- Use the saved-scene authoring workflow after scripts compile. For substantial generation, write an Editor builder and invoke it explicitly through Unity authoring; never attach automatic editor or runtime regeneration attributes.
- When converting a runtime-built game, move construction into an explicitly invoked Editor builder, save its output, wire gameplay to the authored objects, and remove the runtime construction trigger so Play does not replace a designer's edits.
- Inspect existing scenes before modifying them. Apply targeted changes and preserve unrelated roots, prefab overrides and saved designer edits. Never hand-edit scene or prefab YAML.
- Scene work is incomplete until the target scene reopens with persistent dependencies and the authored level is still present before Play. A compile result alone is not scene-authoring evidence.
`;
