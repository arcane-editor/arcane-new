#!/usr/bin/env bun
/**
 * End-to-end C# IntelliSense check.
 *
 * Regenerates the project files through the real Rust code path, starts the
 * real csharp-ls, and asserts it actually answers — completions for static and
 * instance members, hover, incremental edits, diagnostics, and resolve.
 *
 * **Why this exists.** C# IntelliSense has now been completely dead twice, for
 * long periods, while every test in the repo stayed green. Both breaks were
 * environmental — one when Unity stopped emitting `.csproj` files, one when
 * Monaco's URI formatting disagreed with the client's on Windows — so no diff
 * could have caught either. Only probing the running server catches that class
 * of failure.
 *
 * **Why it is a bun script.** It imports the editor's OWN `fileUri` and
 * `lspDocumentUri`, and that is the point. The previous version was
 * dependency-free node with its own `uriOf` helper, so it built both the
 * `didOpen` and the request URI the same way and could never observe the
 * mismatch that had killed IntelliSense on Windows. A probe that reimplements
 * the thing it is checking cannot check it.
 *
 *   bun run scripts/verify-csharp-intellisense.ts
 *   bun run scripts/verify-csharp-intellisense.ts --section analyzers
 *
 * Env:
 *   UNITYIDE_SMOKE_UNITY_PROJECT   Unity project to probe. Optional — the
 *                                  probe finds the most recently opened one.
 *   UNITYIDE_CSHARP_LS_DLL         Server assembly override.
 *   UNITYIDE_CSHARP_LS_PATH        Server executable override.
 *   UNITYIDE_INTELLISENSE_E2E      "required" → a skip becomes exit 1.
 *   UNITYIDE_INTELLISENSE_BUDGET_SCALE  Multiply the latency budgets (slow CI).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileUri } from '../src/features/lsp/services/document-sync';
import { lspDocumentUri } from '../src/features/lsp/services/model-context';
import { isLoadFinishedMessage } from '../src/features/lsp/services/csharp-ls-log-markers';
import { configurationForItem } from '../src/features/lsp/services/csharp-configuration';
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
import {
  compareVersions,
  discoverCsharpLs,
  discoverUnityProjects,
  locate,
  readPinnedCsharpLsVersion,
  resolveDotnetRoot,
} from './verify-csharp-intellisense-lib';

const EDITOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = process.env.UNITYIDE_INTELLISENSE_E2E === 'required';
const ONLY_SECTION = (() => {
  const i = process.argv.indexOf('--section');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const BUDGET_SCALE = Number(process.env.UNITYIDE_INTELLISENSE_BUDGET_SCALE ?? '1') || 1;

/** `transform.` alone yields ~84; 20 is "clearly working". */
const MIN_COMPLETIONS = 20;

/**
 * Latency budgets in ms, before scaling. These are tripwires, not benchmarks:
 * Monaco's suggest widget reads as dead past about a second, and the app
 * debounces diagnostic pulls at 500ms, so each of these is several times the
 * threshold a user would notice and far under the client's own timeouts. They
 * exist to catch a regression that makes IntelliSense technically alive and
 * practically unusable — which no correctness assertion here would notice.
 */
const BUDGET = {
  firstCompletion: 8000, // cold: Roslyn binds the document, .NET JITs
  warmCompletion: 2000,
  hover: 2000,
  resolve: 1500,
  diagnosticsAfterEdit: 5000,
  // With analyzers on, every pull runs every analyzer over the whole
  // compilation (csharp-ls `getDocumentDiagnosticsWithAnalyzers`), so this is
  // deliberately looser than the compiler-only budget above.
  analyzerDiagnostics: 8000,
  solutionLoad: 90_000,
};

