/**
 * Write tool - adapted from PI coding agent
 * Uses operations interface for Tauri API injection.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../types';
import {
  resolveWithinRoot,
  PathOutsideRootError,
  pathOutsideRootMessage,
} from './path-utils';

const writeSchema = Type.Object({
  path: Type.String({ description: 'Absolute or relative file path to write' }),
  content: Type.String({ description: 'The full content to write to the file' }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (absolutePath: string) => Promise<void>;
}

export interface WriteToolOptions {
  operations: WriteOperations;
  /** Called after a successful write with the absolute path */
  onFileWritten?: (absolutePath: string) => void;
  /** When set, file operations are confined to this root (the Assets/ sandbox). */
  allowedRoot?: string | null;
}

export function createWriteTool(cwd: string, options: WriteToolOptions): AgentTool {
  const ops = options.operations;

  return {
    name: 'write',
    label: 'write',
    description:
      'Create or overwrite a file with the given content. Parent directories are created automatically.',
    parameters: writeSchema,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult> {
      const { path, content } = params as WriteToolInput;
      let absolutePath: string;
      try {
        absolutePath = resolveWithinRoot(path, cwd, options.allowedRoot ?? null);
      } catch (err) {
        if (err instanceof PathOutsideRootError) {
          return { content: [{ type: 'text', text: pathOutsideRootMessage(err) }] };
        }
        throw err;
      }

      if (signal?.aborted) {
        return { content: [{ type: 'text', text: 'Operation aborted' }] };
      }

      try {
        // Create parent directories
        const parentDir = absolutePath.substring(0, absolutePath.lastIndexOf('/'));
        if (parentDir) {
          try {
            await ops.mkdir(parentDir);
          } catch {
            // Directory may already exist
          }
        }

        await ops.writeFile(absolutePath, content);

        const lineCount = content.split('\n').length;
        const byteCount = new TextEncoder().encode(content).length;

        options.onFileWritten?.(absolutePath);

        return {
          content: [
            {
              type: 'text',
              text: `Successfully wrote ${byteCount} bytes (${lineCount} lines) to ${absolutePath}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error writing file: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  };
}
