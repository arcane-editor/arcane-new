/**
 * Static check that every `invoke('cmd', { ... })` in the frontend passes the
 * arguments its `#[tauri::command]` actually declares.
 *
 * Why this exists: `fuzzy_search_files` requires `max_results` and
 * `extra_excludes` (neither `Option`). `PaletteModal.tsx` passed both and
 * worked; `open-script.ts` and `UnityAssetPickerModal.tsx` passed `limit` and
 * omitted `extraExcludes`, so Tauri's deserializer rejected the call before the
 * command body ran — and both call sites wrapped the invoke in a catch that
 * swallowed the rejection. Clicking a script in the Unity Hierarchy, "Unity:
 * Open Scene…" and "Unity: Find Asset…" were therefore dead from the day they
 * shipped, with no error, no toast and no log.
 *
 * There are ~254 invoke sites over ~118 commands against ~131 registered
 * commands, every argument name matched by hand across a language boundary
 * with nothing checking either side. Nothing fails at build time; everything
 * fails silently at runtime. This closes that class.
 *
 * A call whose payload is not an object literal cannot be checked statically.
 * Those are counted and reported as UNCHECKED rather than passed silently — an
 * honest count beats a green light that means nothing.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Parameters Tauri injects rather than reading from the JS payload.
const INJECTED_TYPE_PREFIXES = ['tauri::', 'AppHandle', 'Window', 'State', 'WebviewWindow'];

export function snakeToCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** Split on commas that sit at bracket depth 0, so `Vec<A, B>` survives intact. */
function splitTopLevel(text, open = '<([', close = '>)]') {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (open.includes(ch)) depth++;
    else if (close.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Read a balanced span starting at `start` (which must be the opening char).
 *
 * `quotes` is explicit because Rust and TypeScript disagree about the single
 * quote: in `tauri::State<'_, FileIndexState>` it opens a *lifetime*, not a
 * string, and treating it as a string delimiter swallows the rest of the
 * signature and silently drops the command from the map.
 */
function balancedSpan(text, start, openCh, closeCh, quotes = `'"\``) {
  let depth = 0;
  let inStr = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (quotes.includes(ch)) {
      inStr = ch;
      continue;
    }
    if (ch === openCh) depth++;
    else if (ch === closeCh) {
      depth--;
      if (depth === 0) return { end: i, body: text.slice(start + 1, i) };
    }
  }
  return null;
}

/**
 * Map every `#[tauri::command]` in a Rust source to its JS-visible arguments.
 * Returns Map<commandName, { required: string[], optional: string[] }>.
 */
export function parseRustCommands(source) {
  const out = new Map();
  const attr = /#\[tauri::command[^\]]*\]/g;
  let m;
  while ((m = attr.exec(source)) !== null) {
    const after = source.slice(m.index + m[0].length);
    // Allow attributes/doc comments between the attribute and the fn.
    const sig = after.match(/^[\s\S]*?\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (!sig) continue;
    const name = sig[1];
    const parenIndex = m.index + m[0].length + sig[0].length - 1;
    // Double quotes only — see the `quotes` note on balancedSpan.
    const span = balancedSpan(source, parenIndex, '(', ')', '"');
    if (!span) continue;

    const required = [];
    const optional = [];
    for (const raw of splitTopLevel(span.body)) {
      const param = raw.trim();
      if (!param) continue;
      const colon = param.indexOf(':');
      if (colon === -1) continue;
      const pname = param.slice(0, colon).trim().replace(/^mut\s+/, '');
      const ptype = param.slice(colon + 1).trim().replace(/^&\s*/, '');
      if (INJECTED_TYPE_PREFIXES.some((p) => ptype.startsWith(p))) continue;
      (ptype.startsWith('Option<') ? optional : required).push(snakeToCamel(pname));
    }
    out.set(name, { required, optional });
  }
  return out;
}

/** Top-level keys of an object-literal body (nested objects are not descended). */
function topLevelKeys(body) {
  const keys = [];
  let depth = 0;
  let inStr = null;
  let token = '';
  const flush = (isKey) => {
    const t = token.trim();
    token = '';
    if (!t) return;
    // `key: value` -> key; shorthand `key` -> key.
    const ident = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (isKey && ident) keys.push(ident[1]);
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      token = '';
      continue;
    }
    if ('{(['.includes(ch)) {
      depth++;
      continue;
    }
    if ('})]'.includes(ch)) {
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (ch === ':') {
      flush(true);
      // Skip to the next top-level comma — the value is not a key.
      let vd = 0;
      let vs = null;
      for (i++; i < body.length; i++) {
        const c = body[i];
        if (vs) {
          if (c === '\\') i++;
          else if (c === vs) vs = null;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') vs = c;
        else if ('{(['.includes(c)) vd++;
        else if ('})]'.includes(c)) vd--;
        else if (c === ',' && vd === 0) break;
      }
      continue;
    }
    if (ch === ',') {
      flush(true); // shorthand property
      continue;
    }
    token += ch;
  }
  flush(true);
  return keys;
}

/**
 * Find `invoke('name', {...})` calls. Returns
 * Array<{ command, keys, line, checked, file }>.
 */
export function parseInvokeCalls(source, file) {
  const calls = [];
  // `invoke` / `invoke<T>` / `await invoke` — but not `.invoke` on some object.
  const re = /(?<![.\w])invoke\s*(?:<[^>(]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const parenIndex = m.index + m[0].length - 1;
    const span = balancedSpan(source, parenIndex, '(', ')');
    if (!span) continue;
    const args = span.body;
    const nameMatch = args.match(/^\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*(,|$)/);
    const line = source.slice(0, m.index).split('\n').length;
    if (!nameMatch) {
      // Command name is a variable — cannot resolve statically.
      calls.push({ command: null, keys: [], line, checked: false, file });
      continue;
    }
    const command = nameMatch[2];
    const rest = args.slice(nameMatch[0].length).trim();
    if (rest === '') {
      calls.push({ command, keys: [], line, checked: true, file });
      continue;
    }
    if (!rest.startsWith('{')) {
      calls.push({ command, keys: [], line, checked: false, file });
      continue;
    }
    const objSpan = balancedSpan(rest, 0, '{', '}');
    if (!objSpan) {
      calls.push({ command, keys: [], line, checked: false, file });
      continue;
    }
    calls.push({ command, keys: topLevelKeys(objSpan.body), line, checked: true, file });
  }
  return calls;
}

export function checkAll({ rustSources, tsSources }) {
  const commands = new Map();
  for (const { text } of rustSources) {
    for (const [name, sig] of parseRustCommands(text)) commands.set(name, sig);
  }

  const violations = [];
  const unchecked = [];

  for (const { file, text } of tsSources) {
    for (const call of parseInvokeCalls(text, file)) {
      if (!call.checked) {
        unchecked.push(call);
        continue;
      }
      const sig = commands.get(call.command);
      if (!sig) {
        violations.push({
          kind: 'no-such-command',
          file: call.file,
          line: call.line,
          command: call.command,
        });
        continue;
      }
      const missing = sig.required.filter((r) => !call.keys.includes(r));
      if (missing.length) {
        violations.push({
          kind: 'missing',
          file: call.file,
          line: call.line,
          command: call.command,
          missing,
        });
      }
      const known = new Set([...sig.required, ...sig.optional]);
      const unknown = call.keys.filter((k) => !known.has(k));
      if (unknown.length) {
        violations.push({
          kind: 'unknown',
          file: call.file,
          line: call.line,
          command: call.command,
          unknown,
        });
      }
    }
  }

  return { violations, unchecked, commandCount: commands.size };
}

// ─── CLI ──────────────────────────────────────────────────────────────

function walk(dir, exts, skip) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, exts, skip));
    else if (exts.has(path.extname(full)) && !/\.test\.[tj]sx?$/.test(full)) out.push(full);
  }
  return out;
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const rustFiles = walk(path.join(root, 'src-tauri', 'src'), new Set(['.rs']), new Set(['target']));
  const tsFiles = walk(
    path.join(root, 'src'),
    new Set(['.ts', '.tsx']),
    new Set(['node_modules']),
  );

  const rel = (f) => path.relative(root, f);
  const { violations, unchecked, commandCount } = checkAll({
    rustSources: rustFiles.map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') })),
    tsSources: tsFiles.map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') })),
  });

  for (const v of violations) {
    if (v.kind === 'missing') {
      console.error(
        `${v.file}:${v.line}  invoke('${v.command}') is missing required argument(s): ${v.missing.join(', ')}`,
      );
    } else if (v.kind === 'unknown') {
      console.error(
        `${v.file}:${v.line}  invoke('${v.command}') passes unknown argument(s): ${v.unknown.join(', ')}`,
      );
    } else {
      console.error(`${v.file}:${v.line}  invoke('${v.command}') — no such #[tauri::command]`);
    }
  }

  console.log(
    `\nchecked ${commandCount} commands; ${violations.length} violation(s); ${unchecked.length} call(s) not statically checkable`,
  );

  if (violations.length) {
    console.error(
      '\nA mismatch here is not a type error — Tauri rejects the call at runtime and\n' +
        "the caller's catch usually swallows it, so the feature is silently dead.",
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
