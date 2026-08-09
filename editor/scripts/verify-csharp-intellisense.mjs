#!/usr/bin/env node
/**
 * End-to-end C# IntelliSense check.
 *
 * Regenerates the project files through the real Rust code path, starts the
 * real csharp-ls, and asserts it actually answers completions and hover for
 * Unity types. Unit tests cover the generated csproj; this covers the only
 * thing users care about — that IntelliSense responds.
 *
 * Why this exists: C# IntelliSense was completely dead for an unknown period
 * while every test in the repo stayed green. Nothing asserted the outcome, and
 * the failure was environmental (Unity stopped emitting .csproj files once
 * Arcane became its external script editor), so no diff could have caught it.
 * Only probing the running server catches that class of break.
 *
 *   node scripts/verify-csharp-intellisense.mjs
 *
 * Env:
 *   ARCANE_SMOKE_UNITY_PROJECT   Unity project to probe (else known defaults)
 *   ARCANE_INTELLISENSE_E2E      "required" → missing prerequisites fail (exit 1)
 *                                rather than skip. Use in pre-merge gates.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = process.env.ARCANE_INTELLISENSE_E2E === 'required';
const MIN_COMPLETIONS = 20; // `transform.` alone yields ~98; 20 is "clearly working"

const CANDIDATE_PROJECTS = [
  process.env.ARCANE_SMOKE_UNITY_PROJECT,
  '/Users/inno/Arcane Demo',
  '/Users/inno/My project',
].filter(Boolean);

function skip(reason) {
  if (REQUIRED) {
    console.error(`\n  FAIL  C# IntelliSense check could not run: ${reason}`);
    console.error('        ARCANE_INTELLISENSE_E2E=required forbids skipping.\n');
    process.exit(1);
  }
  // Loud on purpose. A quiet skip is what let this break go unnoticed: the
  // Rust smoke tests pointed at a deleted path and passed by returning early.
  console.log(`\n  SKIPPED  C# IntelliSense end-to-end check — ${reason}`);
  console.log('           This check did NOT run. It is not evidence of anything.\n');
  process.exit(0);
}

function fail(msg, extra) {
  console.error(`\n  FAIL  ${msg}`);
  if (extra) console.error(extra);
  console.error('');
  process.exit(1);
}

// ── prerequisites ──────────────────────────────────────────────────────────

const project = CANDIDATE_PROJECTS.find((p) => fs.existsSync(path.join(p, 'Assets')));
if (!project) skip('no Unity project found (set ARCANE_SMOKE_UNITY_PROJECT)');

const csharpLs = [
  path.join(process.env.HOME ?? '', '.dotnet/tools/csharp-ls'),
  '/usr/local/bin/csharp-ls',
].find((p) => fs.existsSync(p));
if (!csharpLs) skip('csharp-ls not installed (dotnet tool install --global csharp-ls)');

const probeFile = (function findCs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'Library' || entry.name === 'Temp') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findCs(full);
      if (found) return found;
    } else if (entry.name.endsWith('.cs')) return full;
  }
  return null;
})(path.join(project, 'Assets'));
if (!probeFile) skip(`no .cs file under ${project}/Assets`);

console.log(`  project    ${project}`);
console.log(`  csharp-ls  ${csharpLs}`);

// ── regenerate through the real Rust generator ─────────────────────────────

const gen = spawnSync(
  'cargo',
  ['test', '--lib', 'unity::tests::smoke_generate_full_setup', '--', '--exact'],
  {
    cwd: path.join(EDITOR_DIR, 'src-tauri'),
    env: { ...process.env, ARCANE_SMOKE_UNITY_PROJECT: project },
    encoding: 'utf8',
  },
);
if (gen.status !== 0) fail('project-file generation failed', gen.stderr || gen.stdout);

const solution = path.join(project, '.arcane.sln');
if (!fs.existsSync(solution)) {
  fail(
    `generation produced no ${path.basename(solution)}`,
    '  csharp-ls would fall back to auto-discovering a stale Unity .sln,\n' +
      '  whose project references do not resolve — that is the outage shape.',
  );
}

// ── drive the real server ──────────────────────────────────────────────────

const server = spawn(csharpLs, ['--loglevel', 'info', '--solution', solution], {
  cwd: project,
  env: { ...process.env, DOTNET_ROOT: process.env.DOTNET_ROOT ?? '/usr/local/share/dotnet' },
});

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
let solutionLoaded = false;
const logs = [];

server.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const m = /Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString());
    if (!m) return;
    const start = sep + 4;
    const len = Number(m[1]);
    if (buf.length < start + len) return;
    const msg = JSON.parse(buf.subarray(start, start + len).toString());
    buf = buf.subarray(start + len);

    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'window/logMessage') {
      logs.push(msg.params.message);
      if (/Finished loading/i.test(msg.params.message)) solutionLoaded = true;
    } else if (msg.id !== undefined && msg.method) {
      // Server-to-client request: answer so it doesn't block.
      send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'workspace/configuration' ? [{}] : null });
    }
  }
});
server.on('error', (err) => fail(`could not start csharp-ls: ${err.message}`));

function send(obj) {
  const s = JSON.stringify(obj);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 60_000);
    send({ jsonrpc: '2.0', id, method, params });
  });
}
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uriOf = (p) => 'file://' + encodeURI(p);

try {
  await request('initialize', {
    processId: null,
    rootUri: uriOf(project),
    workspaceFolders: [{ uri: uriOf(project), name: path.basename(project) }],
    capabilities: {
      textDocument: {
        completion: { contextSupport: true, completionItem: { snippetSupport: true } },
        hover: { contentFormat: ['markdown', 'plaintext'] },
      },
      workspace: { configuration: true, workspaceFolders: true },
    },
  });
  notify('initialized', {});

  // Synthetic content for a path the generated csproj already globs in. Keeps
  // the assertions independent of whatever the user happens to have written.
  const PROBE = [
    'using UnityEngine;',
    '',
    'public class ArcaneIntelliSenseProbe : MonoBehaviour',
    '{',
    '    private void Update()',
    '    {',
    '        transform.',
    '    }',
    '}',
    '',
  ].join('\n');
  const CURSOR = { line: 6, character: '        transform.'.length };

  // Wait for the solution BEFORE opening the document. A didOpen that lands
  // mid-load gets attached to Roslyn's miscellaneous-files workspace, which has
  // no Unity references and answers every request with nothing — the exact
  // symptom this script exists to detect, so getting the order wrong here would
  // make the check fail for a reason that has nothing to do with the product.
  for (let i = 0; i < 120 && !solutionLoaded; i++) await sleep(500);
  if (!solutionLoaded) fail('csharp-ls never finished loading the solution', logs.join('\n'));

  notify('textDocument/didOpen', {
    textDocument: { uri: uriOf(probeFile), languageId: 'csharp', version: 1, text: PROBE },
  });
  await sleep(2500); // let Roslyn bind the just-opened document

  const failures = logs.filter((l) => /\[Failure\]|Project file not found/i.test(l));
  if (failures.length) {
    fail(
      `csharp-ls could not load ${failures.length} project(s) from the solution`,
      failures.slice(0, 5).map((l) => '    ' + l).join('\n'),
    );
  }

  const completion = await request('textDocument/completion', {
    textDocument: { uri: uriOf(probeFile) },
    position: CURSOR,
    context: { triggerKind: 2, triggerCharacter: '.' },
  });
  const items = completion.result?.items ?? completion.result ?? [];
  const labels = Array.isArray(items) ? items.map((i) => i.label) : [];

  if (labels.length < MIN_COMPLETIONS) {
    fail(
      `\`transform.\` returned ${labels.length} completions, expected >= ${MIN_COMPLETIONS}`,
      '  Roslyn resolved no Unity types — the reference set or the solution is broken.',
    );
  }
  for (const expected of ['position', 'rotation', 'localScale']) {
    if (!labels.includes(expected)) {
      fail(`\`transform.\` completions are missing \`${expected}\``, `    got: ${labels.slice(0, 20).join(', ')}`);
    }
  }

  const hover = await request('textDocument/hover', {
    textDocument: { uri: uriOf(probeFile) },
    position: { line: 2, character: 40 }, // MonoBehaviour in the base list
  });
  const hoverText = JSON.stringify(hover.result?.contents ?? '');
  if (!/MonoBehaviour/.test(hoverText)) {
    fail('hover over `MonoBehaviour` resolved nothing', `    got: ${hoverText.slice(0, 200)}`);
  }

  console.log(`  completions ${labels.length} on \`transform.\` (position, rotation, localScale present)`);
  console.log('  hover       MonoBehaviour resolves\n');
  console.log('  PASS  C# IntelliSense is working end to end\n');
  server.kill();
  process.exit(0);
} catch (err) {
  fail(err.message, logs.slice(-10).join('\n'));
}
