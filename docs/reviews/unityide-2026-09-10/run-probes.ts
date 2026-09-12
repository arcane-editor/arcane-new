/** Review evidence, not a passing regression gate: assertions reproduce the bugs. */
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const editor = path.resolve(import.meta.dir, '../../../editor');
const fixture = mkdtempSync(path.join(tmpdir(), 'unityide-review-'));
symlinkSync(path.join(editor, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
for (const name of readdirSync(path.join(import.meta.dir, 'probes'))) {
  const contents = readFileSync(path.join(import.meta.dir, 'probes', name), 'utf8')
    .replaceAll('__EDITOR__', editor.replaceAll('\\', '/'))
    .replaceAll('__FIXTURE__', fixture.replaceAll('\\', '/'));
  writeFileSync(path.join(fixture, name.replace(/\.template$/, '')), contents);
}

let failed = false;
for (const name of ['workspace.exec.ts', 'format.exec.ts', 'cards.exec.tsx', 'composer.exec.ts', 'lifecycle.exec.ts']) {
  // Each probe needs its own Bun module registry: their mock.module calls
  // must never contaminate the repository's normal test process.
  const result = spawnSync(process.execPath, ['test', path.join(fixture, name)], { cwd: editor, encoding: 'utf8' });
  writeFileSync(path.join(fixture, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  console.log(result.stdout, result.stderr);
  failed ||= result.status !== 0;
}
console.log(`Synthetic fixtures and logs: ${fixture}`);
if (failed) process.exit(1);

if (process.argv.includes('--ui')) {
  const build = spawnSync(process.execPath, [path.join(fixture, 'ui-build.ts')], { cwd: editor, stdio: 'inherit' });
  if (build.status !== 0) process.exit(1);
  const allowed = new Set(['/index.html', '/ui.js', '/ui.css']);
  Bun.serve({
    hostname: '127.0.0.1',
    port: 43119,
    fetch(request) {
      const requested = new URL(request.url).pathname;
      const file = requested === '/' ? '/index.html' : requested;
      if (!allowed.has(file)) return new Response('Not found', { status: 404 });
      return new Response(Bun.file(path.join(fixture, 'ui-dist', file.slice(1))));
    },
  });
  console.log('Open http://127.0.0.1:43119 and click Run review UI checks. Ctrl+C stops the fixture.');
}
