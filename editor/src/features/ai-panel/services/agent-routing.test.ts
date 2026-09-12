import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Global Constraint (editor/CLAUDE.md, "Two agent backends now, not one",
 * rule 1): `getChatBackend()` is the ONLY place that branches on the selected
 * agent. Anything that sends on the user's behalf must go through it — in
 * practice via `sendChatMessage`.
 *
 * Until this test existed the rule had no mechanical enforcement, and two
 * one-click actions broke it in exactly the way that is invisible in review:
 * `fixConsoleError` (the console's "Fix" button) and `summarizeSceneDiff` (the
 * scene-diff header) both called `getAgentService().sendMessage` directly, so
 * with Claude selected they silently drove the HOSTED agent instead. Nothing
 * errored; the answer just came from the wrong model, through the wrong tools,
 * against the wrong permission model.
 *
 * A source scan rather than a runtime test because `agent-service` and
 * `chat-backend` both reach `stores/ai` → `stores/theme`, which touches
 * `document` at module-eval time and cannot load under Bun — the same
 * constraint `attachments.ts` and `stage-file.ts` document. Same shape as
 * `check-deep-modules.mjs`'s allowlist, and for the same reason: an
 * individually justified exemption list keeps the NEXT violation visible,
 * where a blanket exemption would hide it.
 */

const SERVICES_DIR = path.resolve(import.meta.dir);

/**
 * Files allowed to drive the hosted agent directly, each because it implements
 * a UnityIDE-only internal that an external agent neither has nor reads.
 *
 * A user-facing "send this for me" action NEVER belongs here — that is the
 * exact mistake this test was written to catch.
 */
const HOSTED_ONLY_ALLOWLIST: Record<string, string> = {
  // The plan controller IS UnityIDE's plan loop — plan phases, plan repair and
  // revise-notes have no counterpart in an external agent, which runs its own.
  'plan-controller.ts': "UnityIDE's plan loop; an external agent never sets planPhase",
  // Replays the last hosted send. The external backend owns its own retry.
  'retry-turn.ts': 'replays a hosted send that only the hosted service recorded',
  // The single documented branch point: it calls getChatBackend() for the
  // external agent and getAgentService() only on the hosted branches.
  'composer-dispatch.ts': 'the documented router; branches through getChatBackend() first',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    out.push(full);
  }
  return out;
}

/** Strips line and block comments, so a rule merely cited in prose is not a violation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('only getChatBackend() may choose the agent', () => {
  it('no service sends through getAgentService() unless it is a justified hosted-only internal', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SERVICES_DIR)) {
      const name = path.basename(file);
      if (name in HOSTED_ONLY_ALLOWLIST) continue;
      const code = stripComments(readFileSync(file, 'utf-8'));
      if (/getAgentService\(\)\s*\.\s*(sendMessage|promptStructured)\s*\(/.test(code)) {
        offenders.push(path.relative(SERVICES_DIR, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the two actions that broke this rule now route through sendChatMessage', () => {
    for (const name of ['fix-console-error.ts', 'summarize-scene-diff.ts']) {
      const code = stripComments(readFileSync(path.join(SERVICES_DIR, name), 'utf-8'));
      expect(code).toContain('sendChatMessage');
      expect(code).not.toContain('getAgentService');
    }
  });

  it('every allowlist entry names a file that still exists and still needs it', () => {
    for (const [name, reason] of Object.entries(HOSTED_ONLY_ALLOWLIST)) {
      const code = stripComments(readFileSync(path.join(SERVICES_DIR, name), 'utf-8'));
      expect(reason.length).toBeGreaterThan(10);
      // A stale exemption is as bad as a missing one: it silently permits a
      // future violation in a file that no longer needs permission.
      expect(code).toContain('getAgentService');
    }
  });
});
