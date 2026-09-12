// The property that matters most (F1 of Task 14's review round 1): the size
// cap must bound WORK, not just the answer — an oversized scene must never
// reach `readFiles` at all, not be read and then discarded.

import { describe, it, expect } from 'bun:test';
import { readUiStackSignals, type UiStackScanDeps } from './ui-stack-scan';

const WS = '/ws';
const CANVAS_MARKER = '--- !u!223 &1\nCanvas:\n  m_Enabled: 1\n';

// `sizesOf`/`readFiles` are wrapped, not replaced, by an override — every
// test's call-tracking stays intact whether or not it supplies its own
// implementation for either.
function harness(overrides: Partial<UiStackScanDeps> = {}) {
  const readCalls: string[][] = [];
  const sizeCalls: string[][] = [];
  const scan = overrides.scan ?? (async () => []);
  const sizesOf = overrides.sizesOf ?? (async (paths) => paths.map((path) => ({ path, size: 0 })));
  const readFiles = overrides.readFiles ?? (async (paths) => paths.map((path) => ({ path, content: '' })));
  const deps: UiStackScanDeps = {
    scan,
    async sizesOf(paths) {
      sizeCalls.push(paths);
      return sizesOf(paths);
    },
    async readFiles(paths) {
      readCalls.push(paths);
      return readFiles(paths);
    },
  };
  return { deps, readCalls, sizeCalls };
}

describe('readUiStackSignals — the size cap bounds work, not just the answer', () => {
  it('never passes an oversized scene/prefab path to readFiles', async () => {
    const { deps, readCalls } = harness({
      scan: async () => ['Assets/Small.unity', 'Assets/Huge.unity'],
      sizesOf: async (paths) =>
        paths.map((path) => ({
          path,
          size: path.includes('Huge') ? 3 * 1024 * 1024 : 1024,
        })),
      readFiles: async (paths) => paths.map((path) => ({ path, content: CANVAS_MARKER })),
    });
    await readUiStackSignals(WS, deps);
    const allReadPaths = readCalls.flat();
    expect(allReadPaths).toContain('Assets/Small.unity');
    expect(allReadPaths).not.toContain('Assets/Huge.unity');
  });

  it('sizes every scene/prefab candidate before reading any of them', async () => {
    const { deps, sizeCalls, readCalls } = harness({
      scan: async () => ['Assets/A.unity', 'Assets/B.prefab'],
    });
    await readUiStackSignals(WS, deps);
    expect(sizeCalls.flat().sort()).toEqual(['Assets/A.unity', 'Assets/B.prefab']);
    // Both under the (default 0-size) cap, so both get read.
    expect(readCalls.flat().filter((p) => p.endsWith('.unity') || p.endsWith('.prefab'))).toEqual([
      'Assets/A.unity',
      'Assets/B.prefab',
    ]);
  });

  it('counts a Canvas only in a scene/prefab at or under the cap', async () => {
    const { deps } = harness({
      scan: async () => ['Assets/Small.unity', 'Assets/Huge.unity'],
      sizesOf: async (paths) =>
        paths.map((path) => ({ path, size: path.includes('Huge') ? 3 * 1024 * 1024 : 1024 })),
      readFiles: async (paths) => paths.map((path) => ({ path, content: CANVAS_MARKER })),
    });
    const result = await readUiStackSignals(WS, deps);
    expect(result.canvasScenes).toBe(1);
  });

  it('a file exactly at the cap is still read', async () => {
    const CAP = 2 * 1024 * 1024;
    const { deps, readCalls } = harness({
      scan: async () => ['Assets/AtCap.unity'],
      sizesOf: async (paths) => paths.map((path) => ({ path, size: CAP })),
    });
    await readUiStackSignals(WS, deps);
    expect(readCalls.flat()).toContain('Assets/AtCap.unity');
  });
});

describe('readUiStackSignals — PanelSettings', () => {
  it('counts .asset files that serialize a PanelSettings', async () => {
    const { deps } = harness({
      scan: async () => ['Assets/UI/Panel.asset', 'Assets/Data/Other.asset'],
      readFiles: async (paths) =>
        paths.map((path) => ({
          path,
          content: path.includes('Panel')
            ? 'MonoBehaviour:\n  m_Script: {...}\n  ...UnityEngine.UIElements.PanelSettings...'
            : 'MonoBehaviour:\n  m_Script: {...}\n',
        })),
    });
    const result = await readUiStackSignals(WS, deps);
    expect(result.panelSettingsCount).toBe(1);
  });

  // Fix round 1, M2: this scan and `unity-facts.ts`'s `readPanelSettingsFacts`
  // must not disagree about which `.asset` files are even eligible to be
  // read — same 2 MB stat-first cap on both.
  it('never passes an oversized .asset path to readFiles, and does not count it', async () => {
    const { deps, readCalls, sizeCalls } = harness({
      scan: async () => ['Assets/UI/Small.asset', 'Assets/UI/Huge.asset'],
      sizesOf: async (paths) =>
        paths.map((path) => ({
          path,
          size: path.includes('Huge') ? 3 * 1024 * 1024 : 1024,
        })),
      readFiles: async (paths) =>
        paths.map((path) => ({
          path,
          content: 'MonoBehaviour:\n  m_Script: {...}\n  ...UnityEngine.UIElements.PanelSettings...',
        })),
    });
    const result = await readUiStackSignals(WS, deps);
    expect(sizeCalls.flat()).toContain('Assets/UI/Small.asset');
    expect(sizeCalls.flat()).toContain('Assets/UI/Huge.asset');
    expect(readCalls.flat()).toContain('Assets/UI/Small.asset');
    expect(readCalls.flat()).not.toContain('Assets/UI/Huge.asset');
    // Only the under-cap asset was ever read, so only it can be counted.
    expect(result.panelSettingsCount).toBe(1);
  });
});

describe('readUiStackSignals — degradation', () => {
  it('degrades to 0/0 when the scan itself fails', async () => {
    const { deps } = harness({
      scan: async () => {
        throw new Error('scan failed');
      },
    });
    expect(await readUiStackSignals(WS, deps)).toEqual({ panelSettingsCount: 0, canvasScenes: 0 });
  });

  it('a failing size/read chunk narrows the answer rather than throwing', async () => {
    const { deps } = harness({
      scan: async () => ['Assets/A.unity'],
      sizesOf: async () => {
        throw new Error('sizesOf failed');
      },
    });
    // panelSettingsCount still resolves (independent of the scene path failing).
    expect(await readUiStackSignals(WS, deps)).toEqual({ panelSettingsCount: 0, canvasScenes: 0 });
  });
});
