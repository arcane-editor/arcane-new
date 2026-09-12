import { describe, it, expect, afterEach } from 'bun:test';
import { unityEventListenersRule } from './unity-event-listeners';
import { scanCSharp } from '../services/csharp-scan';
import {
  __setListenerSnapshotForTest,
  type MethodUsage,
} from '../services/unity-events-cache';

const FILE = 'Assets/Scripts/PauseController.cs';

const SOURCE = `
using UnityEngine;
public class PauseController : MonoBehaviour {
  public void Resume() { }
  private void Secret() { }
}`;

function wire(usages: Partial<MethodUsage>[], trustworthy = true) {
  __setListenerSnapshotForTest({
    filePath: FILE,
    guid: 'a'.repeat(32),
    trustworthy,
    usages: usages.map((u) => ({
      methodName: u.methodName ?? 'OnResume',
      path: u.path ?? 'Assets/Prefabs/PauseMenu.prefab',
      gameObject: u.gameObject ?? 'Canvas',
      targetType: u.targetType ?? 'PauseController, Assembly-CSharp',
    })),
  });
}

function run(source = SOURCE) {
  return unityEventListenersRule.run(scanCSharp(source), {
    model: null,
    filePath: FILE,
    unityVersion: '6000.3.11f1',
    monaco: null,
  });
}

afterEach(() => __setListenerSnapshotForTest(null));

describe('unity-event-listeners — silence', () => {
  it('says nothing without a snapshot', () => {
    expect(run()).toEqual([]);
  });

  it('says nothing when the snapshot is untrustworthy', () => {
    // No `.meta`, or the index could not be read. An unread index must never
    // look like a deleted method.
    wire([{ methodName: 'OnResume' }], false);
    expect(run()).toEqual([]);
  });

  it('says nothing when nothing is wired', () => {
    wire([]);
    expect(run()).toEqual([]);
  });

  it('says nothing when the wired method exists and is public', () => {
    wire([{ methodName: 'Resume' }]);
    expect(run()).toEqual([]);
  });

  it('says nothing when the listener targets another class in the file', () => {
    wire([{ methodName: 'Missing', targetType: 'OtherThing, Assembly-CSharp' }]);
    expect(run()).toEqual([]);
  });

  it('says nothing for a partial class, whose other half is unseen', () => {
    wire([{ methodName: 'OnResume' }]);
    const src = 'public partial class PauseController : MonoBehaviour { public void Resume() { } }';
    expect(run(src)).toEqual([]);
  });

  it('says nothing when a base class we cannot read might declare it', () => {
    wire([{ methodName: 'Close' }]);
    const src = 'public class PauseController : BaseScreen { public void Resume() { } }';
    expect(run(src)).toEqual([]);
  });

  it('says nothing for a property accessor', () => {
    wire([{ methodName: 'set_Paused' }]);
    expect(run()).toEqual([]);
  });
});

describe('unity-event-listeners — reporting', () => {
  it('flags a method the class no longer declares', () => {
    wire([{ methodName: 'OnResume' }]);
    const found = run();
    expect(found.map((f) => f.code)).toEqual(['UNITY0502']);
    expect(found[0].severity).toBe('warning');
  });

  it('names where the wiring lives', () => {
    wire([{ methodName: 'OnResume', path: 'Assets/Prefabs/PauseMenu.prefab', gameObject: 'Canvas' }]);
    expect(run()[0].message).toContain('PauseMenu.prefab (Canvas)');
  });

  it('suggests the near match', () => {
    wire([{ methodName: 'Resum' }]);
    expect(run()[0].message).toContain("'Resume'");
  });

  it('underlines the class name, since there is no call site in this file', () => {
    wire([{ methodName: 'OnResume' }]);
    const f = run()[0];
    expect(SOURCE.slice(f.start, f.end)).toBe('PauseController');
  });

  it('flags a non-public method separately — the Inspector cannot bind it', () => {
    wire([{ methodName: 'Secret' }]);
    const found = run();
    expect(found.map((f) => f.code)).toEqual(['UNITY0503']);
    expect(found[0].message).toContain('not public');
  });

  it('reports one finding per method however many prefabs wire it', () => {
    wire([
      { methodName: 'OnResume', path: 'Assets/A.prefab', gameObject: 'One' },
      { methodName: 'OnResume', path: 'Assets/B.prefab', gameObject: 'Two' },
    ]);
    const found = run();
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('2 UnityEvent listeners');
    expect(found[0].message).toContain('A.prefab (One)');
    expect(found[0].message).toContain('B.prefab (Two)');
  });
});
