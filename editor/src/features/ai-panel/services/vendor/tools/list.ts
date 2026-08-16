/**
 * List tool — recursively enumerate files under a directory, with optional
 * extension filtering. Used by the AI to discover what files exist in the
 * project (the read tool can only fetch a known path).
 *
 * LOCAL: not part of the upstream PI tool set; added for the Arcane editor
 * so ASK and PLAN-planning modes can answer questions like "how many .cs
 * files are there" without granting bash access.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../types';
import {
  resolveWithinRoot,
  PathOutsideRootError,
  pathOutsideRootMessage,
  type AllowedRoots,
  primaryRoot,
} from './path-utils';

const MAX_RESULTS = 2000;

const listSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        'Absolute or relative directory path. Defaults to the workspace root.',
    }),
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description:
        'When true (default), enumerate all descendants. When false, only direct children.',
    }),
  ),
  extensions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional list of file extensions (without the dot, e.g. ["cs", "shader"]) to filter results.',
    }),
  ),
});

export type ListToolInput = Static<typeof listSchema>;

export interface ListOperations {
  /** Recursively enumerate all files (absolute paths) under `absolutePath`. */
  scanAll: (absolutePath: string) => Promise<string[]>;
  /** Single-level directory listing returning entry names + isDir flags. */
  readDirectory: (
    absolutePath: string,
  ) => Promise<{ name: string; isDir: boolean }[]>;
}

export interface ListToolOptions {
  operations: ListOperations;
  /** When set, listing is confined to this root (the Assets/ sandbox). */
  allowedRoot?: AllowedRoots;
}

export function createListTool(cwd: string, options: ListToolOptions): AgentTool {
  const ops = options.operations;

  return {
    name: 'list',
    label: 'list',
    description:
      'List files in a directory. Defaults to recursive scan from the workspace root. Use the `extensions` parameter to narrow results (e.g. ["cs"], ["shader"]). Note: a raw .cs listing does not tell you which Unity assembly a script compiles into — for editor-vs-runtime or per-assembly script questions use get_unity_script_map.',
    parameters: listSchema,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult> {
      const { path, recursive = true, extensions } = params as ListToolInput;
      const allowedRoot = options.allowedRoot ?? null;
      let targetPath: string;
      try {
        // Default to the primary sandbox root (Assets/) when set, else the
        // workspace root.
        targetPath = path
          ? resolveWithinRoot(path, cwd, allowedRoot)
          : (primaryRoot(allowedRoot) ?? cwd);
      } catch (err) {
        if (err instanceof PathOutsideRootError) {
          return { content: [{ type: 'text', text: pathOutsideRootMessage(err) }] };
        }
        throw err;
      }

      try {
        let entries: string[];
        if (recursive) {
          entries = await ops.scanAll(targetPath);
        } else {
          const direct = await ops.readDirectory(targetPath);
          entries = direct.map((e) =>
            `${targetPath.replace(/\/$/, '')}/${e.name}${e.isDir ? '/' : ''}`,
          );
        }

        if (signal?.aborted) {
          return { content: [{ type: 'text', text: 'Operation aborted' }] };
        }

        let filtered = entries;
        if (extensions && extensions.length > 0) {
          const lower = extensions.map((e) => '.' + e.toLowerCase().replace(/^\./, ''));
          filtered = entries.filter((p) => {
            const lp = p.toLowerCase();
            return lower.some((ext) => lp.endsWith(ext));
          });
        }

        const total = filtered.length;
        const shown = filtered.slice(0, MAX_RESULTS);

        const header = extensions && extensions.length > 0
          ? `Found ${total} file(s) under ${targetPath} matching [${extensions.join(', ')}]`
          : `Found ${total} entr${total === 1 ? 'y' : 'ies'} under ${targetPath}`;

        const truncatedNote =
          total > MAX_RESULTS
            ? `\n\n[Truncated: showing ${MAX_RESULTS} of ${total}]`
            : '';

        const body = shown.length > 0 ? shown.join('\n') : '(no matches)';

        return {
          content: [
            {
              type: 'text',
              text: `${header}\n\n${body}${truncatedNote}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error listing directory: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  };
}
