import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { useCommandsStore } from '../stores/commands';
import { selectCommands } from './Tooltip';

/**
 * Regression guard for an app-killing update loop.
 *
 * `Tooltip` selected `s.commands.get.bind(s.commands)`. Zustand v5 runs a
 * selector as `useSyncExternalStore`'s `getSnapshot` and React compares
 * consecutive snapshots with `Object.is`, so a fresh function identity per call
 * never compares equal: React's commit-phase snapshot check re-rendered on
 * every commit, and once a store notified fast enough to stack 50 of those,
 * React threw "Maximum update depth exceeded" and the root error boundary
 * replaced the entire IDE with "Something went wrong".
 *
 * Nothing about that is Tooltip-specific, so the second test guards the class.
 */
describe('command selector snapshot stability', () => {
  it('returns an identical reference for an unchanged store', () => {
    const state = useCommandsStore.getState();
    expect(selectCommands(state)).toBe(selectCommands(state));
  });

  it('changes identity only when the command set actually changes', () => {
    const before = selectCommands(useCommandsStore.getState());

    useCommandsStore.getState().registerCommand({
      id: 'test.selector.stability',
      label: 'Test',
      category: 'Test',
      handler: () => {},
    });
    const afterRegister = selectCommands(useCommandsStore.getState());
    expect(afterRegister).not.toBe(before);

    // A read must not churn the snapshot.
    expect(selectCommands(useCommandsStore.getState())).toBe(afterRegister);

    useCommandsStore.getState().unregisterCommand('test.selector.stability');
  });
});

/**
 * Scans source for store selectors that build a fresh identity per call. This
 * is a whole class of the same crash, and it is invisible in review: the
 * selector reads as a plain accessor and the loop only shows up under a store
 * that notifies quickly.
 */
describe('no store selector returns a fresh identity', () => {
  const SRC = join(import.meta.dir, '..');

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) sourceFiles(p, out);
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  }

  // Each pattern builds a NEW value every call, so the snapshot never matches.
  const FRESH: Array<[RegExp, string]> = [
    [/\.bind\(/, '.bind()'],
    [/\.(filter|map|slice|concat|sort|flat|flatMap)\(/, 'array method'],
    [/Object\.(values|keys|entries)\(/, 'Object.*()'],
    [/Array\.from\(/, 'Array.from()'],
    [/=>\s*\(?\s*\{\s*[\w'"]+\s*:/, 'object literal'],
    [/=>\s*\[/, 'array literal'],
    [/new (Map|Set|Date)\(/, 'new Map/Set/Date'],
  ];

  it('across every component, hook and feature', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      const rel = file.replace(SRC + '/', '');

      // Extracted selectors: `const sel = (s: FooState) => ...`. These are
      // passed to a store hook by name, so the inline scan below cannot see
      // them — and that is exactly how this bug was first written.
      const named = /\b(?:const|function)\s+(\w+)\s*=?\s*\(\s*\w+\s*:\s*\w*State\b[^)]*\)\s*(?:=>|\{)/g;
      let nm: RegExpExecArray | null;
      while ((nm = named.exec(src))) {
        const body = src.slice(nm.index, src.indexOf('\n', nm.index) + 1);
        for (const [pattern, label] of FRESH) {
          if (pattern.test(body.slice(body.indexOf('=>') + 2))) {
            const line = src.slice(0, nm.index).split('\n').length;
            offenders.push(
              `${rel}:${line} selector \`${nm[1]}\` builds a fresh value (${label}) — ` +
                `select stable state and derive in render, or wrap with useShallow`,
            );
            break;
          }
        }
      }

      const re = /\buse[A-Z]\w*Store\s*\(/g;
      let m: RegExpExecArray | null;

      while ((m = re.exec(src))) {
        // Walk to the matching close paren so multi-line selectors are covered.
        let i = re.lastIndex;
        let depth = 1;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === '(') depth++;
          else if (c === ')') depth--;
          i++;
        }
        const arg = src.slice(re.lastIndex, i - 1);
        re.lastIndex = i;

        if (!arg.includes('=>')) continue;
        // useShallow / a custom equality fn makes a fresh identity safe.
        if (/useShallow|shallow/.test(arg)) continue;

        for (const [pattern, label] of FRESH) {
          if (pattern.test(arg)) {
            const line = src.slice(0, m.index).split('\n').length;
            offenders.push(
              `${rel}:${line} builds a fresh value (${label}) — ` +
                `select stable state and derive in render, or wrap with useShallow`,
            );
            break;
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
