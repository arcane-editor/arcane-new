// Compile-gate — the engine-grounded sibling of the analyzer-gate. After the
// agent writes/edits a .cs file in a Unity project WITH a live bridge, we ask
// Unity to recompile and feed the REAL compiler errors back into the tool
// result, so the model self-corrects on its next turn (the loop naturally
// re-iterates until the file compiles). Pure decorator over the generic
// write/edit tools — no vendor-loop changes, exactly like the analyzer-gate.
//
// Degradation: if the bridge isn't connected, or the compile times out, we
// return the inner result unchanged — the analyzer-gate (which wraps the tool
// underneath this one) has already appended its regex findings, so disconnected
// projects keep a static safety net.
//
// Cost guard: a per-file attempt counter caps repair iterations so an
// un-fixable error (e.g. a missing package, not a code bug) can't loop forever.

import type { AgentTool, AgentToolResult } from '../vendor/types';
import { resolveToCwd } from '../vendor/tools/path-utils';
import { triggerRecompileAndWait } from '../../../unity-bridge';
import type { CompilerMessage } from '../../../../types/unity';
import { bridgeConnected } from './shared';
import { unityApiLookup } from './api-client';

const MAX_ATTEMPTS = 4;

/** error-producing compile attempts per absolute .cs path, for the iteration cap. */
const compileAttempts = new Map<string, number>();

/** Reset the per-file attempt counters. Call at the start of each user send. */
export function resetCompileGate(): void {
  compileAttempts.clear();
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/** Resolve a Unity CompilerMessage.file (project-relative or absolute) → abs path. */
function toAbsPath(file: string, cwd: string): string {
  const norm = normalize(file);
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return norm;
  const base = cwd.endsWith('/') ? cwd : cwd + '/';
  return normalize(base + norm.replace(/^\.?\//, ''));
}

function sameFile(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function formatError(m: CompilerMessage): string {
  return `  • line ${m.line}: ${m.message}`;
}

/** Strip namespace + generics from a type reference → simple name. */
function simpleTypeName(t: string): string {
  let s = t.split('<')[0] ?? t;
  const dot = s.lastIndexOf('.');
  if (dot >= 0) s = s.slice(dot + 1);
  return s.trim();
}

/** Extract (type, missing-member) from a CS1061 / CS0117 "no definition" error. */
function extractMissingMember(message: string): { type: string; member: string } | null {
  if (!/CS1061|CS0117/.test(message)) return null;
  const m = message.match(/'([^']+)' does not contain a definition for '([^']+)'/);
  if (!m || !m[1] || !m[2]) return null;
  return { type: simpleTypeName(m[1]), member: m[2] };
}

/**
 * De-hallucinator: when the compiler reports a missing member (CS1061/CS0117),
 * fetch the type's REAL members from the version-accurate index and inline them,
 * so the weak model corrects to a real API without another tool round-trip.
 * Best-effort — never throws, capped to a couple of types.
 */
async function buildSignatureHints(errors: CompilerMessage[]): Promise<string> {
  const types = new Set<string>();
  for (const e of errors) {
    const hit = extractMissingMember(e.message);
    if (hit) types.add(hit.type);
    if (types.size >= 2) break;
  }
  if (types.size === 0) return '';

  const blocks: string[] = [];
  for (const type of types) {
    try {
      const result = await unityApiLookup(type);
      // Grounding unavailable (signed out / no version / offline / HTTP error) —
      // hints here are best-effort, so skip silently rather than surface the reason.
      if (!result.ok) continue;
      if (result.data.length === 0) continue;
      const members = [...new Set(result.data.map((s) => s.member))].slice(0, 24);
      if (members.length) blocks.push(`Real members of ${type}: ${members.join(', ')}`);
    } catch {
      /* best-effort */
    }
  }
  return blocks.length ? `\n[Unity API] ${blocks.join('\n')}` : '';
}

function appendNote(res: AgentToolResult, text: string): AgentToolResult {
  return { ...res, content: [...res.content, { type: 'text', text }] };
}

export function withUnityCompileGate(tool: AgentTool, cwd: string): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const res = await tool.execute(id, params, signal, onUpdate);
      const p = (params as { path?: string }).path;
      if (!p || !p.toLowerCase().endsWith('.cs')) return res;

      // No live engine → leave the analyzer-gate's findings as the safety net.
      if (!bridgeConnected()) return res;

      const absWritten = resolveToCwd(p, cwd);

      const report = await triggerRecompileAndWait({ signal });
      if (!report) return res; // timed out / bridge dropped — degrade silently

      const errors = (report.messages ?? []).filter((m) => m.type === 'Error');
      if (errors.length === 0) {
        compileAttempts.delete(absWritten);
        return appendNote(res, `\n\n[Unity compile] Clean — no compiler errors.`);
      }

      // Partition: errors in the file we just wrote vs. elsewhere in the project.
      const here = errors.filter((m) => sameFile(toAbsPath(m.file, cwd), absWritten));
      const shown = here.length ? here : errors;
      const elsewhere = errors.length - here.length;

      const attempts = (compileAttempts.get(absWritten) ?? 0) + 1;
      compileAttempts.set(absWritten, attempts);

      if (attempts > MAX_ATTEMPTS) {
        return appendNote(
          res,
          `\n\n[Unity compile] Still ${errors.length} compiler error(s) after ${MAX_ATTEMPTS} attempts — ` +
            `stop auto-fixing and surface these to the user:\n${shown.map(formatError).join('\n')}`,
        );
      }

      let text =
        `\n\n[Unity compile] ${errors.length} compiler error(s) after writing ${p} — fix before finishing:\n` +
        shown.map(formatError).join('\n');
      if (here.length && elsewhere > 0) {
        text += `\n(+${elsewhere} more compiler error(s) elsewhere in the project)`;
      }
      text += await buildSignatureHints(shown);
      text += `\nVerify exact signatures with unity_api_search (pass "Type.Member") before retrying.`;
      return appendNote(res, text);
    },
  };
}
