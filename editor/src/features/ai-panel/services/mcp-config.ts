/**
 * MCP server configuration for external agents.
 *
 * User-defined MCP servers are stored as JSON at ~/.unityide/mcp-servers.json and
 * passed to the bridge on `session/new` (and `session/load`). The shape mirrors
 * an ACP stdio `mcpServers` entry. Same file-IO pattern as session-persistence.
 *
 * File format (either is accepted):
 *   [ { "name": "...", "command": "...", "args": [...] }, ... ]
 *   { "mcpServers": [ ... ] }
 */

import { invoke } from '@tauri-apps/api/core';
import { homeDir, join } from '@tauri-apps/api/path';
import type { McpServerConfig } from '../../acp';

/**
 * Re-exported from the protocol types rather than redeclared: this is the exact
 * shape that goes on the wire in `session/new`, and two definitions of it would
 * drift.
 */
export type AcpMcpServer = McpServerConfig;

let configPath: string | null = null;

async function getConfigPath(): Promise<string> {
  if (!configPath) {
    const home = await homeDir();
    const dir = await join(home, '.unityide');
    try {
      await invoke('create_directory_recursive', { path: dir });
    } catch {
      // best-effort; read/write will surface a real error if the dir is missing
    }
    configPath = await join(dir, 'mcp-servers.json');
  }
  return configPath;
}

/** Load configured MCP servers. Returns [] if the file is missing or malformed. */
export async function loadMcpServers(): Promise<AcpMcpServer[]> {
  try {
    const path = await getConfigPath();
    const content = await invoke<string>('read_file', { path });
    const parsed: unknown = JSON.parse(content);
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { mcpServers?: unknown }).mcpServers)
        ? (parsed as { mcpServers: unknown[] }).mcpServers
        : [];
    return list.filter(isValidServer);
  } catch {
    return [];
  }
}

export async function saveMcpServers(servers: AcpMcpServer[]): Promise<void> {
  const path = await getConfigPath();
  await invoke('write_file', {
    path,
    contents: JSON.stringify(servers, null, 2),
  });
}

function isValidServer(s: unknown): s is AcpMcpServer {
  return (
    !!s &&
    typeof s === 'object' &&
    typeof (s as { name?: unknown }).name === 'string' &&
    typeof (s as { command?: unknown }).command === 'string'
  );
}
