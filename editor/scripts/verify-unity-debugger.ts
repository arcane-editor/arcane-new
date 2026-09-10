/**
 * Unity debugger end-to-end check.
 *
 * Drives the real native Mono soft-debugger client against a real Mono runtime
 * — the one Unity ships at `Editor/Data/MonoBleedingEdge/` — by compiling a
 * fixture with Unity's own C# compiler and running it under the agent. It never
 * attaches to a Unity editor the developer is using: doing that with a
 * half-finished client killed one during this feature's development.
 *
 * Why this exists at all, in the same terms as `verify:intellisense`: every
 * failure this subsystem has in the field is environmental — a Unity upgrade
 * that moves the runtime, a protocol revision that changes a payload width, an
 * agent that stops listening. None of those appear in a diff, and none of them
 * break a mocked test. Worse, the mistakes found while building this client
 * were all of a kind unit tests *cannot* catch: a unit test asserts whatever
 * the client encodes, so when the event-modifier count was written as an int
 * instead of a byte, every unit test agreed with the bug. The runtime did not.
 *
 * A SKIPPED is not a pass. Set UNITYIDE_DEBUGGER_E2E=required to turn a skip
 * into a failure, and UNITYIDE_DEBUGGER_MONO=<path to mono> to point the
 * harness at a runtime outside a Unity install.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAURI_DIR = join(HERE, '..', 'src-tauri');

/** Named slices, so a failure can be re-run without the rest. */
const SECTIONS: Record<string, { filter: string; label: string; budgetMs: number }> = {
  unit: {
    // Generous because this section pays for the cargo build on a cold target
    // directory; the tests themselves run in well under a second. The two
    // sections below are the ones whose timings mean anything, since by then
    // the crate is already built.
    filter: 'debug::',
    label: 'protocol codecs, breakpoint binding, value decoding, path matching',
    budgetMs: 300_000,
  },
  breakpoint: {
    filter: 'debug::e2e::tests::a_breakpoint_binds_hits_and_exposes_the_frame',
    label: 'attach, bind file:line, hit, read frame + locals + object fields',
    budgetMs: 90_000,
  },
  stepping: {
    filter: 'debug::e2e::tests::stepping_over_a_line_moves_to_the_next_one',
    label: 'step over lands further on in the same method',
    budgetMs: 90_000,
  },
  exceptions: {
    filter: 'debug::e2e::tests::an_exception_breakpoint_stops_on_a_throw',
    label: 'exception breakpoints stop on a throw and leave the runtime healthy',
    budgetMs: 90_000,
  },
  setNextStatement: {
    filter: 'debug::e2e::tests::setting_the_instruction_pointer_moves_execution',
    label: 'set next statement moves the pointer inside the method',
    budgetMs: 90_000,
  },
};

function fail(message: string, extra?: string): never {
  console.error(`\n  FAIL  ${message}`);
  if (extra) console.error(extra);
  console.error('\nRESULT FAIL');
  process.exit(1);
}

function skip(reason: string): never {
  if (process.env.UNITYIDE_DEBUGGER_E2E === 'required') {
    console.error(`\n  FAIL  Unity debugger check could not run: ${reason}`);
    console.error('        UNITYIDE_DEBUGGER_E2E=required forbids skipping.');
    console.error('\nRESULT FAIL');
    process.exit(1);
  }
  // Loud on purpose. A quiet skip reads exactly like a pass, which is how a
  // dead debugger stays invisible for months.
  console.log(`\n  SKIPPED  Unity debugger end-to-end check — ${reason}`);
  console.log('           This check did NOT run. It is not evidence of anything.');
  console.log('\nRESULT SKIPPED');
  process.exit(0);
}

function run(filter: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'cargo',
      ['test', '--lib', filter, '--', '--nocapture', '--test-threads=1'],
      { cwd: TAURI_DIR, env: process.env, shell: process.platform === 'win32' },
    );
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk.toString()));
    child.stderr.on('data', (chunk) => (output += chunk.toString()));
    child.on('error', (err) => resolve({ code: 1, output: `${output}\n${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sectionArg = args.indexOf('--section');
  let selected = Object.keys(SECTIONS);

  if (sectionArg !== -1) {
    const name = args[sectionArg + 1];
    // A typo here used to disable every section and still print PASS, so an
    // unknown name is a hard failure rather than an empty run.
    if (!name || !(name in SECTIONS)) {
      fail(
        `unknown --section '${name ?? ''}'`,
        `        known sections: ${Object.keys(SECTIONS).join(', ')}`,
      );
    }
    selected = [name];
  }

  console.log('\n  Unity debugger end-to-end check');
  console.log('  ------------------------------------------------------------');

  let skipped: string | null = null;

  for (const name of selected) {
    const section = SECTIONS[name];
    const started = Date.now();
    const { code, output } = await run(section.filter);
    const elapsed = Date.now() - started;

    if (/SKIPPED\s+Unity debugger end-to-end check/.test(output)) {
      skipped = /no Unity install found/.test(output)
        ? 'no Unity install found (set UNITYIDE_DEBUGGER_MONO to override)'
        : 'the harness reported it could not run';
      console.log(`  ${name.padEnd(12)} SKIPPED  ${section.label}`);
      continue;
    }

    if (code !== 0) {
      fail(`section '${name}' failed`, output.split('\n').slice(-40).join('\n'));
    }

    const overBudget = elapsed > section.budgetMs ? '  OVER BUDGET' : '';
    console.log(
      `  ${name.padEnd(12)} ok       ${section.label}  [${elapsed}ms / ${section.budgetMs}ms]${overBudget}`,
    );
  }

  if (skipped) skip(skipped);

  console.log('  ------------------------------------------------------------');
  console.log('  Native Mono soft-debugger client verified against a live agent.');
  console.log('  No adapter, no system Mono, nothing downloaded.');
  console.log('\nRESULT PASS');
}

main().catch((err) => fail(String(err)));
