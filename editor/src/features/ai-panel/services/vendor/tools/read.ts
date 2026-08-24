/**
 * Read tool - adapted from PI coding agent
 * Uses operations interface for Tauri API injection.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../types';
import {
  resolveWithinRoot,
  PathOutsideRootError,
  pathOutsideRootMessage,
  addLineNumbers,
  type AllowedRoots,
} from './path-utils';
import { truncateHead } from './truncate';

const readSchema = Type.Object({
  path: Type.String({ description: 'Absolute or relative file path to read' }),
  // Bounded on purpose: `limit: -5` is a legal `Number` and used to reach
  // `lines.slice(0, -5)`, which returns the file MINUS its last five lines and
  // reports it as the whole file. The schema is the only place that can say
  // "1 or more" once something actually validates against it.
  offset: Type.Optional(
    Type.Integer({ minimum: 1, description: 'Line number to start reading from (1-indexed)' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, description: 'Maximum number of lines to read (default: 2000)' }),
  ),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<string>;
  access: (absolutePath: string) => Promise<void>;
}

export interface ReadToolOptions {
  operations: ReadOperations;
  /** When set, file operations are confined to this root (the Assets/ sandbox). */
  allowedRoot?: AllowedRoots;
}

export function createReadTool(cwd: string, options: ReadToolOptions): AgentTool {
  const ops = options.operations;

  return {
    name: 'read',
    label: 'read',
    description:
      'Read the contents of a file. Use offset and limit to read specific line ranges. Output includes line numbers.',
    parameters: readSchema,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult> {
      const { path, offset, limit } = params as ReadToolInput;
      let absolutePath: string;
      try {
        absolutePath = resolveWithinRoot(path, cwd, options.allowedRoot ?? null);
      } catch (err) {
        if (err instanceof PathOutsideRootError) {
          return { content: [{ type: 'text', text: pathOutsideRootMessage(err) }] };
        }
        throw err;
      }

      try {
        await ops.access(absolutePath);
      } catch {
        return {
          content: [{ type: 'text', text: `Error: File not found: ${absolutePath}` }],
        };
      }

      if (signal?.aborted) {
        return { content: [{ type: 'text', text: 'Operation aborted' }] };
      }

      try {
        const raw = await ops.readFile(absolutePath);
        const lines = raw.split('\n');
        const lineOffset = Math.max((offset ?? 1) - 1, 0); // Convert to 0-indexed
        const lineLimit = limit ?? 2000;
        const sliced = lines.slice(lineOffset, lineOffset + lineLimit).join('\n');

        const truncation = truncateHead(sliced);
        const numbered = addLineNumbers(truncation.content, lineOffset + 1);

        let text = numbered;
        if (truncation.truncated) {
          text += `\n\n[Truncated: showing ${truncation.outputLines} of ${lines.length} total lines]`;
        } else if (lineOffset > 0 || lineOffset + lineLimit < lines.length) {
          text += `\n\n[Showing lines ${lineOffset + 1}-${Math.min(lineOffset + lineLimit, lines.length)} of ${lines.length}]`;
        }

        return { content: [{ type: 'text', text }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // `read_file` is Rust's `fs::read_to_string`, so a non-UTF-8 file fails
        // HERE, not at the existence probe above. Reporting it as "not found"
        // (which is what happened while `access` was itself a full read) invites
        // the model to CREATE the file — overwriting the very Unity asset it was
        // trying to inspect. Name the real reason and say not to write it.
        if (/valid utf-?8|invalid utf-?8/i.test(message)) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Error: ${absolutePath} exists but is not UTF-8 text — it is a binary file ` +
                  `(image, model, compiled asset, or a Unity asset serialized in binary mode). ` +
                  `It cannot be read as text. Do NOT write to this path: that would destroy the asset.`,
              },
            ],
          };
        }
        return {
          content: [{ type: 'text', text: `Error reading file: ${message}` }],
        };
      }
    },
  };
}
