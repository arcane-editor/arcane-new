/**
 * Memory distiller (spec §4 write path). After a send that did real mutating
 * work, one cheap side-task model call turns the send's outcome into 0–2
 * durable memory candidates plus a rolling task-context paragraph. The
 * request rides the server's side-task lane (`taskType: 'memory'` →
 * INLINE_MODEL, see arcane-server config/routing.ts), so distillation costs
 * fractions of a cent and never burns tier-model rates.
 *
 * Fire-and-forget: a distillation failure must never surface as a send error.
 * All effects go through injected deps (request fn + MemoryFs) for testing.
 */

import { upsertEntry, writeTaskContext, type Today } from './memory-store';
import { MEMORY_CATEGORIES, type MemoryCategory, type MemoryFs } from './memory-types';

export interface DistillerInput {
  userPrompt: string;
  finalAssistantText: string;
  touchedFiles: string[];
}

export interface DistillerDeps {
  /** Sends one non-stream prompt to the side-task lane, returns the reply text. */
  request: (prompt: string) => Promise<string>;
  fs: MemoryFs;
  workspacePath: string;
  today?: Today;
}

const MAX_FACTS = 2;

export function buildDistillerPrompt(input: DistillerInput): string {
  const files = input.touchedFiles.slice(0, 20).join('\n');
  return `You extract durable project memory from an AI coding session in a Unity project.

Reply with ONLY a JSON object, no prose, shaped exactly like:
{"facts": [{"category": "decision|convention|gotcha", "title": "...", "body": "..."}], "taskContext": "..."}

Rules for "facts" (0-${MAX_FACTS} items — fewer is better):
- Only durable, project-specific knowledge: decisions made and why, conventions confirmed, gotchas discovered.
- NOT derivable from the code itself, NOT a summary of what was done, NO code bodies, NO secrets.
- title: one short line naming the fact. body: 1-2 sentences, max 400 chars.
- If nothing qualifies, return an empty facts array — most sessions produce none.

"taskContext": one paragraph (max 500 chars) describing the CURRENT state of work: what was being built, what is done, what remains.

Session:
USER REQUEST: ${input.userPrompt.slice(0, 1000)}
FILES CHANGED:
${files || '(none)'}
ASSISTANT'S FINAL SUMMARY: ${input.finalAssistantText.slice(0, 3000)}`;
}

interface DistillerOutput {
  facts: Array<{ category: MemoryCategory; title: string; body: string }>;
  taskContext: string | null;
}

/** Defensive parse — returns null on anything malformed. */
export function parseDistillerReply(reply: string): DistillerOutput | null {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { facts?: unknown; taskContext?: unknown };

  // Validate first, cap after — a junk element must not consume a slot.
  const facts: DistillerOutput['facts'] = [];
  if (Array.isArray(obj.facts)) {
    for (const f of obj.facts) {
      if (facts.length >= MAX_FACTS) break;
      if (typeof f !== 'object' || f === null) continue;
      const { category, title, body } = f as Record<string, unknown>;
      if (
        typeof category === 'string' &&
        (MEMORY_CATEGORIES as readonly string[]).includes(category) &&
        typeof title === 'string' &&
        title.trim().length > 0 &&
        typeof body === 'string' &&
        body.trim().length > 0
      ) {
        facts.push({ category: category as MemoryCategory, title: title.trim(), body: body.trim() });
      }
    }
  }

  const taskContext =
    typeof obj.taskContext === 'string' && obj.taskContext.trim().length > 0
      ? obj.taskContext.trim()
      : null;

  return { facts, taskContext };
}

export async function distillSend(input: DistillerInput, deps: DistillerDeps): Promise<void> {
  let reply: string;
  try {
    reply = await deps.request(buildDistillerPrompt(input));
  } catch {
    return; // side task — never propagate
  }
  const output = parseDistillerReply(reply);
  if (!output) return;

  for (const fact of output.facts) {
    try {
      await upsertEntry(deps.fs, deps.workspacePath, fact, deps.today);
    } catch {
      // best-effort per fact
    }
  }
  if (output.taskContext) {
    try {
      await writeTaskContext(deps.fs, deps.workspacePath, output.taskContext);
    } catch {
      // best-effort
    }
  }
}