// Server capabilities the editor's providers are built on. csharp-ls advertises
// every one of these today, so a missing entry means the server was downgraded
// or swapped — which removes an editor feature silently, with no error on
// either side, exactly like the ACP capability switches in CLAUDE.md.
//
// `foldingRangeProvider` and `selectionRangeProvider` are deliberately absent.
// 0.23 added folding ranges and 0.27 advertises them, but the editor registers
// no folding provider — Monaco still folds by indentation — so requiring it
// here would assert a capability nothing depends on. Wire the provider first,
// then add it. `selectionRangeProvider` is still unimplemented upstream.
const REQUIRED_CAPABILITIES = [
  'definitionProvider',
  'diagnosticProvider',
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

// ── result reporting ───────────────────────────────────────────────────────

const timings: string[] = [];

function skip(reason: string): never {
  if (REQUIRED) {
    console.error(`\n  FAIL  C# IntelliSense check could not run: ${reason}`);
    console.error('        UNITYIDE_INTELLISENSE_E2E=required forbids skipping.\n');
    console.error(`RESULT FAIL  ${reason} (skip forbidden)`);
    process.exit(1);
  }
  // Loud on purpose. A quiet skip is what let the last break go unnoticed: the
  // Rust smoke tests pointed at a deleted path and passed by returning early.
  console.log(`\n  SKIPPED  C# IntelliSense end-to-end check — ${reason}`);
  console.log('           This check did NOT run. It is not evidence of anything.\n');
  console.log(
    `RESULT SKIPPED  ${reason} — set UNITYIDE_SMOKE_UNITY_PROJECT=<path> or UNITYIDE_INTELLISENSE_E2E=required`,
  );
  process.exit(0);
}

function fail(msg: string, extra?: string): never {
  console.error(`\n  FAIL  ${msg}`);
  if (extra) console.error(extra);
  console.error('');
  console.error(`RESULT FAIL  ${msg}`);
  process.exit(1);
}

function pass(label: string, detail: string): void {
  console.log(`  ok  ${label.padEnd(14)} ${detail}`);
}

function budget(label: string, ms: number, limit: number): void {
  const scaled = Math.round(limit * BUDGET_SCALE);
  timings.push(`${label}=${ms}ms`);
  const verdict = ms <= scaled ? 'ok' : 'SLOW';
  console.log(`  ${verdict === 'ok' ? 'ok' : '!!'}  ${label.padEnd(14)} ${ms}ms (budget ${scaled}ms)`);
  if (ms > scaled) {
    fail(
      `${label} took ${ms}ms, over its ${scaled}ms budget`,
      '  IntelliSense that answers this slowly is unusable in practice, even\n' +
        '  though every correctness assertion above still passes. Raise\n' +
        '  UNITYIDE_INTELLISENSE_BUDGET_SCALE only for a genuinely slow machine.',
    );
  }
}

function wantSection(name: string): boolean {
  return ONLY_SECTION === null || ONLY_SECTION === name;
}

// ── prerequisites ──────────────────────────────────────────────────────────

const home = os.homedir();
const projects = discoverUnityProjects({ env: process.env, platform: process.platform, home });
if (projects.length === 0) {
  skip('no Unity project found (open one in Unity, or set UNITYIDE_SMOKE_UNITY_PROJECT)');
}
const project = projects[0];

const pinnedVersion = readPinnedCsharpLsVersion(
  fs.readFileSync(path.join(EDITOR_DIR, 'src-tauri', 'src', 'csharp_ls.rs'), 'utf8'),
);
if (!pinnedVersion) fail('could not read CSHARP_LS_VERSION from src-tauri/src/csharp_ls.rs');

const lookup = { env: process.env, platform: process.platform, home, pinnedVersion };
let server0 = discoverCsharpLs(lookup);
if (!server0) {
  // Provision it, rather than skipping. The app installs the pinned server on
  // its next C# start, but that is AFTER this gate runs — so on the first run
  // following a version bump the check would print SKIPPED at exactly the
  // moment an upgrade most needs verifying. This drives the same
  // `install_into` the app calls, so what gets probed is what users get.
  console.log(`  provisioning csharp-ls ${pinnedVersion} from the bundled package…`);
  const provision = spawnSync(
    'cargo',
    [
      'test',
      '--lib',
      'csharp_ls::tests::provisions_the_pinned_server_into_the_managed_directory',
      '--',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: path.join(EDITOR_DIR, 'src-tauri'),
      env: { ...process.env, UNITYIDE_PROVISION_MANAGED: '1', UNITYIDE_CSHARP_LS_E2E: 'required' },
      encoding: 'utf8',
    },
  );
  if (provision.status !== 0) {
    fail(
      `could not provision csharp-ls ${pinnedVersion}`,
      (provision.stderr || provision.stdout || '').slice(-2000),
    );
  }
  server0 = discoverCsharpLs(lookup);
}
if (!server0) {
  skip(
    `csharp-ls ${pinnedVersion} is not installed and could not be provisioned ` +
      '(set UNITYIDE_CSHARP_LS_DLL to point at one)',
  );
}

const which = (cmd: string): string | null => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
  });
  const first = (r.stdout ?? '').split(/\r?\n/).find(Boolean);
  return r.status === 0 && first ? first.trim() : null;
};
const dotnetRoot = resolveDotnetRoot(process.platform, process.env, which);
if (!dotnetRoot) skip('no .NET host found (install the .NET SDK)');

