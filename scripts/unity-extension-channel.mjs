/**
 * Turn a copy of the Unity extension into its dev-channel variant.
 *
 * The package ships twice, because the two release channels are separate
 * applications end to end: a different product name, deep-link scheme, config
 * directory and updater feed. One package that worked out at runtime which of
 * them the user meant got it wrong in the case that mattered — it always
 * resolved to release, so anyone testing the dev build had their double-clicks
 * answered by the release app, silently.
 *
 * The checked-in source in `arcane-extension/` IS the release package. This
 * script rewrites a COPY of it into the dev one. It never edits in place, so
 * running it against the source tree by accident is not a way to lose the
 * release values.
 *
 * Four things change, and all four have to:
 *
 *   1. `Editor/UnityIDEChannel.cs` — the constants everything else reads.
 *   2. `package.json` — a different UPM id, so Unity treats them as different
 *      packages rather than as two versions of one.
 *   3. Assembly names in the .asmdef files — Unity refuses to compile two
 *      assemblies with the same name in one project.
 *   4. Every asset GUID in the .meta files. This is the one that looks
 *      optional and is not: two packages declaring the same GUIDs in one
 *      project is a GUID conflict, and Unity resolves it by picking a winner
 *      arbitrarily. The same trap is documented on the app side in
 *      `unity::remove_legacy_bridge_package`.
 *
 * GUIDs are derived, not random: md5(original + ":" + channel). A build has to
 * produce the same GUIDs as the last one, or every upgrade breaks the asmdef
 * references that point at them.
 *
 * Usage: node scripts/unity-extension-channel.mjs <dir> <release|dev>
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CHANNELS = {
  release: {
    displayName: 'UnityIDE',
    scheme: 'unityide',
    configDirName: '.unityide',
    linuxBinaryName: 'unityide',
    packageName: 'com.unityide.editor',
    packageDisplayName: 'UnityIDE Integration',
    assemblySuffix: '',
    legacyAppName: 'Arcane',
    downloadUrl: 'https://unityide.app/download',
    isDev: false,
  },
  dev: {
    // Mirrors `productName` in editor/src-tauri/tauri.dev.conf.json, which is
    // what names the installed application and therefore its install paths.
    displayName: 'UnityIDE Dev',
    // Mirrors that file's `plugins.deep-link.desktop.schemes`.
    scheme: 'unityide-dev',
    // Mirrors `auth::config_dir_name` for the `.dev` bundle identifier.
    configDirName: '.unityide-dev',
    linuxBinaryName: 'unityide-dev',
    packageName: 'com.unityide.editor.dev',
    packageDisplayName: 'UnityIDE Dev Integration',
    assemblySuffix: '.Dev',
    // There was never a dev-channel build under the pre-rename name, so this
    // channel has no legacy path to probe.
    legacyAppName: '',
    downloadUrl: 'https://unityide.app/download#dev',
    isDev: true,
  },
};

/** Every file whose contents this script rewrites, by extension. */
const REWRITTEN = new Set(['.cs', '.asmdef', '.json', '.meta']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * A stable GUID for `guid` in `channel`.
 *
 * Unity wants 32 lowercase hex characters, which is exactly an md5 digest.
 * There is no meaning in the value beyond "different from the release one and
 * the same on every build".
 */
export function remapGuid(guid, channel) {
  return createHash('md5').update(`${guid}:${channel}`).digest('hex');
}

/** Rewrite the C# constants that every other file reads the channel from. */
function rewriteChannelConstants(text, c) {
  const set = (name, literal) => {
    const re = new RegExp(`(public const \\w+ ${name} =\\s*)[^;]+;`);
    if (!re.test(text)) throw new Error(`UnityIDEChannel.cs has no ${name} constant`);
    text = text.replace(re, `$1${literal};`);
  };
  set('DisplayName', JSON.stringify(c.displayName));
  set('Scheme', JSON.stringify(c.scheme));
  set('ConfigDirName', JSON.stringify(c.configDirName));
  set('LinuxBinaryName', JSON.stringify(c.linuxBinaryName));
  set('PackageName', JSON.stringify(c.packageName));
  set('DownloadUrl', JSON.stringify(c.downloadUrl));
  set('LegacyAppName', JSON.stringify(c.legacyAppName));
  set('IsDev', String(c.isDev));
  return text;
}

/**
 * Rewrite `dir` in place into `channel`.
 *
 * `release` is a no-op by construction: the source already is the release
 * package, so there is nothing to apply and nothing that could drift.
 */
export function applyChannel(dir, channel) {
  const c = CHANNELS[channel];
  if (!c) throw new Error(`unknown channel '${channel}' (expected: ${Object.keys(CHANNELS).join(', ')})`);
  if (channel === 'release') return { channel, files: 0, guids: 0 };

  const files = walk(dir).filter((f) => REWRITTEN.has(path.extname(f)));
  let guids = 0;
  let sawChannelFile = false;

  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    let after = before;

    if (path.basename(file) === 'UnityIDEChannel.cs') {
      after = rewriteChannelConstants(after, c);
      sawChannelFile = true;
    }

    if (path.basename(file) === 'package.json') {
      const pkg = JSON.parse(after);
      pkg.name = c.packageName;
      pkg.displayName = c.packageDisplayName;
      after = `${JSON.stringify(pkg, null, 4)}\n`;
    }

    // `InternalsVisibleTo` names the test assembly by its literal name, and
    // that name just gained a suffix. Missing this does not fail the build that
    // produces the package — it fails later, inside Unity, when the dev test
    // assembly cannot see the types it exists to test.
    if (path.extname(file) === '.cs') {
      after = after.replace(
        /(InternalsVisibleTo\(")(UnityIDE\.[\w.]+)(")/g,
        (_m, open, name, close) => `${open}${name}${c.assemblySuffix}${close}`,
      );
    }

    if (path.extname(file) === '.asmdef') {
      const asmdef = JSON.parse(after);
      asmdef.name = `${asmdef.name}${c.assemblySuffix}`;
      // A test assembly references the editor assembly BY NAME, and that name
      // just changed.
      if (Array.isArray(asmdef.references)) {
        asmdef.references = asmdef.references.map((r) =>
          r.startsWith('UnityIDE.') ? `${r}${c.assemblySuffix}` : r,
        );
      }
      after = `${JSON.stringify(asmdef, null, 4)}\n`;
    }

    // Every 32-hex-character GUID, wherever it appears: the `guid:` line of a
    // .meta file, and any `GUID:` reference inside an asmdef.
    after = after.replace(/\b[0-9a-f]{32}\b/g, (guid) => {
      guids += 1;
      return remapGuid(guid, channel);
    });

    if (after !== before) writeFileSync(file, after);
  }

  if (!sawChannelFile) {
    throw new Error(`${dir} has no Editor/UnityIDEChannel.cs — is it the extension package?`);
  }

  return { channel, files: files.length, guids };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, channel] = process.argv.slice(2);
  if (!dir || !channel) {
    console.error('usage: node scripts/unity-extension-channel.mjs <dir> <release|dev>');
    process.exit(2);
  }
  try {
    const result = applyChannel(path.resolve(dir), channel);
    console.log(
      `[unity-extension-channel] ${result.channel}: ` +
        `${result.files} file(s) scanned, ${result.guids} guid(s) remapped`,
    );
  } catch (e) {
    console.error(`[unity-extension-channel] ${e.message}`);
    process.exit(1);
  }
}
