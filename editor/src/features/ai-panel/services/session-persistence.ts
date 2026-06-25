/**
 * Session persistence — saves/loads AI chat sessions as JSON files.
 * Location: ~/.arcane/sessions/<sessionId>.json
 *
 * Sessions are saved for BOTH agents (Arcane + Claude). Each record carries the
 * agent kind, workspace path, a human title, and (for Claude) the real ACP
 * sessionId so the chat can be resumed via ACP session/load.
 */

import { invoke } from '@tauri-apps/api/core';
import { homeDir, join } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import type { AiMessage } from '../../../stores/ai';
import type {
  AgentKind,
  ChatMode,
  ClaudeEffort,
  ClaudeModel,
  ClaudePermissionMode,
  Effort,
} from './types';

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
  /** Claude only — the real ACP sessionId, for session/load resume. */
  acpSessionId?: string | null;
  claudeModel?: ClaudeModel;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
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
  acpSessionId?: string | null;
  claudeModel?: ClaudeModel;
  claudeEffort?: ClaudeEffort;
  claudePermissionMode?: ClaudePermissionMode;
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
    acpSessionId: input.acpSessionId ?? null,
    claudeModel: input.claudeModel,
    claudeEffort: input.claudeEffort,
    claudePermissionMode: input.claudePermissionMode,
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
    return JSON.parse(content) as SessionData;
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
 * workspace. Reads `~/.arcane/sessions` via plugin-fs (the Rust `read_directory`
 * skips hidden dirs, so it can't enumerate `~/.arcane`).
 */
export async function listSessions(workspacePath?: string | null): Promise<SessionSummary[]> {
  const dir = await getSessionsDir();
  let entries: { name: string; isFile?: boolean }[];
  try {
    entries = await readDir(dir);
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
        agentKind: data.agentKind ?? 'arcane',
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
