import type { HierarchyComponent, HierarchyNode, SceneHierarchy } from '../../unity-bridge';

/** A component the bridge resolved to a real script under `Assets/`. */
export type ScriptComponent = HierarchyComponent & {
  script: { path: string; guid: string };
};

/**
 * The project scripts attached to a GameObject.
 *
 * The panel previously listed every component — Transform, BoxCollider,
 * MeshRenderer — each looking clickable, while clicking only meant anything for
 * a project script. Built-ins have no source a user can open, so listing them
 * is noise that buries the two rows that matter.
 *
 * `script` is attached by the Unity bridge (`HierarchySerializer`), which
 * resolves it through `MonoScript.FromMonoBehaviour` and only emits it for
 * paths under `Assets/`. That makes this an exact filter rather than a guess.
 */
export function scriptsOf(node: HierarchyNode): ScriptComponent[] {
  return node.components.filter(
    (c): c is ScriptComponent =>
      typeof c.script === 'object' &&
      c.script !== null &&
      typeof (c.script as { path?: unknown }).path === 'string' &&
      (c.script as { path: string }).path.length > 0,
  );
}

/**
 * Whether this hierarchy carries script identity at all.
 *
 * An installed Unity package older than the `script` field sends none, which
 * per-GameObject is indistinguishable from "this object has no scripts". The
 * panel therefore has to decide across the whole hierarchy: if nothing
 * anywhere carries it, the package is outdated and the user is told to update
 * it — rather than being shown every GameObject as empty and concluding the
 * panel is broken.
 */
export function hierarchyHasScriptIdentity(hierarchy: SceneHierarchy | null): boolean {
  if (!hierarchy) return false;
  const stack: HierarchyNode[] = [];
  for (const scene of hierarchy.scenes) stack.push(...scene.roots);

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (scriptsOf(node).length > 0) return true;
    stack.push(...node.children);
  }
  return false;
}
