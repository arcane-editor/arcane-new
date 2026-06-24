import type { AnalyzerRule, Finding } from '../services/analyzer-engine';
import { updateFamilyBodies, matchesInBody } from '../services/body-analysis';
import { type CSharpScan, type SourceSpan } from '../services/csharp-scan';
import { COMMON_REFERENCE_TYPES, bareTypeName } from '../data/unity-knowledge';

// LINQ method calls (only meaningful when System.Linq is imported).
const LINQ_RE = /\.\s*(Where|Select|SelectMany|ToList|ToArray|ToDictionary|OrderBy|OrderByDescending|GroupBy|First|FirstOrDefault|Any|All|Count|Sum|Aggregate|Distinct)\s*\(/g;

// `new TypeName(` — candidate reference-type allocation.
const NEW_RE = /\bnew\s+([A-Za-z_][\w.]*)\s*(?:<[^>;]*>)?\s*[([{]/g;

// foreach loops — non-array enumeration may allocate an enumerator.
const FOREACH_RE = /\bforeach\s*\(/g;

export const allocInUpdateRule: AnalyzerRule = {
  id: 'unity/alloc-in-update',
  defaultSeverity: 'info',

  run(scan, _ctx): Finding[] {
    const findings: Finding[] = [];
    const hasLinq = scan.usings.some((u) => u.name === 'System.Linq');

    for (const { method, body } of updateFamilyBodies(scan)) {
      // LINQ → deferred enumerators + closures allocate each frame.
      if (hasLinq) {
        for (const m of matchesInBody(scan, body, LINQ_RE)) {
          findings.push(info(this.id, m.index, m.index + m[0].length - 1,
            `LINQ '${m[1]}' inside ${method.name}() allocates enumerators/closures every frame, adding GC pressure. Precompute outside the hot path or use plain loops.`,
            'UNITY0205'));
        }
      }

      // `new` of a reference type → heap allocation each frame.
      for (const m of matchesInBody(scan, body, NEW_RE)) {
        const bare = bareTypeName(m[1]);
        if (!COMMON_REFERENCE_TYPES.has(bare)) continue; // conservative: known ref types only
        findings.push(info(this.id, m.index, m.index + 'new '.length + m[1].length,
          `'new ${m[1]}' inside ${method.name}() allocates on the managed heap every frame, increasing GC churn. Reuse a cached instance where possible.`,
          'UNITY0206'));
      }

      // String concatenation with '+' inside a loop in the body.
      for (const concatOffset of stringConcatInLoops(scan, body)) {
        findings.push(info(this.id, concatOffset, concatOffset + 1,
          `String concatenation with '+' inside a loop in ${method.name}() allocates a new string each iteration. Use a StringBuilder or build the string once.`,
          'UNITY0207'));
      }

      // foreach over a non-array (heuristic) → potential enumerator allocation.
      for (const m of matchesInBody(scan, body, FOREACH_RE)) {
        // Heuristic: flag foreach only when the collection token is not an
        // obvious array access. We look at the `in <expr>)` tail.
        const tail = scan.code.slice(m.index, Math.min(scan.code.length, m.index + 160));
        const inMatch = /\bin\s+([^)]*)\)/.exec(tail);
        if (!inMatch) continue;
        const collection = inMatch[1].trim();
        if (collection.endsWith(']')) continue; // array element / indexer — skip
        findings.push(info(this.id, m.index, m.index + 'foreach'.length,
          `'foreach' inside ${method.name}() can allocate an enumerator each frame for non-array/List collections. Prefer a for-loop over an array/List in hot paths.`,
          'UNITY0208'));
      }
    }

    return findings;
  },
};

function info(ruleId: string, start: number, end: number, message: string, code: string): Finding {
  return { ruleId, severity: 'info', start, end, message, code };
}

/**
 * Find offsets of `+`/`+=` string-ish concatenations that occur inside a loop
 * within `body`. Heuristic: locate for/while/foreach loop bodies, then look for
 * a `+=` or `" + ` style concat involving a string literal inside them.
 */
function stringConcatInLoops(scan: CSharpScan, body: SourceSpan): number[] {
  const offsets: number[] = [];
  const code = scan.code;
  const text = scan.text;
  const slice = code.slice(body.start, body.end);

  const loopRe = /\b(for|foreach|while)\s*\(/g;
  let lm: RegExpExecArray | null;
  while ((lm = loopRe.exec(slice)) !== null) {
    // Find the loop body brace after the loop header.
    const headerStart = body.start + lm.index;
    const braceIdx = code.indexOf('{', headerStart);
    if (braceIdx < 0 || braceIdx > body.end) continue;
    // Match the loop body braces.
    let depth = 0;
    let close = -1;
    for (let i = braceIdx; i < body.end; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close < 0) continue;
    const loopBody = text.slice(braceIdx, close + 1);
    // String concat heuristics: `x += "..."`, `"..." + var`, `var + "..."`.
    const concatRe = /(\+=\s*"[^"]*")|("[^"]*"\s*\+)|(\+\s*"[^"]*")/g;
    let cm: RegExpExecArray | null;
    while ((cm = concatRe.exec(loopBody)) !== null) {
      offsets.push(braceIdx + cm.index);
    }
  }
  return offsets;
}
