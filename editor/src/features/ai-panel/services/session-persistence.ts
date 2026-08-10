/**
 * Session persistence — saves/loads AI chat sessions as JSON files.
 * Location: <per-app config dir>/sessions/<sessionId>.json — i.e. ~/.arcane/sessions
 * for prod builds, ~/.arcane-dev/sessions for dev builds (see `getSessionsDir`).
 *
 * Each record carries the agent kind, workspace path, a human title, and the
 * transcript. Older records on disk may still carry a now-removed agent kind
 * (e.g. `'claude'`) plus its extra fields; those extra JSON keys are ignored on
 * load and `agentKind` is coerced to a live kind via `coerceAgentKind`, so old
 * sessions restore read-only and run as Arcane.
 */

import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import type { AiMessage, ArcanePlanEntry } from '../../../stores/ai';
import { deleteCheckpointsFile } from './checkpoints/checkpoint-store-io';
import { deleteReviewsFile } from './edit-review/review-store-io';
import { coerceAgentKind, type AgentKind, type ChatMode, type Effort } from './types';

/**
 * A plan produced by this session.
 *
 * Optional on both records, exactly like `arcanePlan`: session files written
 * before this existed simply have no key, `JSON.parse` leaves it undefined,
 * and an old session loads unchanged.
 */
export interface PlanRef {
  /** Absolute path of the plan file. */
  path: string;
  /** Human title, derived from the prompt that produced it. */
  title: string;
  createdAt: number;
  status: 'draft' | 'executing' | 'done' | 'failed';
}

export interface SessionData {
  id: string;
  createdAt: number;
  updatedAt: number;
  mode: ChatMode;
  effort: Effort;
  messages: AiMessage[];
  // Added for unified history + resume:
  agentKind: AgentKind;
  workspacePath: string | null;
  title: string;
  /**
   * Arcane's in-loop todo list (`todo_update`, T9) — persisted so it survives
   * reload/resume. Optional because session files written before T9 never
   * wrote this key: `JSON.parse` simply leaves it `undefined` on load, which
   * `loadSessionIntoStore` (stores/ai.ts) coerces to `null` — same as a
   * brand-new session with no plan yet.
   */
  arcanePlan?: ArcanePlanEntry[] | null;
  /**
   * Markdown plans this session produced, so they are reachable from chat
   * history rather than only from the conversation that made them. See
   * `PlanRef`.
   */
  plans?: PlanRef[];
}

/** Lightweight header used by the history list (no full message bodies). */
export interface SessionSummary {
  id: string;
  title: string;
  agentKind: AgentKind;
  workspacePath: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** How many plans this session produced; 0 for sessions that made none. */
  planCount: number;
}

export interface SaveSessionInput {
  id: string;
  mode: ChatMode;
  effort: Effort;
  messages: AiMessage[];
  agentKind: AgentKind;
  workspacePath: string | null;
  title?: string;
  /** See `SessionData.arcanePlan`. */
  arcanePlan?: ArcanePlanEntry[] | null;
  /** See `SessionData.plans`. */
  plans?: PlanRef[];
}

let sessionsDir: string | null = null;

async function ensureSessionsDirExists(path: string): Promise<void> {
  await invoke('create_directory_recursive', { path });
}

async function getSessionsDir(): Promise<string> {
  if (!sessionsDir) {
    // Per-app dir (~/.arcane or ~/.arcane-dev) so the side-by-side dev
    // build never shares/corrupts the prod app's session files.
    const arcaneHome = await invoke<string>('get_arcane_home_dir');
    sessionsDir = await join(arcaneHome, 'sessions');
    try {
      await ensureSessionsDirExists(sessionsDir);
    } catch (error) {
      console.warn('Failed to create sessions directory:', error);
    }
  }
  return sessionsDir;
}

