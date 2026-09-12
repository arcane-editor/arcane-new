// Deciding whether a `UnityEvent` listener is genuinely broken.
//
// A prefab's `m_OnClick` stores a METHOD NAME as a string. Rename the method and
// Unity says nothing: the button just stops responding, at runtime, in a build.
// `unity_index.rs` already resolves which methods a prefab wires to a script;
// the missing half is "does that method still exist", and that turns out to be
// the part with all the false positives in it.
//
// Four things make the naive answer wrong, and each gets a rung:
//   - a `partial` class has other halves this scanner cannot see;
//   - a method may be INHERITED from a base class we cannot read;
//   - Unity serialises property setters as `set_Foo`, and the scanner extracts
//     no properties at all (`CSharpScan` has methods, fields, classes, enums);
//   - an empty usage list is ambiguous between "nothing wires this" and "the
//     index was not ready", so it can never be treated as evidence.
//
// Pure and store-free, so it is exercised directly under Bun's DOM-less runtime.

import type { CSharpScan, ClassDecl, MethodDecl } from './csharp-scan';
import { offsetInSpan } from './csharp-scan';

export type ListenerVerdictKind =
  /** Reported: nothing in this class declares the method. */
  | 'missing'
  /** Reported: it exists but is not public, so the Inspector cannot call it. */
  | 'not-public'
  /** Silent: found and callable. */
  | 'resolved'
  /** Silent: the class is `partial`; the method may live in another part. */
  | 'partial-class'
  /** Silent: a base class we cannot read may declare it. */
  | 'inherited-possible'
  /** Silent: a property accessor, which the scanner does not model. */
  | 'accessor';

export interface ListenerVerdict {
  kind: ListenerVerdictKind;
  suggestion: string | null;
}

/**
 * Base types that add no methods we would fail to see.
 *
 * Unity's own bases are safe because a `UnityEvent` cannot usefully target
 * `MonoBehaviour.Invoke` and friends, and anything else is a project type whose
 * members this scanner has not read.
 */
const ENGINE_BASES = new Set([
  'MonoBehaviour', 'ScriptableObject', 'Behaviour', 'Component', 'Object',
  'UnityEngine.MonoBehaviour', 'UnityEngine.ScriptableObject', 'UnityEngine.Behaviour',
  'UnityEngine.Component', 'UnityEngine.Object', 'StateMachineBehaviour',
  'PropertyAttribute', 'System.Object',
]);

/** `IFoo` / `UnityEngine.IFoo`: an interface contributes no implementation. */
function looksLikeInterface(name: string): boolean {
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return /^I[A-Z]/.test(bare);
}

/** True when a base type could be hiding the method from us. */
export function hasUnknownBase(cls: ClassDecl): boolean {
  return cls.baseTypes.some(
    (base) => !ENGINE_BASES.has(base) && !looksLikeInterface(base),
  );
}

/**
 * True when the class is declared `partial`.
 *
 * `ClassDecl` carries no modifier list, so this reads the source immediately
 * before the class name. Anything else would need a second parser.
 */
export function isPartialClass(scan: CSharpScan, cls: ClassDecl): boolean {
  const before = scan.code.slice(0, cls.nameOffset);

  // Back up to this declaration's own `class`/`struct` keyword...
  const keyword = /(?:\bclass\b|\bstruct\b)(?![\s\S]*(?:\bclass\b|\bstruct\b))/.exec(before);
  if (!keyword) return false;

  // ...then read only the modifiers in front of it. Cutting at the last brace or
  // semicolon is what stops an EARLIER `partial class` in the same file from
  // marking this one — the bug this function's test pins.
  const head = before.slice(0, keyword.index);
  const boundary = Math.max(head.lastIndexOf('{'), head.lastIndexOf('}'), head.lastIndexOf(';'));
  return /\bpartial\b/.test(head.slice(boundary + 1));
}

/** The methods declared inside a class body. */
export function methodsOf(scan: CSharpScan, cls: ClassDecl): MethodDecl[] {
  if (!cls.bodySpan) return [];
  return scan.methods.filter((m) => offsetInSpan(cls.bodySpan!, m.nameOffset));
}

/** Bounded edit distance, for the did-you-mean. */
function close(a: string, b: string): boolean {
  if (a === b) return false;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const limit = Math.max(2, Math.floor(Math.max(a.length, b.length) / 3));
  if (Math.abs(a.length - b.length) > limit) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[b.length] <= limit;
}

/**
 * Judge one wired method name against the class the prefab targets.
 *
 * Every rung above `missing` is a reason to stay quiet. The check is quiet on
 * deep hierarchies and on partial classes by design — that is the honest cost
 * of not reading the whole compilation.
 */
export function judgeListener(
  scan: CSharpScan,
  cls: ClassDecl,
  methodName: string,
): ListenerVerdict {
  // Unity serialises a property setter as `set_Foo`. `CSharpScan` extracts no
  // properties, so we would report every one of them as missing.
  if (/^(set_|get_)/.test(methodName)) return { kind: 'accessor', suggestion: null };

  if (isPartialClass(scan, cls)) return { kind: 'partial-class', suggestion: null };

  // `class UIController : BaseScreen` wired to an inherited `BaseScreen.Close()`
  // is extremely common; without this rung every one of them false-positives.
  if (hasUnknownBase(cls)) return { kind: 'inherited-possible', suggestion: null };

  const methods = methodsOf(scan, cls);
  const exact = methods.filter((m) => m.name === methodName);
  if (exact.length > 0) {
    const anyPublic = exact.some((m) => m.modifiers.includes('public'));
    return anyPublic
      ? { kind: 'resolved', suggestion: null }
      : { kind: 'not-public', suggestion: null };
  }

  const suggestion = methods.map((m) => m.name).find((name) => close(methodName, name)) ?? null;
  return { kind: 'missing', suggestion };
}
