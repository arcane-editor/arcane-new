import {
  offsetInSpan,
  type CSharpScan,
  type MethodDecl,
  type SourceSpan,
} from './csharp-scan';
import { classReceivesMessages } from './fix-helpers';
import { UPDATE_FAMILY, UNITY_OBJECT_TYPES, bareTypeName } from '../data/unity-knowledge';

// ── Update-family body collection ────────────────────────────────────────────

/**
 * Bodies of Update/FixedUpdate/LateUpdate/OnGUI methods declared in classes
 * that receive Unity messages. Many performance rules scope themselves to these
 * hot paths only. Returns the method + its body span.
 */
export function updateFamilyBodies(scan: CSharpScan): Array<{ method: MethodDecl; body: SourceSpan }> {
  const out: Array<{ method: MethodDecl; body: SourceSpan }> = [];
  for (const cls of scan.classes) {
    if (!cls.bodySpan || !classReceivesMessages(cls)) continue;
    for (const m of scan.methods) {
      if (!m.bodySpan) continue;
      if (!offsetInSpan(cls.bodySpan, m.nameOffset)) continue;
      if (!UPDATE_FAMILY.has(m.name)) continue;
      // Must be a direct member of THIS class (not nested in another method).
      const nestedInOther = scan.methods.some(
        (o) => o !== m && o.bodySpan && offsetInSpan(o.bodySpan, m.nameOffset),
      );
      if (nestedInOther) continue;
      out.push({ method: m, body: m.bodySpan });
    }
  }
  return out;
}

/** Bodies of all methods named exactly `name` in message-receiving classes. */
export function namedMethodBodies(scan: CSharpScan, name: string): SourceSpan[] {
  const out: SourceSpan[] = [];
  for (const cls of scan.classes) {
    if (!cls.bodySpan || !classReceivesMessages(cls)) continue;
    for (const m of scan.methods) {
      if (!m.bodySpan) continue;
      if (!offsetInSpan(cls.bodySpan, m.nameOffset)) continue;
      if (m.name !== name) continue;
      out.push(m.bodySpan);
    }
  }
  return out;
}

/**
 * Iterate every match of `re` within `body` against the blanked `code` view.
 * Yields the absolute offset of each match's start (group 0). The regex must be
 * global; lastIndex is managed internally.
 */
export function* matchesInBody(
  scan: CSharpScan,
  body: SourceSpan,
  re: RegExp,
): Generator<RegExpExecArray> {
  const slice = scan.code.slice(body.start, body.end);
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    // Rebase the match index to absolute offsets.
    const rebased = { ...m } as unknown as RegExpExecArray;
    (rebased as { index: number }).index = body.start + (m.index ?? 0);
    rebased[0] = m[0];
    for (let i = 1; i < m.length; i++) rebased[i] = m[i];
    yield rebased;
    if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width loop
  }
}

// ── Lightweight local-variable type inference ────────────────────────────────
//
// Used by the conservative correctness rules (e.g. null-propagation). We build
// a name→type map from explicit local declarations + fields + parameters within
// the method. `var x = GetComponent<T>()` infers T. Best-effort, never throws.

const DECL_RE = /\b([A-Za-z_][\w.<>,\s[\]?]*?)\s+([A-Za-z_]\w*)\s*=/g;
const VAR_GETCOMPONENT_RE =
  /\bvar\s+([A-Za-z_]\w*)\s*=\s*(?:[\w.]+\.)?GetComponent(?:InChildren|InParent)?\s*<\s*([A-Za-z_][\w.]*)\s*>/g;

export interface IdentifierTypes {
  /** identifier → bare type name. */
  get(name: string): string | undefined;
  /** Is the identifier known to be a UnityEngine.Object-derived type? */
  isUnityObject(name: string): boolean;
}

/**
 * Build identifier→type knowledge for a method body: its parameters, the
 * enclosing class's fields, and explicit local declarations inside the body.
 */
export function inferIdentifierTypes(
  scan: CSharpScan,
  method: MethodDecl,
): IdentifierTypes {
  const types = new Map<string, string>();

  // Parameters.
  for (const p of method.params) {
    if (p.name) types.set(p.name, bareTypeName(p.type));
  }

  // Enclosing class fields.
  const owner = scan.classes.find(
    (c) => c.bodySpan && offsetInSpan(c.bodySpan, method.nameOffset),
  );
  if (owner) {
    for (const f of scan.fields) {
      if (owner.bodySpan && offsetInSpan(owner.bodySpan, f.nameOffset)) {
        types.set(f.name, bareTypeName(f.type));
      }
    }
  }

  const body = method.bodySpan;
  if (body) {
    const slice = scan.code.slice(body.start, body.end);

    // var x = GetComponent<T>() → x : T
    VAR_GETCOMPONENT_RE.lastIndex = 0;
    let g: RegExpExecArray | null;
    while ((g = VAR_GETCOMPONENT_RE.exec(slice)) !== null) {
      types.set(g[1], bareTypeName(g[2]));
    }

    // Explicit `Type name = ...` declarations.
    DECL_RE.lastIndex = 0;
    let d: RegExpExecArray | null;
    while ((d = DECL_RE.exec(slice)) !== null) {
      const type = d[1].trim();
      const name = d[2];
      if (type === 'var' || type === 'return' || /[(){}]/.test(type)) continue;
      if (!types.has(name)) types.set(name, bareTypeName(type));
    }
  }

  return {
    get: (name) => types.get(name),
    isUnityObject: (name) => {
      const t = types.get(name);
      return t !== undefined && UNITY_OBJECT_TYPES.has(t);
    },
  };
}