export function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Derive a short, human-readable title from the first user message. */
function deriveTitle(messages: AiMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.text);
  const text = (firstUser?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'New chat';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * Strip raw image data from attachments before persisting so session JSON files
 * don't balloon. The dataUrl is replaced with a placeholder; mimeType and label
 * are preserved so chips still render on reload.
 */
function sanitizeMessagesForPersistence(messages: AiMessage[]): AiMessage[] {
  return messages.map((m) => {
    if (!m.attachments || m.attachments.length === 0) return m;
    return {
      ...m,
      attachments: m.attachments.map((a) =>
        a.kind === 'image' ? { ...a, dataUrl: '' } : a,
      ),
    };
  });
}

/**
 * Pure — builds the on-disk record for a save input. No Tauri calls, so this
 * (and `parseSessionData` below) is directly Bun-testable without a Tauri
 * runtime, mirroring `checkpoint-store-io.ts`'s `serializeCheckpoints`/
 * `parseCheckpoints` split.
 */
export function buildSessionData(input: SaveSessionInput): SessionData {
  return {
    id: input.id,
    createdAt: input.messages[0]?.timestamp ?? Date.now(),
    updatedAt: Date.now(),
    mode: input.mode,
    effort: input.effort,
    messages: sanitizeMessagesForPersistence(input.messages),
    agentKind: input.agentKind,
    workspacePath: input.workspacePath,
    title: input.title ?? deriveTitle(input.messages),
    arcanePlan: input.arcanePlan ?? null,
    // Omitted entirely when there are none, so a session file for a
    // plain chat is unchanged in shape.
    ...(input.plans && input.plans.length > 0 ? { plans: input.plans } : {}),
  };
}

/**
 * Pure — parses a saved session JSON string, applying the `agentKind`
 * migration coercion (see module doc). No Tauri calls.
 */
export function parseSessionData(json: string): SessionData {
  const data = JSON.parse(json) as SessionData;
  data.agentKind = coerceAgentKind(data.agentKind);
  return data;
}

/** Saves the session JSON. Returns true on success, false if the write failed. */
export async function saveSession(input: SaveSessionInput): Promise<boolean> {
  const dir = await getSessionsDir();
  const filePath = `${dir}/${input.id}.json`;
  const data = buildSessionData(input);

  try {
    await invoke('write_file', { path: filePath, contents: JSON.stringify(data, null, 2) });
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error ?? '');
    const missingDir = /No such file|os error 2|ENOENT/i.test(msg);
    if (missingDir) {
      try {
        await ensureSessionsDirExists(dir);
        await invoke('write_file', { path: filePath, contents: JSON.stringify(data, null, 2) });
        return true;
      } catch (retryError) {
        console.error('Failed to save session (retry):', retryError);
        return false;
      }
    }
    console.error('Failed to save session:', error);
    return false;
  }
}

export async function loadSession(sessionId: string): Promise<SessionData | null> {
  const dir = await getSessionsDir();
  const filePath = `${dir}/${sessionId}.json`;
  try {
    const content = await invoke<string>('read_file', { path: filePath });
    // parseSessionData applies the agentKind migration coercion (a now-removed
    // agent kind like 'claude' restores as 'arcane' rather than crashing).
    return parseSessionData(content);
  } catch {
    return null;
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const dir = await getSessionsDir();
  const filePath = `${dir}/${sessionId}.json`;
  try {
    await invoke('delete_path', { path: filePath });
  } catch (error) {
    console.warn('Failed to delete session:', error);
  }
  // GC (P5.2): co-delete this session's checkpoint file — the checkpoint
  // sibling of a `.meta` co-delete. Best-effort; a missing file is fine.
  await deleteCheckpointsFile(sessionId).catch(() => {});
  // GC (T7): co-delete this session's pending-review file too.
  await deleteReviewsFile(sessionId).catch(() => {});
}

/** Rename (re-title) a session in place. */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  const data = await loadSession(sessionId);
  if (!data) return;
  data.title = title;
  const dir = await getSessionsDir();
  try {
    await invoke('write_file', {
      path: `${dir}/${sessionId}.json`,
      contents: JSON.stringify(data, null, 2),
    });
  } catch (error) {
    console.warn('Failed to rename session:', error);
  }
}

/**
 * List saved sessions as summaries, newest first. Optionally scoped to a
 * workspace. Enumerates the per-app config dir's `sessions` folder (`~/.arcane/sessions`
 * or `~/.arcane-dev/sessions`) via the custom `read_directory` Rust command
 * (scope-exempt, unlike plugin-fs `readDir` which is blocked by the empty fs
 * scope). Session files are named `session_*.json` — not hidden — so the
 * command's hidden-name skip doesn't drop them.
 */
export async function listSessions(workspacePath?: string | null): Promise<SessionSummary[]> {
  const dir = await getSessionsDir();
  let entries: { name: string; is_dir: boolean }[];
  try {
    entries = await invoke<{ name: string; is_dir: boolean }[]>('read_directory', { path: dir });
  } catch {
    return [];
  }

  const files = entries.filter((e) => e.name && e.name.endsWith('.json'));
  const summaries: SessionSummary[] = [];
  for (const f of files) {
    try {
      const content = await invoke<string>('read_file', { path: `${dir}/${f.name}` });
      const data = JSON.parse(content) as SessionData;
      if (!data?.id) continue;
      summaries.push({
        id: data.id,
        title: data.title ?? deriveTitle(data.messages ?? []),
        agentKind: coerceAgentKind(data.agentKind),
        workspacePath: data.workspacePath ?? null,
        createdAt: data.createdAt ?? 0,
        updatedAt: data.updatedAt ?? 0,
        messageCount: data.messages?.length ?? 0,
        // Absent on sessions written before plans were linked.
        planCount: data.plans?.length ?? 0,
      });
    } catch {
      // skip malformed files
    }
  }

  const scoped =
    workspacePath != null
      ? summaries.filter((s) => s.workspacePath === workspacePath)
      : summaries;
  scoped.sort((a, b) => b.updatedAt - a.updatedAt);
  return scoped;
}

export async function loadLatestSession(
  workspacePath?: string | null,
): Promise<SessionData | null> {
  const list = await listSessions(workspacePath);
  if (list.length === 0) return null;
  return loadSession(list[0].id);
}
