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
 * UnityIDE became its external script editor), so no diff could have caught it.
 * Only probing the running server catches that class of break.
 *
 *   node scripts/verify-csharp-intellisense.mjs
 *
 * Env:
 *   UNITYIDE_SMOKE_UNITY_PROJECT   Unity project to probe (else known defaults)
 *   UNITYIDE_INTELLISENSE_E2E      "required" → missing prerequisites fail (exit 1)
 *                                rather than skip. Use in pre-merge gates.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = process.env.UNITYIDE_INTELLISENSE_E2E === 'required';
const MIN_COMPLETIONS = 20; // `transform.` alone yields ~98; 20 is "clearly working"

// Server capabilities the editor's providers are built on. csharp-ls advertises
// every one of these today, so a missing entry means the server was downgraded
// or swapped — which removes an editor feature silently, with no error on
// either side, exactly like the ACP capability switches in CLAUDE.md.
//
// `foldingRangeProvider` and `selectionRangeProvider` are deliberately absent:
// csharp-ls 0.22 does not implement them, and Monaco falls back to
// indentation-based folding. Do not add them here without re-probing.
const REQUIRED_CAPABILITIES = [
  'definitionProvider',
  'documentFormattingProvider',
  'documentSymbolProvider',
  'hoverProvider',
  'implementationProvider',
  'referencesProvider',
  'renameProvider',
  'semanticTokensProvider',
  'typeDefinitionProvider',
  'workspaceSymbolProvider',
];

// Developer-machine fallbacks, tried in order. These are real directories on
// someone's disk, NOT brand strings — the rename sweep rewrote "Arcane Demo" to
// "UnityIDE Demo" here and the check immediately stopped finding a project.
// Both spellings stay listed so this keeps working whether or not a given
// machine's demo folder has been renamed by hand.
const CANDIDATE_PROJECTS = [
  process.env.UNITYIDE_SMOKE_UNITY_PROJECT,
  '/Users/inno/UnityIDE Demo',
  '/Users/inno/Arcane Demo',
  '/Users/inno/My project',
].filter(Boolean);

function skip(reason) {
  if (REQUIRED) {
    console.error(`\n  FAIL  C# IntelliSense check could not run: ${reason}`);
    console.error('        UNITYIDE_INTELLISENSE_E2E=required forbids skipping.\n');
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
if (!project) skip('no Unity project found (set UNITYIDE_SMOKE_UNITY_PROJECT)');

// How to start the server, as [program, ...leadingArgs].
//
// The editor no longer assumes an executable: the copy it provisions itself is
// a bare tool assembly run as `dotnet <assembly>` (see `csharp_ls.rs`). Both
// shapes have to be checkable here, or the managed one — the shape most users
// will actually run — would never be exercised end to end.
const managedDll = process.env.UNITYIDE_CSHARP_LS_DLL;
const csharpLsCommand = managedDll
  ? ['dotnet', [managedDll]]
  : (() => {
      const exe = [
        process.env.UNITYIDE_CSHARP_LS_PATH,
        path.join(process.env.HOME ?? '', '.dotnet/tools/csharp-ls'),
        '/usr/local/bin/csharp-ls',
      ].find((p) => p && fs.existsSync(p));
      return exe ? [exe, []] : null;
    })();
if (!csharpLsCommand) skip('csharp-ls not installed (dotnet tool install --global csharp-ls)');
const [csharpLsProgram, csharpLsLeadingArgs] = csharpLsCommand;
const csharpLs = managedDll ? `dotnet ${managedDll}` : csharpLsProgram;

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
    env: { ...process.env, UNITYIDE_SMOKE_UNITY_PROJECT: project },
    encoding: 'utf8',
  },
);
if (gen.status !== 0) fail('project-file generation failed', gen.stderr || gen.stdout);

const solution = path.join(project, '.unityide.sln');
if (!fs.existsSync(solution)) {
  fail(
    `generation produced no ${path.basename(solution)}`,
    '  csharp-ls would fall back to auto-discovering a stale Unity .sln,\n' +
      '  whose project references do not resolve — that is the outage shape.',
  );
}

// ── drive the real server ──────────────────────────────────────────────────

const server = spawn(
  csharpLsProgram,
  [...csharpLsLeadingArgs, '--loglevel', 'info', '--solution', solution],
  {
    cwd: project,
    env: { ...process.env, DOTNET_ROOT: process.env.DOTNET_ROOT ?? '/usr/local/share/dotnet' },
  },
);

