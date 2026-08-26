#!/usr/bin/env node
/**
 * End-to-end check of the external-agent (ACP) bridge.
 *
 * Spawns the REAL `@agentclientprotocol/claude-agent-acp` adapter over the real
 * NDJSON stdio transport, runs `initialize` and `session/new`, and asserts the
 * agent answers with the capabilities the editor depends on. Unit tests cover
 * the framing, the translation and the install logic; this covers the only
 * thing a user notices — that a Claude session actually starts.
 *
 * Why a live probe rather than more mocks: every failure this integration has
 * in the field is environmental — Node too old, the adapter half-installed, a
 * renamed package, an expired login, a protocol bump. None of those show up in
 * a diff, and none of them break a mocked test. Same reasoning as
 * `verify-csharp-intellisense.mjs`, and for the same reason a SKIP here is NOT
 * a pass: it means the check did not run.
 *
 *   node scripts/verify-acp.mjs
 *
 * Env:
 *   ARCANE_ACP_ADAPTER   explicit path to the adapter's dist/index.js
 *   ARCANE_ACP_E2E       "required" → missing prerequisites fail (exit 1)
 *                        rather than skip. Use in pre-merge gates.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDITOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = process.env.ARCANE_ACP_E2E === 'required';

/** Must track `CLAUDE_AGENT_VERSION` / `REQUIRED_NODE_MAJOR` in src-tauri/src/acp.rs. */
const RUST_ACP = path.join(EDITOR_DIR, 'src-tauri', 'src', 'acp.rs');
const ADAPTER_REL = path.join(
  'node_modules',
  '@agentclientprotocol',
  'claude-agent-acp',
  'dist',
  'index.js',
);
const MIN_NODE_MAJOR = 22;
const HANDSHAKE_TIMEOUT_MS = 60_000;

function skip(reason) {
  if (REQUIRED) {
    console.error(`\n  FAIL  ACP check could not run: ${reason}`);
    console.error('        ARCANE_ACP_E2E=required forbids skipping.\n');
    process.exit(1);
  }
  // Loud on purpose. A quiet skip reads exactly like a pass, which is how the
  // C# IntelliSense break stayed invisible for weeks.
  console.log(`\n  SKIPPED  ACP external-agent end-to-end check — ${reason}`);
  console.log('           This check did NOT run. It is not evidence of anything.\n');
  process.exit(0);
}

function fail(msg, extra) {
  console.error(`\n  FAIL  ${msg}`);
  if (extra) console.error(String(extra).trimEnd());
  console.error('');
  process.exit(1);
}

// ── prerequisites ──────────────────────────────────────────────────────────

// The version the Rust installer pins. Read from source rather than duplicated,
// so a bump there cannot leave this check silently probing the old build.
const rustSource = fs.readFileSync(RUST_ACP, 'utf8');
const pinned = rustSource.match(/CLAUDE_AGENT_VERSION:\s*&str\s*=\s*"([^"]+)"/)?.[1];
if (!pinned) fail('Could not read CLAUDE_AGENT_VERSION out of src-tauri/src/acp.rs.');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < MIN_NODE_MAJOR) {
  skip(`this script is running on Node ${process.versions.node}; the adapter needs >= ${MIN_NODE_MAJOR}`);
}

// The two legacy dirs are the pre-rename names, kept as fallbacks so this
// check still RUNS on a machine that has not migrated yet. Dropping them would
// turn a real verification into a skip on every such machine — and a skip here
// reads exactly like a pass while proving nothing.
const candidates = [
  process.env.ARCANE_ACP_ADAPTER,
  path.join(os.homedir(), '.unityide', 'agents', 'claude', ADAPTER_REL),
  path.join(os.homedir(), '.unityide-dev', 'agents', 'claude', ADAPTER_REL),
  path.join(os.homedir(), '.arcane', 'agents', 'claude', ADAPTER_REL),
  path.join(os.homedir(), '.arcane-dev', 'agents', 'claude', ADAPTER_REL),
].filter(Boolean);

const adapter = candidates.find((p) => fs.existsSync(p));
if (!adapter) {
  skip(
    'the managed adapter is not installed — open the AI panel, pick Claude Code and let it install, ' +
      `or set ARCANE_ACP_ADAPTER (looked in: ${candidates.join(', ')})`,
  );
}

