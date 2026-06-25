/**
 * Edit tool - adapted from PI coding agent
 * Search-and-replace with diff generation.
 * Uses operations interface for Tauri API injection.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../types';
import {
  resolveWithinRoot,
  PathOutsideRootError,
  pathOutsideRootMessage,
} from './path-utils';
import { applyEdits, generateDiff, type Edit } from './edit-diff';

const editSchema = Type.Object({
  path: Type.String({ description: 'Absolute or relative file path to edit' }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: 'The exact text to find and replace' }),
      newText: Type.String({ description: 'The replacement text' }),
    }),
    { description: 'Array of search-and-replace edits to apply' },
  ),
});

export type EditToolInput = Static<typeof editSchema>;

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<string>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

export interface EditToolOptions {
  operations: EditOperations;
  /** Called after a successful edit with the absolute path */
  onFileEdited?: (absolutePath: string) => void;
  /** When set, file operations are confined to this root (the Assets/ sandbox). */
  allowedRoot?: string | null;
}

export function createEditTool(cwd: string, options: EditToolOptions): AgentTool {
  const ops = options.operations;

  return {
    name: 'edit',
    label: 'edit',
    description:
      'Make targeted edits to a file using search-and-replace. Each edit specifies exact text to find and its replacement. All edits are matched against the original file content.',
    parameters: editSchema,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult> {
      const { path, edits: editInputs } = params as EditToolInput;
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
        const originalContent = await ops.readFile(absolutePath);

        const edits: Edit[] = editInputs.map((e) => ({
          oldText: e.oldText,
          newText: e.newText,
        }));

        const result = applyEdits(originalContent, edits);

        if (!result.applied) {
          return {
            content: [{ type: 'text', text: result.error ?? 'Failed to apply edits' }],
          };
        }

        // Write the modified content
        await ops.writeFile(absolutePath, result.content);

        // Generate diff for display
        const { diff } = generateDiff(originalContent, result.content, absolutePath);

        options.onFileEdited?.(absolutePath);

        return {
          content: [
            {
              type: 'text',
              text: `Successfully edited ${absolutePath}\n\n${diff}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error editing file: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  };
}