let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
let solutionLoaded = false;
const logs = [];
// Capabilities can arrive AFTER initialize, via client/registerCapability.
// Answering that request with `null` and dropping the payload — which this
// script did — makes a dynamically-registered provider invisible to the
// capability report below, so a feature could look absent while working fine.
const dynamicRegistrations = [];

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
      if (msg.method === 'client/registerCapability') {
        for (const reg of msg.params?.registrations ?? []) dynamicRegistrations.push(reg.method);
      }
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
  // These capabilities mirror `src/features/lsp/services/client.ts`. They are
  // duplicated rather than imported on purpose: this script is dependency-free
  // plain node, with no bundler and no TS. The duplication is load-bearing, not
  // laziness — a server may gate its own capability on the client declaring the
  // matching one, so a probe that asks for less than the editor does would
  // report a feature missing that actually works (and vice versa).
  const init = await request('initialize', {
    processId: null,
    rootUri: uriOf(project),
    workspaceFolders: [{ uri: uriOf(project), name: path.basename(project) }],
    capabilities: {
      textDocument: {
        completion: { contextSupport: true, completionItem: { snippetSupport: true } },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        definition: { linkSupport: true },
        typeDefinition: { linkSupport: true },
        implementation: { linkSupport: true },
        references: {},
        documentHighlight: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        rename: { prepareSupport: true },
        formatting: {},
        rangeFormatting: {},
        onTypeFormatting: {},
        callHierarchy: {},
        typeHierarchy: {},
        inlayHint: {},
        foldingRange: {},
        selectionRange: {},
        semanticTokens: {
          requests: { full: true, range: true },
          formats: ['relative'],
          tokenTypes: [],
          tokenModifiers: [],
        },
        codeAction: {
          codeActionLiteralSupport: {
            codeActionKind: { valueSet: ['', 'quickfix', 'refactor'] },
          },
        },
      },
      workspace: {
        configuration: true,
        workspaceFolders: true,
        symbol: {},
        applyEdit: true,
      },
    },
  });
  notify('initialized', {});
  const serverCaps = init.result?.capabilities ?? {};

  // Synthetic content for a path the generated csproj already globs in. Keeps
  // the assertions independent of whatever the user happens to have written.
  const PROBE = [
    'using UnityEngine;',
    '',
    'public class UnityIDEIntelliSenseProbe : MonoBehaviour',
    '{',
    '    private void Update()',
    '    {',
    '        transform.',
    '    }',
    '}',
    '',
  ].join('\n');
  const CURSOR = { line: 6, character: '        transform.'.length };

  // Derived from the probe text, never hardcoded. This was a literal
  // `character: 40`, which silently stopped pointing at `MonoBehaviour` the
  // moment the class name on that line changed length — and the check then
  // reported "hover resolved nothing", i.e. a broken-IntelliSense failure, for
  // a cursor problem entirely of its own making.
  const CLASS_LINE_INDEX = PROBE.split('\n').findIndex((l) => l.startsWith('public class '));
  const CLASS_LINE = PROBE.split('\n')[CLASS_LINE_INDEX];
  const HOVER = {
    line: CLASS_LINE_INDEX,
    character: CLASS_LINE.indexOf('MonoBehaviour') + 1,
  };
  if (CLASS_LINE_INDEX < 0 || !CLASS_LINE.includes('MonoBehaviour')) {
    fail('probe text no longer declares a class deriving from MonoBehaviour');
  }

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
    position: HOVER, // MonoBehaviour in the base list, located in the probe text
  });
  const hoverText = JSON.stringify(hover.result?.contents ?? '');
  if (!/MonoBehaviour/.test(hoverText)) {
    fail('hover over `MonoBehaviour` resolved nothing', `    got: ${hoverText.slice(0, 200)}`);
  }

  // Corelib integrity — the assertion the two above cannot make.
  //
  // Completion and hover answer out of the explicitly referenced UnityEngine
  // assemblies, so they keep working even when the project declares TWO
  // corelibs: the netstandard 2.1 set the generator supplies, plus an implicit
  // mscorlib that MSBuild pulls out of `FrameworkPathOverride` whenever
  // `NoStdLib` is false. In that state Roslyn cannot place `System.Object` or
  // `System.Void`, so every file in the project reports CS0518/CS0433 on
  // nearly every line and the editor is unusable — while this script printed
  // PASS, because nothing here had ever looked at a diagnostic.
  //
  // Codes, not counts: the probe's trailing `transform.` is deliberately
  // incomplete and legitimately produces syntax errors. Only corelib failures
  // are disqualifying.
  const diagnostics = await request('textDocument/diagnostic', {
    textDocument: { uri: uriOf(probeFile) },
  });
  if (diagnostics.error) {
    fail(
      'csharp-ls refused `textDocument/diagnostic`',
      `    ${JSON.stringify(diagnostics.error)}\n` +
        '  The editor pulls diagnostics over this exact request — if it does not\n' +
        '  answer, no C# error or warning can ever reach Monaco.',
    );
  }
  const CORELIB_CODES = new Set(['CS0518', 'CS0433']);
  const corelib = (diagnostics.result?.items ?? []).filter((d) =>
    CORELIB_CODES.has(String(d.code ?? '')),
  );
  if (corelib.length) {
    fail(
      `csharp-ls reports ${corelib.length} corelib error(s) — the project declares more than one corelib`,
      corelib.slice(0, 5).map((d) => `    ${d.code}: ${d.message}`).join('\n') +
        '\n  Check <NoStdLib> in the generated .unityide.csproj (unity.rs): with the\n' +
        '  netstandard reference set AND FrameworkPathOverride both present, it must\n' +
        '  be true, or MSBuild adds a second mscorlib on top of netstandard.',
    );
  }

  // ── server capabilities ──────────────────────────────────────────────────
  //
  // Completion and hover prove Roslyn resolved the reference set. They say
  // nothing about the other providers the editor registers. A csharp-ls that
  // stopped advertising `documentSymbolProvider` would take Go-to-Symbol and
  // the outline with it, silently, while everything above still printed PASS.
  const advertised = new Set([...Object.keys(serverCaps), ...dynamicRegistrations]);
  const missing = REQUIRED_CAPABILITIES.filter((c) => !advertised.has(c));
  if (missing.length) {
    fail(
      `csharp-ls no longer advertises ${missing.length} capability the editor depends on`,
      `    missing: ${missing.join(', ')}\n` +
        `    advertised: ${[...advertised].sort().join(', ')}\n` +
        '  Each missing capability removes an editor feature with no error on\n' +
        '  either side. Check the installed csharp-ls version (dotnet tool list -g).',
    );
  }

  // ── refactoring surface ──────────────────────────────────────────────────
  //
  // `codeActionProvider` is advertised as a bare `true` with no
  // `codeActionKinds`, so the only way to learn which Roslyn refactorings are
  // reachable is to ask for them on real, syntactically valid code. The probe
  // text above ends in a deliberate `transform.` syntax error, which suppresses
  // refactorings across the whole file — so swap in a clean body first.
  const REFACTOR_PROBE = [
    'using UnityEngine;',
    '',
    'public class UnityIDEIntelliSenseProbe : MonoBehaviour',
    '{',
    '    private void Update()',
    '    {',
    '        int total = 1 + 2;',
    '        Debug.Log(total);',
    '    }',
    '}',
    '',
  ].join('\n');
  const rLines = REFACTOR_PROBE.split('\n');
  const exprLine = rLines.findIndex((l) => l.includes('1 + 2'));
  const lastStmt = rLines.findIndex((l) => l.includes('Debug.Log(total)'));
  const exprCol = rLines[exprLine].indexOf('1 + 2');

  notify('textDocument/didChange', {
    textDocument: { uri: uriOf(probeFile), version: 2 },
    contentChanges: [{ text: REFACTOR_PROBE }],
  });
  await sleep(1500);

  const askRefactor = async (label, range) => {
    const res = await request('textDocument/codeAction', {
      textDocument: { uri: uriOf(probeFile) },
      range,
      context: { diagnostics: [], only: ['refactor'], triggerKind: 1 },
    });
    const actions = Array.isArray(res.result) ? res.result : [];
    console.log(`  refactor    ${label}: ${actions.length} offered`);
    for (const a of actions) console.log(`                • ${a.title}${a.kind ? `  [${a.kind}]` : ''}`);
    return actions;
  };

  const onExpression = await askRefactor('over `1 + 2`', {
    start: { line: exprLine, character: exprCol },
    end: { line: exprLine, character: exprCol + '1 + 2'.length },
  });
  const onBody = await askRefactor('over the method body', {
    start: { line: exprLine, character: 8 },
    end: { line: lastStmt, character: rLines[lastStmt].length },
  });
  if (onExpression.length + onBody.length === 0) {
    console.log('  refactor    none offered — §4 needs its own engine, not just a UI');
  }

  console.log('');
  console.log(`  capabilities ${REQUIRED_CAPABILITIES.length} required present` +
    (dynamicRegistrations.length ? ` (+${dynamicRegistrations.length} dynamic)` : ''));
  console.log(`  completions ${labels.length} on \`transform.\` (position, rotation, localScale present)`);
  console.log('  hover       MonoBehaviour resolves');
  console.log('  corelib     no CS0518/CS0433 — exactly one corelib in the project\n');
  console.log('  PASS  C# IntelliSense is working end to end\n');
  server.kill();
  process.exit(0);
} catch (err) {
  fail(err.message, logs.slice(-10).join('\n'));
}
