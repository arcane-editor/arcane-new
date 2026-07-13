/**
 * Session persistence — saves/loads AI chat sessions as JSON files.
 * Location: ~/.arcane/sessions/<sessionId>.json
 *
 * Each record carries the agent kind, workspace path, a human title, and the
 * transcript. Older records on disk may still carry a now-removed agent kind
 * (e.g. `'claude'`) plus its extra fields; those extra JSON keys are ignored on
 * load and `agentKind` is coerced to a live kind via `coerceAgentKind`, so old
 * sessions restore read-only and run as Arcane.
 */

import { invoke } from '@tauri-apps/api/core';
import { homeDir, join } from '@tauri-apps/api/path';
import type { AiMessage } from '../../../stores/ai';
import { deleteCheckpointsFile } from './checkpoints/checkpoint-store-io';
import { deleteReviewsFile } from './edit-review/review-store-io';
import { coerceAgentKind, type AgentKind, type ChatMode, type Effort } from './types';

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
}

export interface SaveSessionInput {
  id: string;
  mode: ChatMode;
  effort: Effort;
  messages: AiMessage[];
  agentKind: AgentKind;
  workspacePath: string | null;
  title?: string;
}

let sessionsDir: string | null = null;

async function ensureSessionsDirExists(path: string): Promise<void> {
  await invoke('create_directory_recursive', { path });
}

async function getSessionsDir(): Promise<string> {
  if (!sessionsDir) {
    const home = await homeDir();
    sessionsDir = await join(home, '.arcane', 'sessions');
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

/** Saves the session JSON. Returns true on success, false if the write failed. */
export async function saveSession(input: SaveSessionInput): Promise<boolean> {
  const dir = await getSessionsDir();
  const filePath = `${dir}/${input.id}.json`;

  const data: SessionData = {
    id: input.id,
    createdAt: input.messages[0]?.timestamp ?? Date.now(),
    updatedAt: Date.now(),
    mode: input.mode,
    effort: input.effort,
    messages: sanitizeMessagesForPersistence(input.messages),
    agentKind: input.agentKind,
    workspacePath: input.workspacePath,
    title: input.title ?? deriveTitle(input.messages),
  };

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
    const data = JSON.parse(content) as SessionData;
    // Migration: coerce a now-removed agent kind (e.g. 'claude') to a live one
    // so restore/resume treat the session as Arcane rather than crashing.
    data.agentKind = coerceAgentKind(data.agentKind);
    return data;
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
 * workspace. Enumerates `~/.arcane/sessions` via the custom `read_directory`
 * Rust command (scope-exempt, unlike plugin-fs `readDir` which is blocked by the
 * empty fs scope). Session files are named `session_*.json` — not hidden — so the
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
