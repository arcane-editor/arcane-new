/** Compile all integration assemblies and optional input/tests with Unity's own compiler.
 * Does not claim runtime validation. Use Unity Test Runner for execution; see the harness guide.
 * UNITYIDE_UNITY_RESOURCES may point at another installed Unity's Resources directory.
 */
import { readdir, mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const resources = process.env.UNITYIDE_UNITY_RESOURCES ?? '/Applications/Unity/Hub/Editor/6000.3.5f2/Unity.app/Contents/Resources';
const extension = resolve(import.meta.dir, '../../arcane-extension');
const output = await mkdtemp(join(tmpdir(), 'unityide-automation-compile-'));
const scripting = join(resources, 'Scripting');
const mono = join(scripting, 'MonoBleedingEdge/bin/mono');
const csc = join(scripting, 'MonoBleedingEdge/lib/mono/4.5/csc.exe');
const cache = join(resources, 'PackageManager/ProjectTemplates/libcache/com.unity.template.3d-cross-platform-17.0.14/ScriptAssemblies');
const nunit = join(resources, 'PackageManager/BuiltInPackages/com.unity.ext.nunit/net40/unity-custom/nunit.framework.dll');
async function files(root: string, suffix: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path, suffix));
    else if (path.endsWith(suffix)) result.push(path);
  }
  return result;
}
try { await access(csc); } catch { throw new Error('Unity compiler unavailable. Set UNITYIDE_UNITY_RESOURCES; this check did not run.'); }
const references = [...await files(join(scripting, 'Managed/UnityEngine'), '.dll'),
  join(scripting, 'NetStandard/ref/2.1.0/netstandard.dll'), ...await files(join(scripting, 'NetStandard/compat/2.1.0/shims/netfx'), '.dll')];
const testReferences = [nunit, join(cache, 'UnityEditor.TestRunner.dll'), join(cache, 'UnityEngine.TestRunner.dll')];
async function compile(name: string, sources: string[], extra: string[] = [], defines = '') {
  await mkdir(output, { recursive: true });
  const destination = join(output, name + '.dll');
  const rsp = join(output, name + '.rsp');
  await writeFile(rsp, ['-nostdlib+', '-target:library', '-langversion:latest',
    '-define:UNITY_EDITOR,UNITY_2021_3_OR_NEWER,UNITY_6000_0_OR_NEWER' + defines, `-out:"${destination}"`,
    ...references.concat(extra).map((r) => `-r:"${r}"`), ...sources.map((p) => `"${p}"`)].join('\n'));
  const child = Bun.spawn([mono, csc, '-noconfig', '@' + rsp], { stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`${name} compilation failed.`);
  return destination;
}
const runtime = await compile('UnityIDE.Automation.Runtime', await files(join(extension, 'Runtime'), '.cs'));
const editorSources = (await files(join(extension, 'Editor'), '.cs')).filter((p) => !p.includes('/InputSystem/'));
// Core stays loadable without either optional integration package.
await compile('UnityIDE.Core.WithoutOptionalPackages', editorSources, [runtime]);
const editor = await compile('UnityIDE.Editor', editorSources, [runtime, ...testReferences], ',UNITYIDE_HAS_TEST_FRAMEWORK');
await compile('UnityIDE.Editor.Tests', await files(join(extension, 'Tests/Editor'), '.cs'), [runtime, editor, ...testReferences], ',UNITYIDE_HAS_TEST_FRAMEWORK,UNITY_INCLUDE_TESTS');
const input = await compile('UnityIDE.Automation.InputSystem', await files(join(extension, 'Editor/InputSystem'), '.cs'), [editor, join(cache, 'Unity.InputSystem.dll')], ',UNITYIDE_HAS_INPUT_SYSTEM');
await compile('UnityIDE.InputSystem.Tests', await files(join(extension, 'Tests/InputSystem'), '.cs'), [editor, input, join(cache, 'Unity.InputSystem.dll'), ...testReferences], ',UNITYIDE_HAS_INPUT_SYSTEM,UNITY_INCLUDE_TESTS');
console.log(`PASS: integration and test assemblies compile with and without optional packages. ${output}`);
console.log('Runtime tests, Play Mode reloads, input bindings and rendered captures are NOT verified by compilation.');
