/**
 * Bash tool - adapted from PI coding agent
 * Uses operations interface for Tauri API injection.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../types';
import { truncateTail } from './truncate';
import {
  resolveWithinRoot,
  PathOutsideRootError,
  pathOutsideRootMessage,
  type AllowedRoots,
  primaryRoot,
} from './path-utils';

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
  /**
   * When set, the command's working directory is confined to this root (the
   * Assets/ sandbox) and defaults to it. Note: this pins the cwd but cannot stop
   * a command string from `cd`-ing elsewhere — true containment needs a backend
   * guard in execute_command (see plan).
   */
  allowedRoot?: AllowedRoots;
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

      const allowedRoot = options.allowedRoot ?? null;
      let workDir: string;
      try {
        // Default cwd to the sandbox root (Assets/) when set; validate any
        // caller-supplied cwd stays inside it.
        workDir = resolveWithinRoot(paramCwd ?? primaryRoot(allowedRoot) ?? cwd, cwd, allowedRoot);
      } catch (err) {
        if (err instanceof PathOutsideRootError) {
          return { content: [{ type: 'text', text: pathOutsideRootMessage(err) }] };
        }
        throw err;
      }
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