// Version drift is a warning, not a failure: the app deliberately keeps running
// an outdated adapter rather than nagging mid-task.
const manifest = path.join(adapter.split(`${path.sep}node_modules${path.sep}`)[0], '.unityide-agent.json');
if (fs.existsSync(manifest)) {
  try {
    const installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
    if (installed && installed !== pinned) {
      console.log(`  note: installed adapter ${installed}, pinned ${pinned}`);
    }
  } catch {
    // A corrupt manifest is the app's problem to re-install, not this check's.
  }
}

// ── the handshake ──────────────────────────────────────────────────────────

const env = { ...process.env };
// Reuse an existing CLI if the user has one; it is what the installer does.
const claudeCli = spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout?.trim();
if (claudeCli && !env.CLAUDE_CODE_EXECUTABLE) env.CLAUDE_CODE_EXECUTABLE = claudeCli;

const child = spawn(process.execPath, [adapter], {
  cwd: EDITOR_DIR,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (b) => {
  stderr += b.toString();
});
child.on('error', (e) => fail(`Could not spawn the adapter: ${e.message}`));

const pending = new Map();
let nextId = 1;
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // stray stdout write — the client ignores these too
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(msg.error);
      else entry.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method !== undefined) {
      // The adapter should not need anything from us before session/new, but
      // an unanswered request would deadlock the handshake.
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not implemented in verify' } })}\n`,
      );
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject({ code: 'TIMEOUT', message: `${method} did not answer in ${HANDSHAKE_TIMEOUT_MS / 1000}s` }),
      HANDSHAKE_TIMEOUT_MS,
    );
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function bail(msg, extra) {
  child.kill('SIGKILL');
  fail(msg, extra);
}

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    // Must mirror CLIENT_CAPABILITIES in `acp-translate.ts`. Several of these
    // are feature switches on the agent, so probing with a different set would
    // verify a session Arcane never actually opens.
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      auth: { terminal: true },
      elicitation: { form: {}, url: {} },
      session: { configOptions: { boolean: {} } },
      _meta: { 'terminal-auth': true },
    },
    clientInfo: { name: 'arcane-verify', title: 'Arcane', version: '0.0.0' },
  });

  if (init.protocolVersion !== 1) {
    bail(
      `The adapter negotiated ACP v${init.protocolVersion}; the editor implements v1.`,
      'Bump ACP_PROTOCOL_VERSION and the client, or pin an older adapter.',
    );
  }

  const caps = init.agentCapabilities ?? {};
  if (!caps.promptCapabilities) {
    bail('initialize returned no promptCapabilities — the editor reads it to gate image attachments.');
  }

  const session = await request('session/new', { cwd: EDITOR_DIR, mcpServers: [] }).catch((e) => {
    // -32000 is ACP's "authentication required". That is a real, expected state
    // on a machine nobody has signed in on — not a broken integration.
    if (e?.code === -32000) {
      child.kill('SIGKILL');
      skip('not signed in to Claude on this machine (agent answered auth_required)');
    }
    throw e;
  });

  if (!session?.sessionId) bail('session/new returned no sessionId.', JSON.stringify(session));

  const options = session.configOptions ?? [];
  const optionIds = options.map((o) => o.id);

  if (options.length === 0) {
    bail('session/new advertised no config options — mode and model switching would be empty.');
  }

  // `fast` arriving as a real boolean is the observable proof that
  // `session.configOptions.boolean` was accepted; an agent that did not see it
  // degrades the same option to a two-value select.
  const fast = options.find((o) => o.id === 'fast');
  if (fast && fast.type !== 'boolean') {
    bail(
      `The agent degraded 'fast' to a ${fast.type}, so the boolean capability was not accepted.`,
      'Check clientCapabilities.session.configOptions.boolean in acp-translate.ts.',
    );
  }

  child.kill('SIGKILL');

  console.log('\n  PASS  ACP external-agent end-to-end check');
  console.log(`        adapter        ${adapter}`);
  console.log(`        agent          ${init.agentInfo?.name ?? 'unknown'} ${init.agentInfo?.version ?? ''}`.trimEnd());
  console.log(`        protocol       v${init.protocolVersion}`);
  console.log(`        loadSession    ${caps.loadSession === true}`);
  console.log(`        config options ${optionIds.join(', ')}`);
  console.log(`        boolean opts   ${fast ? `yes (${fast.id})` : 'none advertised'}`);
  console.log('');
  process.exit(0);
} catch (e) {
  bail(
    `ACP handshake failed: ${e?.message ?? e}`,
    stderr ? `--- adapter stderr ---\n${stderr}` : undefined,
  );
}
