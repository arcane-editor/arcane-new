/**
 * Symlink-aware containment for the file tools.
 *
 * `resolveWithinRoot` (path-utils.ts) is purely LEXICAL: it collapses `..`
 * textually and compares lowercased string prefixes. It never touches the
 * filesystem, so a symlink inside the sandbox resolves to a path that *looks*
 * contained, passes the check, and is then followed by `read_file` /
 * `write_file` straight out of the project.
 *
 * That is not exotic in Unity projects: symlinking a shared asset folder or a
 * package under development into `Assets/` is a standard workflow, which means
 * the sandbox silently covered less than it claimed for exactly the users this
 * app is for.
 *
 * The lexical check stays as the first, cheap line of defence (and keeps its
 * synchronous signature and its tests). This runs after it, and only on the
 * paths a tool is about to actually touch.
 *
 * Two details that make this correct rather than merely strict:
 *
 *  - **The roots are canonicalized too.** On macOS `/tmp` really is
 *    `/private/tmp`, and a workspace under any symlinked parent would otherwise
 *    fail every check — a false positive that would break the app outright.
 *  - **A path that does not exist yet is resolved via its nearest existing
 *    ancestor.** `write` legitimately creates new files; canonicalizing a
 *    missing path just returns it unchanged, which would let a new file inside a
 *    symlinked directory slip through.
 */

import {
  PathOutsideRootError,
  pathOutsideRootMessage,
  resolveWithinRoot,
  type AllowedRoots,
} from './path-utils';
import type { AgentTool } from '../types';

export interface RealPathOps {
  /** Resolves symlinks. Returns the input unchanged when the path does not exist. */
  canonicalize: (absPath: string) => Promise<string>;
  /** True when the path exists (file or directory). */
  exists: (absPath: string) => Promise<boolean>;
}

function rootList(roots: AllowedRoots): string[] {
  if (!roots) return [];
  return typeof roots === 'string' ? [roots] : [...roots];
}

function contains(root: string, target: string): boolean {
  const r = root.replace(/\/+$/, '').toLowerCase();
  const t = target.toLowerCase();
  return t === r || t.startsWith(`${r}/`);
}

/**
 * Canonicalize `absPath`, walking up to the deepest ancestor that exists and
 * re-appending the segments that do not. Bounded by the segment count, so a
 * pathological path cannot spin.
 */
async function realPathAllowingMissing(absPath: string, ops: RealPathOps): Promise<string> {
  const normalized = absPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const tail: string[] = [];

  for (let i = segments.length; i > 0; i--) {
    const candidate = segments.slice(0, i).join('/');
    if (!candidate) break;
    if (await ops.exists(candidate)) {
      const real = (await ops.canonicalize(candidate)).replace(/\\/g, '/').replace(/\/+$/, '');
      return tail.length ? `${real}/${tail.reverse().join('/')}` : real;
    }
    tail.push(segments[i - 1]);
  }

  return normalized;
}

/**
 * Throw `PathOutsideRootError` when `absPath` — after symlink resolution —
 * lands outside every allowed root. A `null` root list means "no sandbox" and
 * is a no-op, matching `resolveWithinRoot`.
 */
export async function assertWithinRootReal(
  absPath: string,
  roots: AllowedRoots,
  ops: RealPathOps,
): Promise<void> {
  if (!roots) return; // no sandbox configured
  const list = rootList(roots);
  if (list.length === 0) throw new PathOutsideRootError(absPath, list);

  const realRoots = await Promise.all(
    list.map(async (r) => (await ops.canonicalize(r)).replace(/\\/g, '/').replace(/\/+$/, '')),
  );
  const realTarget = await realPathAllowingMissing(absPath, ops);

  if (!realRoots.some((r) => contains(r, realTarget))) {
    throw new PathOutsideRootError(absPath, list);
  }
}

/**
 * Wrap a path-taking tool (`read` / `write` / `edit`) so the symlink check runs
 * before it acts.
 *
 * Sits OUTSIDE the whole write gate stack: a refusal must cost nothing — no
 * approval prompt, no checkpoint pre-image, no compile round. The lexical
 * `resolveWithinRoot` inside each tool stays as the first, synchronous filter;
 * this only speaks up for paths that pass it and then resolve elsewhere.
 */
export function withRealPathGuard(
  tool: AgentTool,
  cwd: string,
  options: { allowedRoot: AllowedRoots; ops: RealPathOps },
): AgentTool {
  const { allowedRoot, ops } = options;
  if (!allowedRoot) return tool; // no sandbox — nothing to enforce

  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const path = (params as { path?: unknown } | null)?.path;
      if (typeof path !== 'string' || !path) {
        // Not a path call (or malformed — argument validation already reports
        // that). Nothing for this guard to decide.
        return tool.execute(toolCallId, params, signal, onUpdate);
      }

      let absolutePath: string;
      try {
        absolutePath = resolveWithinRoot(path, cwd, allowedRoot);
      } catch (err) {
        // Already outside lexically — let the tool produce its own message so
        // there is exactly one wording for "outside the project".
        if (err instanceof PathOutsideRootError) {
          return tool.execute(toolCallId, params, signal, onUpdate);
        }
        throw err;
      }

      try {
        await assertWithinRootReal(absolutePath, allowedRoot, ops);
      } catch (err) {
        if (err instanceof PathOutsideRootError) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `${pathOutsideRootMessage(err)} ` +
                  `('${path}' resolves outside the project through a symlink.)`,
              },
            ],
          };
        }
        throw err;
      }

      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}
