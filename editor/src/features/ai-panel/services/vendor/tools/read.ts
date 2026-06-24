/**
 * Read tool - adapted from PI coding agent
 * Uses operations interface for Tauri API injection.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../types';
import { resolveToCwd, addLineNumbers } from './path-utils';
import { truncateHead } from './truncate';

const readSchema = Type.Object({
  path: Type.String({ description: 'Absolute or relative file path to read' }),
  offset: Type.Optional(
    Type.Number({ description: 'Line number to start reading from (1-indexed)' }),
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Maximum number of lines to read (default: 2000)' }),
  ),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<string>;
  access: (absolutePath: string) => Promise<void>;
}

export interface ReadToolOptions {
  operations: ReadOperations;
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
      const absolutePath = resolveToCwd(path, cwd);

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
        return {
          content: [
            {
              type: 'text',
              text: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  };
}
