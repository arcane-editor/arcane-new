/** Build and serve mounted UI regression fixtures; run the button in a browser. */
import { mkdtempSync, realpathSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const editor = path.resolve(import.meta.dir, '..');
const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'unityide-ui-regression-')));
symlinkSync(path.join(editor, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
for (const name of readdirSync(path.join(editor, 'tooling/ui-regressions'))) {
  const contents = readFileSync(path.join(editor, 'tooling/ui-regressions', name), 'utf8')
    .replaceAll('__EDITOR__', editor.replaceAll('\\', '/'))
    .replaceAll('__FIXTURE__', fixture.replaceAll('\\', '/'));
  writeFileSync(path.join(fixture, name.replace(/\.template$/, '')), contents);
}

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
  console.log('Open http://127.0.0.1:43119 and click Run editor UI checks. Ctrl+C stops the fixture.');
