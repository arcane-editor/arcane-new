/**
 * Bash tool - adapted from PI coding agent
 * Uses operations interface for Tauri API injection.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../types';
import { truncateTail } from './truncate';
import { detectBashMutation, bashMutationNote } from './bash-mutation';
import {
  resolveWithinRoot,
  PathOutsideRootError,
  pathOutsideRootMessage,
  type AllowedRoots,
  primaryRoot,
} from './path-utils';

/**
 * Backend budget when the model does not ask for one. This was 30s, which
 * killed perfectly ordinary agent commands (`bun test`, a build, a package
 * install) mid-flight and reported them as failures.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Hard ceiling on any model-supplied `timeout`, and the value the loop's
 * per-tool budget is derived from (`BASH_TOOL_BUDGET_MS`).
 *
 * The ordering is load-bearing: the BACKEND timeout must always fire before the
 * loop's, or the loop abandons a command that is still running and tells the
 * model it timed out — which is how a build ends up racing the retry the model
 * then issues.
 */
export const MAX_COMMAND_TIMEOUT_MS = 14 * 60_000;

/** The loop-level budget for the bash tool — deliberately outside the backend's. */
export const BASH_TOOL_BUDGET_MS = 15 * 60_000;

const bashSchema = Type.Object({
  command: Type.String({ description: 'The shell command to execute' }),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the command (defaults to project root)' }),
  ),
  timeout: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: `Timeout in milliseconds (default: ${DEFAULT_COMMAND_TIMEOUT_MS}, max: ${MAX_COMMAND_TIMEOUT_MS})`,
    }),
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
  /**
   * Called when a command that appears to modify files completes successfully.
   * Lets the UI mark the turn's checkpoint as incomplete: "Restore this turn"
   * is built on write/edit pre-images and cannot undo what bash did.
   */
  onUncheckpointedChange?: (command: string, reason: string) => void;
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
      const timeout = Math.min(paramTimeout ?? DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);

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

        // Honesty rule (same as the compile gate): a bash file change gets none
        // of the write/edit guarantees — no checkpoint, no compile or analyzer
        // round, no entry in the verified pass. Say so instead of letting the
        // model read a clean exit code as "changed and verified".
        const mutation = result.exitCode === 0 ? detectBashMutation(command) : null;
        if (mutation) {
          parts.push(`\n${bashMutationNote(mutation)}`);
          options.onUncheckpointedChange?.(command, mutation);
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
