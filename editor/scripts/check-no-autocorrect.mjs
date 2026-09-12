#!/usr/bin/env node
// Every text field in the app must decline the OS's dictionary. See
// editable-fields.mjs for why, and add `data-allow-autocorrect` to opt one out.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnguardedFields, REQUIRED_ATTRIBUTES } from './editable-fields.mjs';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function* tsxFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* tsxFiles(path);
    else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) yield path;
  }
}

const problems = [];
for (const file of tsxFiles(SRC)) {
  const rel = file.slice(SRC.length - 3);
  problems.push(...findUnguardedFields(rel, readFileSync(file, 'utf8')));
}

if (problems.length > 0) {
  console.error(
    `Text fields that still accept macOS autocorrect and spelling suggestions:\n`,
  );
  for (const p of problems) {
    console.error(`  - ${p.name}:${p.line} <${p.tag}> missing ${p.missing.join(', ')}`);
  }
  console.error(
    `\nEvery text field must state: ${REQUIRED_ATTRIBUTES.join(', ')}.\n` +
      `Identifiers, paths, globs and regexes are all "misspelled", and a silently\n` +
      `autocorrected query returns the wrong results with nothing to show for it.\n` +
      `Add data-allow-autocorrect to a field that genuinely wants prose help.`,
  );
  process.exit(1);
}
console.log('no-autocorrect OK');