// A path the generated csproj already globs in, so Roslyn treats the probe as
// part of the project rather than as a loose file. Content is replaced
// wholesale by didOpen — the file on disk is never read or written.
const probeFile = (function findCs(dir: string): string | null {
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

console.log('');
console.log(`  project     ${project}`);
console.log(`  csharp-ls   ${server0.describe}  (pin ${pinnedVersion}, found via ${server0.source})`);
console.log(`  dotnet      ${dotnetRoot}`);
console.log('');

// ── URI parity ─────────────────────────────────────────────────────────────
//
// THE regression, asserted before a single byte goes to the server.
//
// Notifications name a document with `fileUri(path)`. Requests name it with
// `lspDocumentUri(model)`. Those must be the same string. They were not: the
// old client built request URIs from `model.uri.toString()`, which Monaco
// renders with a lower-cased drive letter and a percent-encoded colon
// (`file:///c%3A/...`), and csharp-ls answered `null` to every position
// request on Windows for months.
//
// This runs the editor's real functions over Monaco's real URI parser, so it
// fails the same way the app would.
const probePath = probeFile.replace(/\\/g, '/');
const openUri = fileUri(probePath);
const monacoModel = { uri: URI.parse(openUri) };
const requestUri = lspDocumentUri(monacoModel);
if (requestUri !== openUri) {
  fail(
    'the URI used for requests differs from the one used for didOpen',
    `    didOpen:  ${openUri}\n` +
      `    request:  ${requestUri}\n` +
      '  csharp-ls matches documents by URI. When these differ it answers null to\n' +
      '  every completion, hover, definition and diagnostic — silently.',
  );
}
pass('uri parity', `${openUri.slice(0, 64)}…`);
const uri = openUri;

// ── regenerate through the real Rust generator ─────────────────────────────

const gen = spawnSync(
  'cargo',
  ['test', '--lib', 'unity::tests::smoke_generate_full_setup', '--', '--exact'],
  {
    cwd: path.join(EDITOR_DIR, 'src-tauri'),
    env: { ...process.env, UNITYIDE_SMOKE_UNITY_PROJECT: project, UNITYIDE_SMOKE_E2E: 'required' },
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
pass('generated', path.basename(solution));

// ── drive the real server ──────────────────────────────────────────────────

const server = spawn(
  server0.program,
  [...server0.leadingArgs, '--loglevel', 'info', '--solution', solution],
  { cwd: project, env: { ...process.env, DOTNET_ROOT: dotnetRoot } },
);

let buf = Buffer.alloc(0);
const pending = new Map<number, (m: JsonRpcMessage) => void>();
let nextId = 1;
let solutionLoaded = false;
const logs: string[] = [];
// Capabilities can arrive AFTER initialize, via client/registerCapability.
// Answering that request with `null` and dropping the payload — which this
// script once did — makes a dynamically-registered provider invisible to the
// capability report below, so a feature could look absent while working fine.
const dynamicRegistrations: string[] = [];

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

server.stdout.on('data', (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const m = /Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString());
    if (!m) return;
    const start = sep + 4;
    const len = Number(m[1]);
    if (buf.length < start + len) return;
    const msg: JsonRpcMessage = JSON.parse(buf.subarray(start, start + len).toString());
    buf = buf.subarray(start + len);

    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'window/logMessage') {
      logs.push(msg.params.message);
        // Same predicate the app uses, imported rather than re-spelled: a probe
      // with its own copy of this regex would keep passing through a rename
      // that had silently degraded the editor to its failsafe timer.
      if (isLoadFinishedMessage(msg.params.message)) solutionLoaded = true;
    } else if (msg.id !== undefined && msg.method) {
      if (msg.method === 'client/registerCapability') {
        for (const reg of msg.params?.registrations ?? []) dynamicRegistrations.push(reg.method);
      }
      // Answer `workspace/configuration` with what the EDITOR answers, not
      // with `{}`. csharp-ls defaults `analyzersEnabled` to off, so a probe
      // that under-reports its configuration would see no Unity diagnostics
      // and conclude the analyzers are broken — or, worse, be adjusted to
      // stop asking for them.
      const items = (msg.params as { items?: { section?: string }[] })?.items ?? [];
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result:
          msg.method === 'workspace/configuration'
            ? items.map((item) => configurationForItem('csharp', item?.section))
            : null,
      });
    }
  }
});
server.on('error', (err) => fail(`could not start csharp-ls: ${err.message}`));
server.stderr.on('data', (d: Buffer) => logs.push(d.toString()));

