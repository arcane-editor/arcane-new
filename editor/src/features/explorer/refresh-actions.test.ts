import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const RAW = readFileSync(
  path.resolve(import.meta.dir, 'components/ExplorerPanel.tsx'),
  'utf8',
);

/**
 * Assert on code, not prose. The fix leaves a comment explaining *why*
 * setWorkspace must not be called here, and a naive source match would read
 * that explanation as the very call it forbids.
 */
const PANEL = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * Refresh and Collapse All both called `setWorkspace(workspacePath)` — the full
 * workspace-switch action. It closes every tab with NO dirty prompt, kills every
 * terminal mid-command, resets the AI conversation, restarts the LSP, and clears
 * `recentlyClosed`, so Cmd+Shift+T cannot bring the tabs back and the
 * persistence subscriber writes the empty tab list a second later.
 *
 * Every other close path in the app awaits `confirmCloseDirty` first. A
 * behavioural test would need the whole Tauri surface mocked; what regressed is
 * one wrong call, so assert on the call.
 */
describe('explorer header actions', () => {
  it('never calls setWorkspace — that discards unsaved editor state', () => {
    expect(PANEL).not.toMatch(/setWorkspace\s*\(/);
  });

  it('refreshes the tree instead', () => {
    expect(PANEL).toMatch(/refreshTree\s*\(/);
  });

  it('collapses via the tree API rather than reloading the workspace', () => {
    expect(PANEL).toMatch(/treeApiRef\.current\?\.closeAll\(\)/);
  });
});
