/** Real Unity profiler verification in a disposable project. Never connects to a user's Editor. */
import { mkdtemp, mkdir, writeFile, cp, readFile, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
const root = resolve(import.meta.dir, '..');
let executable = process.env.UNITYIDE_PROFILER_EDITOR;
if (!executable) {
  const hub = process.platform === 'darwin' ? '/Applications/Unity/Hub/Editor' : process.platform === 'win32' ? 'C:/Program Files/Unity/Hub/Editor' : join(homedir(), 'Unity/Hub/Editor');
  for (const version of (await readdir(hub).catch(() => [] as string[])).sort().reverse()) {
    const candidate = join(hub, version, process.platform === 'darwin' ? 'Unity.app/Contents/MacOS/Unity' : process.platform === 'win32' ? 'Editor/Unity.exe' : 'Editor/Unity');
    if (await access(candidate).then(() => true, () => false)) { executable = candidate; break; }
  }
}
if (!executable) {
  console.log('SKIPPED Unity profiler: no Unity executable. Set UNITYIDE_PROFILER_EDITOR. This is unverified, not a pass.');
  process.exit(1);
}
const project = await mkdtemp(join(tmpdir(), 'unityide-profiler-'));
await mkdir(join(project, 'Assets'), { recursive: true });
await mkdir(join(project, 'ProjectSettings'), { recursive: true });
await mkdir(join(project, 'Packages'), { recursive: true });
await cp(resolve(root, '../arcane-extension'), join(project, 'Packages/com.unityide.editor'), { recursive: true });
await cp(join(root, 'tooling/unity-profiler/ProfilerVerification.cs'), join(project, 'Packages/com.unityide.editor/Editor/ProfilerVerification.cs'));
await writeFile(join(project, 'Packages/manifest.json'), JSON.stringify({ dependencies: {} }));
console.log(`Unity profiler fixture: ${project}`);
const log = join(project, 'unity.log');
const child = Bun.spawn([executable, '-batchmode', '-nographics', '-projectPath', project, '-executeMethod', 'UnityIDE.Bridge.ProfilerVerification.Run', '-logFile', log], { stdout: 'ignore', stderr: 'ignore' });
const timeout = setTimeout(() => child.kill(), 180_000);
const progress = setInterval(() => console.log('Unity profiler fixture is compiling or collecting frames…'), 30_000);
const code = await child.exited;
clearTimeout(timeout); clearInterval(progress);
const result = await readFile(join(project, 'profiler-verification.json'), 'utf8').then(s => JSON.parse(s) as { ok: boolean; message: string }, () => null);
if (code !== 0 || !result?.ok) {
  console.error(`FAIL Unity profiler: ${result?.message ?? `Unity exited ${code} without verification results. Inspect ${log}`}`);
  process.exit(1);
}
console.log(`PASS Unity profiler: ${result.message}`);
console.log('This verifies local Editor CPU capture. GPU, memory snapshots, other Unity versions and devices require separate coverage.');