function send(obj: unknown): void {
  const s = JSON.stringify(obj);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
}
function request(method: string, params: unknown): Promise<JsonRpcMessage> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 60_000);
    send({ jsonrpc: '2.0', id, method, params });
  });
}
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now();
  const value = await fn();
  return [value, Date.now() - t];
}
const notify = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const labelsOf = (result: any): string[] => {
  const items = result?.items ?? result ?? [];
  return Array.isArray(items)
    ? items.map((i: any) => (typeof i.label === 'string' ? i.label : i.label?.label))
    : [];
};

// ── the probe document ─────────────────────────────────────────────────────
//
// One file exercising static members, instance members and a real type error.
// Positions are located by anchor, never hardcoded: a literal column once
// stopped pointing at `MonoBehaviour` when a class name changed length, and the
// check then reported "hover resolved nothing" — a broken-IntelliSense failure
// for a cursor bug of its own making.
const PROBE = [
  'using UnityEngine;',
  '',
  'public class UnityIDEIntelliSenseProbe : MonoBehaviour',
  '{',
  '    private int removedLater;',
  '',
  '    private void Start()',
  '    {',
  '        int wrongType = "not an int";',
  '        Camera.',
  '    }',
  '',
  '    private void Update()',
  '    {',
  '        transform.',
  '    }',
  '}',
  '',
].join('\n');

let version = 1;
function didChange(text: string): void {
  version += 1;
  notify('textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text }],
  });
}

