import { describe, it, expect } from 'bun:test';
import { scanCSharp } from './csharp-scan';
import { judgeListener, hasUnknownBase, isPartialClass, methodsOf } from './unity-event-ladder';

function judge(source: string, methodName: string, className = 'PauseController') {
  const scan = scanCSharp(source);
  const cls = scan.classes.find((c) => c.name === className)!;
  return judgeListener(scan, cls, methodName);
}

const SIMPLE = `
using UnityEngine;
public class PauseController : MonoBehaviour {
  public void Resume() { }
  public void Quit() { }
  private void Secret() { }
}`;

describe('judgeListener — the reporting cases', () => {
  it('reports a method the class does not declare', () => {
    expect(judge(SIMPLE, 'OnResume').kind).toBe('missing');
  });

  it('suggests the near match', () => {
    expect(judge(SIMPLE, 'Resum').suggestion).toBe('Resume');
  });

  it('reports a method that exists but is not public', () => {
    // The Inspector can only bind public methods, so the wiring is already
    // broken — a distinct and more actionable message than "missing".
    expect(judge(SIMPLE, 'Secret').kind).toBe('not-public');
  });

  it('stays silent when the method is there and public', () => {
    expect(judge(SIMPLE, 'Resume').kind).toBe('resolved');
  });
});

// Each of these is a real pattern that the obvious implementation flags wrongly.
describe('judgeListener — the suppressors', () => {
  it('is silent on a partial class', () => {
    const src = `
      public partial class PauseController : MonoBehaviour {
        public void Resume() { }
      }`;
    // The other half of the class is in a file this scan never saw.
    expect(judge(src, 'OnResume').kind).toBe('partial-class');
  });

  it('is silent when the class derives from a type we cannot read', () => {
    // `UIController : BaseScreen` wired to an inherited `BaseScreen.Close()` is
    // extremely common; without this rung every one of them false-positives.
    const src = `
      public class PauseController : BaseScreen {
        public void Resume() { }
      }`;
    expect(judge(src, 'Close').kind).toBe('inherited-possible');
  });

  it('is NOT silenced by a Unity engine base', () => {
    expect(judge(SIMPLE, 'OnResume').kind).toBe('missing');
  });

  it('is not silenced by interfaces alone', () => {
    const src = `
      public class PauseController : MonoBehaviour, IPointerClickHandler {
        public void Resume() { }
      }`;
    expect(judge(src, 'OnResume').kind).toBe('missing');
  });

  it('is silent on a property accessor', () => {
    // Unity serialises a property setter as `set_Enabled`, and CSharpScan
    // extracts no properties at all — so every one would look missing.
    expect(judge(SIMPLE, 'set_Enabled').kind).toBe('accessor');
    expect(judge(SIMPLE, 'get_Enabled').kind).toBe('accessor');
  });
});

describe('hasUnknownBase', () => {
  const clsOf = (src: string) => scanCSharp(src).classes[0];

  it('treats Unity engine bases as known', () => {
    expect(hasUnknownBase(clsOf('class A : MonoBehaviour { }'))).toBe(false);
    expect(hasUnknownBase(clsOf('class A : ScriptableObject { }'))).toBe(false);
  });

  it('treats an I-prefixed base as an interface, which adds no implementation', () => {
    expect(hasUnknownBase(clsOf('class A : MonoBehaviour, IDragHandler { }'))).toBe(false);
  });

  it('treats a project base as unknown', () => {
    expect(hasUnknownBase(clsOf('class A : BaseScreen { }'))).toBe(true);
  });

  it('treats no base at all as known', () => {
    expect(hasUnknownBase(clsOf('class A { }'))).toBe(false);
  });
});

describe('isPartialClass', () => {
  it('detects partial', () => {
    const scan = scanCSharp('public partial class A : MonoBehaviour { }');
    expect(isPartialClass(scan, scan.classes[0])).toBe(true);
  });

  it('does not fire on a plain class', () => {
    const scan = scanCSharp('public class A : MonoBehaviour { }');
    expect(isPartialClass(scan, scan.classes[0])).toBe(false);
  });

  it('does not leak across an earlier partial class in the same file', () => {
    const src = 'public partial class A { }\npublic class B : MonoBehaviour { public void Go() { } }';
    const scan = scanCSharp(src);
    const b = scan.classes.find((c) => c.name === 'B')!;
    expect(isPartialClass(scan, b)).toBe(false);
  });
});

describe('methodsOf', () => {
  it('returns only the methods inside that class body', () => {
    const src = `
      public class A : MonoBehaviour { public void InA() { } }
      public class B : MonoBehaviour { public void InB() { } }`;
    const scan = scanCSharp(src);
    const a = scan.classes.find((c) => c.name === 'A')!;
    expect(methodsOf(scan, a).map((m) => m.name)).toEqual(['InA']);
  });
});
