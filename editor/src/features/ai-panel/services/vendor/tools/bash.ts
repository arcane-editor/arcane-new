/**
 * Bash tool - adapted from PI coding agent
 * Uses operations interface for Tauri API injection.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../types';
import { truncateTail } from './truncate';

const bashSchema = Type.Object({
  command: Type.String({ description: 'The shell command to execute' }),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the command (defaults to project root)' }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: 'Timeout in milliseconds (default: 30000)' }),
  ),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options?: { timeout?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface BashToolOptions {
  operations: BashOperations;
}

export function createBashTool(cwd: string, options: BashToolOptions): AgentTool {
  const ops = options.operations;

  return {
    name: 'bash',
    label: 'bash',
    description:
      'Execute a shell command and return stdout/stderr. Use for running tests, installing packages, checking file systems, git operations, etc.',
    parameters: bashSchema,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult> {
      const { command, cwd: paramCwd, timeout: paramTimeout } = params as BashToolInput;
      if (signal?.aborted) {
        return { content: [{ type: 'text', text: 'Operation aborted' }] };
      }

      const workDir = paramCwd ?? cwd;
      const timeout = paramTimeout ?? 30000;

      try {
        const result = await ops.exec(command, workDir, { timeout });

        const parts: string[] = [];

        if (result.stdout) {
          const truncated = truncateTail(result.stdout);
          parts.push(truncated.content);
          if (truncated.truncated) {
            parts.push(`\n[stdout truncated: showing last ${truncated.outputLines} of ${truncated.totalLines} lines]`);
          }
        }

        if (result.stderr) {
          const truncated = truncateTail(result.stderr);
          parts.push(`STDERR:\n${truncated.content}`);
          if (truncated.truncated) {
            parts.push(`[stderr truncated: showing last ${truncated.outputLines} of ${truncated.totalLines} lines]`);
          }
        }

        if (result.exitCode !== 0) {
          parts.push(`\nExit code: ${result.exitCode}`);
        }

        if (parts.length === 0) {
          parts.push('(no output)');
        }

        return {
          content: [{ type: 'text', text: parts.join('\n') }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing command: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  };
}