try {
  // These capabilities mirror `src/features/lsp/services/client.ts`. A server
  // may gate its own behaviour on the client declaring the matching
  // capability, so a probe that asks for less than the editor does would
  // report a feature missing that actually works — and vice versa.
  const init = await request('initialize', {
    processId: null,
    rootUri: fileUri(project),
    workspaceFolders: [{ uri: fileUri(project), name: path.basename(project) }],
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      textDocument: {
        completion: {
          contextSupport: true,
          completionItem: {
            snippetSupport: true,
            documentationFormat: ['markdown', 'plaintext'],
            insertReplaceSupport: true,
            labelDetailsSupport: true,
            commitCharactersSupport: true,
            resolveSupport: {
              properties: ['documentation', 'detail', 'additionalTextEdits'],
            },
          },
          completionList: {
            itemDefaults: [
              'commitCharacters',
              'editRange',
              'insertTextFormat',
              'insertTextMode',
              'data',
            ],
          },
        },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        signatureHelp: {},
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        publishDiagnostics: {},
        synchronization: { didSave: true },
        definition: { linkSupport: true },
        declaration: { linkSupport: true },
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
      workspace: { configuration: true, workspaceFolders: true, symbol: {}, applyEdit: true },
    },
  });
  notify('initialized', {});
  const serverCaps: Record<string, unknown> = init.result?.capabilities ?? {};

  // Open the document, THEN wait for the load.
  //
  // Since csharp-ls 0.23 the solution loads on demand: nothing happens at
  // `initialize`, and the load begins with the first `didOpen`. Waiting first
  // and opening second — which is what this script used to do, correctly, for
  // 0.22 — now deadlocks until the timeout. The app is not affected because it
  // opens tabs as the user does, but its readiness gate had to learn the same
  // lesson (see `markCsharpProjectLoading`).
  const loadStart = Date.now();
  notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'csharp', version: 1, text: PROBE },
  });
  while (!solutionLoaded && Date.now() - loadStart < BUDGET.solutionLoad * BUDGET_SCALE) {
    await sleep(250);
  }
  if (!solutionLoaded) {
    fail(
      'csharp-ls never reported that it finished loading the solution',
      logs.slice(-10).join('\n') +
        '\n  The readiness gate in project-readiness.ts keys off this exact log line.\n' +
        '  If the server renamed it, diagnostics fall back to a 20s failsafe timer.',
    );
  }
  pass('solution', `loaded in ${Date.now() - loadStart}ms`);

  // Roslyn re-attaches the open document to the freshly loaded project; that
  // is not instantaneous, and asking too early answers out of the
  // miscellaneous-files workspace, which has no Unity references at all.
  await sleep(3000);

  const failures = logs.filter((l) => /\[Failure\]|Project file not found/i.test(l));
  if (failures.length) {
    fail(
      `csharp-ls could not load ${failures.length} project(s) from the solution`,
      failures.slice(0, 5).map((l) => '    ' + l).join('\n'),
    );
  }

  // ── static member completion ─────────────────────────────────────────────
  //
  // `Camera.main` is the case the user reported and the old probe could not
  // see: it only ever asked for instance members on `transform.`, which happen
  // to appear as word-based suggestions from elsewhere in the file even when
  // the language server is answering nothing at all.
  if (wantSection('completion')) {
    const [staticRes, staticMs] = await timed(() =>
      request('textDocument/completion', {
        textDocument: { uri },
        position: locate(PROBE, '        Camera.'),
        context: { triggerKind: 2, triggerCharacter: '.' },
      }),
    );
    const staticLabels = labelsOf(staticRes.result);
    for (const expected of ['main', 'allCameras']) {
      if (!staticLabels.includes(expected)) {
        fail(
          `\`Camera.\` completions are missing \`${expected}\``,
          `    got ${staticLabels.length} items: ${staticLabels.slice(0, 20).join(', ')}\n` +
            '  Static members come only from Roslyn. Their absence is the shape of a\n' +
            '  dead language server hidden behind word-based suggestions.',
        );
      }
    }
    if (staticLabels.includes('fieldOfView')) {
      fail(
        '`Camera.` offered an instance member (`fieldOfView`) at a static position',
        '  The server is not resolving `Camera` as a type.',
      );
    }
    pass('static member', `Camera. → ${staticLabels.length} items (main, allCameras)`);
    budget('first completion', staticMs, BUDGET.firstCompletion);

    const [instRes, instMs] = await timed(() =>
      request('textDocument/completion', {
        textDocument: { uri },
        position: locate(PROBE, '        transform.'),
        context: { triggerKind: 2, triggerCharacter: '.' },
      }),
    );
    const instLabels = labelsOf(instRes.result);
    if (instLabels.length < MIN_COMPLETIONS) {
      fail(
        `\`transform.\` returned ${instLabels.length} completions, expected >= ${MIN_COMPLETIONS}`,
        '  Roslyn resolved no Unity types — the reference set or the solution is broken.',
      );
    }
    for (const expected of ['position', 'rotation', 'localScale']) {
      if (!instLabels.includes(expected)) {
        fail(
          `\`transform.\` completions are missing \`${expected}\``,
          `    got: ${instLabels.slice(0, 20).join(', ')}`,
        );
      }
    }
    pass('instance member', `transform. → ${instLabels.length} items`);
    budget('warm completion', instMs, BUDGET.warmCompletion);

    // Informational: the client's completion policy is built on both of these.
    const shape = instRes.result ?? {};
    console.log(
      `  --  list shape    isIncomplete=${shape.isIncomplete} ` +
        `itemDefaults=${shape.itemDefaults ? 'yes' : 'none'} ` +
        `textEdit=${(shape.items ?? [])[0]?.textEdit ? 'yes' : 'none'}`,
    );

    // ── resolve ────────────────────────────────────────────────────────────
    //
    // csharp-ls sends bare items and computes documentation on demand. If this
    // stops working, every C# completion loses its signature and docs — which
    // reads as "this editor has no documentation" rather than as a missing
    // request.
    const items = instRes.result?.items ?? instRes.result ?? [];
    const position = items.find(
      (i: any) => (typeof i.label === 'string' ? i.label : i.label?.label) === 'position',
    );
    if (!position) fail('`transform.` completions no longer include `position`');
    const [resolveRes, resolveMs] = await timed(() =>
      request('completionItem/resolve', position),
    );
    const resolved = resolveRes.result;
    const doc = typeof resolved?.documentation === 'string'
      ? resolved.documentation
      : resolved?.documentation?.value;
    if (!resolved?.detail && !doc) {
      fail(
        'completionItem/resolve returned no detail and no documentation',
        `    got: ${JSON.stringify(resolved).slice(0, 200)}\n` +
          '  The server advertises resolveProvider and sends items without docs, so\n' +
          '  without this every C# completion is a bare name.',
      );
    }
    pass('resolve', `${JSON.stringify(resolved?.detail ?? doc).slice(0, 48)}…`);
    budget('resolve', resolveMs, BUDGET.resolve);
  }

  // ── hover ────────────────────────────────────────────────────────────────
  if (wantSection('hover')) {
    const [hover, hoverMs] = await timed(() =>
      request('textDocument/hover', {
        textDocument: { uri },
        position: locate(PROBE, 'MonoBehaviour', 1),
      }),
    );
    const hoverText = JSON.stringify(hover.result?.contents ?? '');
    if (!/MonoBehaviour/.test(hoverText)) {
      fail('hover over `MonoBehaviour` resolved nothing', `    got: ${hoverText.slice(0, 200)}`);
    }
    pass('hover', 'MonoBehaviour resolves');
    budget('hover', hoverMs, BUDGET.hover);
  }

  // ── incremental typing ───────────────────────────────────────────────────
  //
  // The real editing flow: didOpen, then a didChange per keystroke, then a
  // completion that must reflect the newest text. Nothing exercised this
  // before — the old probe sent exactly one didChange and never asked for
  // completions afterwards — so a client that dropped or reordered edits would
  // have looked perfectly healthy here while offering members of a file the
  // user had already changed.
  if (wantSection('incremental')) {
    const EDITED = PROBE.replace(
      '    private int removedLater;',
      '    private int addedInVersion2;',
    ).replace('        Camera.', '        this.');
    didChange(EDITED.replace('        this.', '        thi'));
    didChange(EDITED.replace('        this.', '        this'));
    didChange(EDITED);
    await sleep(1500);

    const incremental = await request('textDocument/completion', {
      textDocument: { uri },
      position: locate(EDITED, '        this.'),
      context: { triggerKind: 2, triggerCharacter: '.' },
    });
    if (incremental.error) {
      fail(
        `completion after incremental edits failed: ${JSON.stringify(incremental.error)}`,
        '  A -32801 here means the client and server disagree about the document\n' +
          '  version — edits are being lost or reordered.',
      );
    }
    const afterEdit = labelsOf(incremental.result);
    if (!afterEdit.includes('addedInVersion2')) {
      fail(
        'completion does not reflect the most recent edit',
        `    expected \`addedInVersion2\`, got: ${afterEdit.slice(0, 20).join(', ')}\n` +
          '  The server is answering against a stale revision of the document.',
      );
    }
    if (afterEdit.includes('removedLater')) {
      fail(
        'completion still offers a member the user deleted',
        '  The server is answering against a stale revision of the document.',
      );
    }
    pass('incremental', `v${version}: addedInVersion2 present, removedLater gone`);
  }

  // ── diagnostics ──────────────────────────────────────────────────────────
  //
  // Two assertions in one request. The absence check is the old one: completion
  // and hover answer out of explicitly referenced assemblies, so they keep
  // working even when the project declares TWO corelibs and every file reports
  // CS0518/CS0433 on nearly every line — the editor unusable while this script
  // printed PASS.
  //
  // The presence check is new, and it is the one that matters more: a server
  // answering `textDocument/diagnostic` with an empty list forever would have
  // passed every version of this check ever written.
  if (wantSection('diagnostics')) {
    didChange(PROBE);
    await sleep(1500);
    const [diagnostics, diagMs] = await timed(() =>
      request('textDocument/diagnostic', { textDocument: { uri } }),
    );
    if (diagnostics.error) {
      fail(
        'csharp-ls refused `textDocument/diagnostic`',
        `    ${JSON.stringify(diagnostics.error)}\n` +
          '  The editor pulls diagnostics over this exact request — if it does not\n' +
          '  answer, no C# error or warning can ever reach Monaco.',
      );
    }
    const items = diagnostics.result?.items ?? [];
    const codes = items.map((d: any) => String(d.code ?? ''));

    if (!codes.includes('CS0029')) {
      fail(
        'csharp-ls reported no CS0029 for `int wrongType = "not an int";`',
        `    codes seen: ${codes.join(', ') || '(none)'}\n` +
          '  Diagnostics that are merely ABSENT are indistinguishable from a clean\n' +
          '  file. This asserts the pipeline actually produces one.',
      );
    }

    const CORELIB_CODES = new Set(['CS0518', 'CS0433']);
    const corelib = items.filter((d: any) => CORELIB_CODES.has(String(d.code ?? '')));
    if (corelib.length) {
      fail(
        `csharp-ls reports ${corelib.length} corelib error(s) — the project declares more than one corelib`,
        corelib.slice(0, 5).map((d: any) => `    ${d.code}: ${d.message}`).join('\n') +
          '\n  Check <NoStdLib> in the generated .unityide.csproj (unity.rs): with the\n' +
          '  netstandard reference set AND FrameworkPathOverride both present, it must\n' +
          '  be true, or MSBuild adds a second mscorlib on top of netstandard.',
      );
    }
    pass('diagnostics', `CS0029 reported, no CS0518/CS0433 (${items.length} total)`);
    budget('diagnostics', diagMs, BUDGET.diagnosticsAfterEdit);
  }

  // ── Unity analyzers ──────────────────────────────────────────────────────
  //
  // The chain from a vendored NuGet package to a squiggle in the editor has
  // five links, and four of them fail silently:
  //
  //   1. the package unpacks                  (unity_analyzers.rs)
  //   2. the csproj names it in <Analyzer>    (unity.rs)
  //   3. WarningLevel is not 0                (unity.rs — Roslyn discards
  //                                            analyzer diagnostics above the
  //                                            project's warning level)
  //   4. analyzersEnabled reaches the server  (csharp-configuration.ts —
  //                                            csharp-ls defaults it OFF)
  //   5. the server is new enough to run them (0.24+)
  //
  // Break any one and the editor reports nothing, which is indistinguishable
  // from clean code. So this asserts specific diagnostics arrive, by code.
  if (wantSection('analyzers')) {
    const analyzersSupported = compareVersions(pinnedVersion, '0.24.0') >= 0;
    const csprojText = fs.readFileSync(path.join(project, '.unityide.csproj'), 'utf8');
    const analyzerInProject = csprojText.includes('<Analyzer Include=');

    if (!analyzersSupported || !analyzerInProject) {
      const reason = !analyzersSupported
        ? `csharp-ls ${pinnedVersion} predates analyzer support (0.24.0)`
        : 'the generated csproj references no analyzer — run `bun run prepare:unity-analyzers`';
      console.log(`  --  analyzers      SKIPPED: ${reason}`);
      if (REQUIRED || process.env.UNITYIDE_ANALYZERS_E2E === 'required') {
        fail(`Unity analyzers could not be checked: ${reason}`);
      }
    } else {
      // Every line below triggers one specific UNT rule, chosen because each
      // is unambiguous and something a Unity developer actually writes.
      const ANALYZER_PROBE = [
        'using UnityEngine;',
        '',
        'public class UnityIDEAnalyzerProbe : MonoBehaviour',
        '{',
        '    [SerializeField] private int health;',
        '',
        '    private void Update()',
        '    {',
        '        float step = Time.fixedDeltaTime;',
        '        if (tag == "Player") { Debug.Log(step + health); }',
        '    }',
        '',
        '    private void LateUpdate()',
        '    {',
        '    }',
        '}',
        '',
      ].join('\n');
      didChange(ANALYZER_PROBE);
      await sleep(2500);

      const [report, analyzerMs] = await timed(() =>
        request('textDocument/diagnostic', { textDocument: { uri } }),
      );
      const items = report.result?.items ?? [];
      const codes = items.map((d: any) => String(d.code ?? ''));

      // UNT0004: Time.fixedDeltaTime in Update (it belongs in FixedUpdate).
      // UNT0002: string tag comparison instead of CompareTag.
      // UNT0001: an empty Unity message, which Unity still calls every frame.
      for (const [code, why] of [
        ['UNT0004', 'Time.fixedDeltaTime used in Update()'],
        ['UNT0002', 'tag == "Player" instead of CompareTag'],
        ['UNT0001', 'an empty LateUpdate()'],
      ] as const) {
        if (!codes.includes(code)) {
          fail(
            `the Unity analyzers reported no ${code} for ${why}`,
            `    codes seen: ${codes.join(', ') || '(none)'}\n` +
              '  Check, in order: the <Analyzer Include> item in .unityide.csproj,\n' +
              '  <WarningLevel> (0 discards every analyzer diagnostic), and that\n' +
              '  workspace/configuration answers analyzersEnabled: true.',
          );
        }
      }

      // The suppressors matter as much as the diagnostics: without USP0007
      // every [SerializeField] field is reported as never assigned, on
      // essentially every MonoBehaviour anyone writes.
      if (codes.includes('CS0649')) {
        fail(
          'CS0649 was reported for a [SerializeField] field',
          '  The analyzer suppressors are not being applied. Roslyn cannot know\n' +
            '  that Unity assigns serialized fields, so without them the editor\n' +
            '  warns about almost every MonoBehaviour field a user writes.',
        );
      }

      pass('analyzers', `UNT0001, UNT0002, UNT0004 reported; no CS0649 (${items.length} total)`);
      budget('analyzer pull', analyzerMs, BUDGET.analyzerDiagnostics);

      // Turning them off must actually turn them off — and must invalidate the
      // cached report, which csharp-ls does by folding the flag into resultId.
      notify('workspace/didChangeConfiguration', {
        settings: { csharp: { analyzersEnabled: false } },
      });
      await sleep(1500);
      const off = await request('textDocument/diagnostic', {
        textDocument: { uri },
        previousResultId: report.result?.resultId,
      });
      const offCodes = (off.result?.items ?? []).map((d: any) => String(d.code ?? ''));
      if (off.result?.kind === 'unchanged' || offCodes.some((c: string) => c.startsWith('UNT'))) {
        fail(
          'disabling the analyzers left UNT diagnostics in place',
          `    kind=${off.result?.kind} codes=${offCodes.join(', ')}\n` +
            '  The setting is a user-facing switch for a real cost; if it does not\n' +
            '  take effect, turning it off cannot relieve that cost.',
        );
      }
      pass('analyzer toggle', 'disabling clears UNT diagnostics');

      notify('workspace/didChangeConfiguration', {
        settings: { csharp: { analyzersEnabled: true } },
      });
    }
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
        '  either side.',
    );
  }
  pass('capabilities', `${REQUIRED_CAPABILITIES.length} required present`);

  const serverVersion = (logs.join('\n').match(/version ([\d.]+)/) ?? [])[1] ?? pinnedVersion;
  console.log('');
  console.log('  PASS  C# IntelliSense is working end to end\n');
  console.log(
    `RESULT PASS  project=${project} csharp-ls=${serverVersion} ${timings.join(' ')}`,
  );
  server.kill();
  process.exit(0);
} catch (err) {
  server.kill();
  fail((err as Error).message, logs.slice(-10).join('\n'));
}
