import { describe, it, expect } from 'bun:test';
import { checkVersionSync } from './version-sync.mjs';

const OK = {
  pkg: '{"version":"0.3.1"}',
  tauriConf: '{"version":"../package.json","plugins":{"updater":{"pubkey":"dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu"}}}',
  cargoToml: '[package]\nname = "editor"\nversion = "0.3.1"\n',
};

describe('checkVersionSync', () => {
  it('accepts a correctly wired tree', () => {
    expect(checkVersionSync(OK)).toEqual([]);
  });

  it('rejects a hardcoded version in tauri.conf.json', () => {
    // The whole point: if this is a literal, package.json stops being the
    // single source and the two can drift apart silently.
    const conf = OK.tauriConf.replace('"../package.json"', '"0.3.1"');
    expect(checkVersionSync({ ...OK, tauriConf: conf }).join(' '))
      .toContain('../package.json');
  });

  it('rejects a Cargo.toml version that disagrees with package.json', () => {
    const cargo = OK.cargoToml.replace('0.3.1', '0.3.0');
    expect(checkVersionSync({ ...OK, cargoToml: cargo }).join(' ')).toContain('0.3.0');
  });

  it('rejects an empty updater pubkey', () => {
    // A build shipped with no pubkey accepts no updates, ever, on every
    // install that receives it. There is no remote fix.
    const conf = OK.tauriConf.replace('dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu', '');
    expect(checkVersionSync({ ...OK, tauriConf: conf }).join(' ')).toContain('pubkey');
  });

  it('rejects a placeholder updater pubkey', () => {
    const conf = OK.tauriConf.replace('dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu', 'REPLACE_ME');
    expect(checkVersionSync({ ...OK, tauriConf: conf }).join(' ')).toContain('pubkey');
  });

  it('reports every problem at once rather than the first', () => {
    const problems = checkVersionSync({
      pkg: '{"version":"0.3.1"}',
      tauriConf: '{"version":"0.3.1","plugins":{"updater":{"pubkey":""}}}',
      cargoToml: '[package]\nversion = "9.9.9"\n',
    });
    expect(problems.length).toBe(3);
  });
});

/**
 * The dev channel ships its own installers (`dev-build.yml`) from
 * `tauri.dev.conf.json`, which carries a FULL updater block of its own rather
 * than merging over the base — so it needs its own pubkey check.
 *
 * Checking only `tauri.conf.json` is exactly how a real placeholder survived:
 * production got the key, the dev channel kept `REPLACE_ME`, `verify` went
 * green, and nothing would have stopped a dev build that can never auto-update.
 */
describe('checkVersionSync — dev channel', () => {
  const DEV_OK = '{"plugins":{"updater":{"pubkey":"dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu"}}}';

  it('accepts a dev config with a real pubkey', () => {
    expect(checkVersionSync({ ...OK, tauriDevConf: DEV_OK })).toEqual([]);
  });

  it('rejects a placeholder pubkey in the dev config', () => {
    const dev = DEV_OK.replace(/"pubkey":"[^"]*"/, '"pubkey":"REPLACE_ME"');
    expect(checkVersionSync({ ...OK, tauriDevConf: dev }).join(' '))
      .toContain('tauri.dev.conf.json');
  });

  it('rejects an empty pubkey in the dev config', () => {
    const dev = DEV_OK.replace(/"pubkey":"[^"]*"/, '"pubkey":""');
    expect(checkVersionSync({ ...OK, tauriDevConf: dev })).toHaveLength(1);
  });

  it('names WHICH file is wrong, so the fix is unambiguous', () => {
    const dev = DEV_OK.replace(/"pubkey":"[^"]*"/, '"pubkey":"TODO"');
    const conf = OK.tauriConf.replace(/"pubkey":"[^"]*"/, '"pubkey":"REPLACE_ME"');
    const problems = checkVersionSync({ ...OK, tauriConf: conf, tauriDevConf: dev });
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.startsWith('tauri.conf.json:'))).toBe(true);
    expect(problems.some((p) => p.startsWith('tauri.dev.conf.json:'))).toBe(true);
  });

  it('stays valid for callers that pass no dev config at all', () => {
    expect(checkVersionSync(OK)).toEqual([]);
  });
});

/**
 * `claude-backend.ts` reports APP_VERSION to external ACP agents in the
 * `clientInfo` handshake. It has to be a literal — the handshake is
 * synchronous and cannot await Tauri's `getVersion()` — so nothing tied it to
 * package.json and it silently sat at 0.2.2 while the app shipped 0.3.2.
 */
describe('checkVersionSync — ACP clientInfo version', () => {
  const BACKEND_OK = "const AGENT_ID = 'claude';\nconst APP_VERSION = '0.3.1';\n";

  it('accepts a backend whose APP_VERSION matches package.json', () => {
    expect(checkVersionSync({ ...OK, claudeBackend: BACKEND_OK })).toEqual([]);
  });

  it('rejects an APP_VERSION that has drifted behind package.json', () => {
    const stale = BACKEND_OK.replace("'0.3.1'", "'0.2.2'");
    expect(checkVersionSync({ ...OK, claudeBackend: stale }).join(' '))
      .toContain('claude-backend.ts APP_VERSION 0.2.2');
  });

  it('rejects a backend where the constant has been removed or renamed', () => {
    const gone = BACKEND_OK.replace('const APP_VERSION', 'const CLIENT_VERSION');
    expect(checkVersionSync({ ...OK, claudeBackend: gone }).join(' '))
      .toContain('claude-backend.ts APP_VERSION');
  });

  it('stays valid for callers that pass no backend source at all', () => {
    expect(checkVersionSync(OK)).toEqual([]);
  });
});

/**
 * A release channel that builds installers but publishes no update manifest is
 * inert, not broken: the app polls, gets a 404, logs one line to stderr and
 * goes quiet for six hours. Nothing surfaces it.
 *
 * That is precisely what the dev channel did — `tauri.dev.conf.json` named an
 * endpoint, `dev-build.yml` never wrote anything to it, and UnityIDE Dev 0.3.2
 * sat there while 0.3.3 shipped. The pubkey half of that failure was already
 * guarded here; this is the other half.
 */
describe('checkVersionSync — channel workflows publish updates', () => {
  const WORKFLOW_OK = [
    '          - os: macos-14',
    '            bundles: app,dmg',
    '            platform_key: darwin-aarch64',
    '      - name: Write the update manifest',
    '        run: |',
    '          node editor/scripts/write-update-manifest.mjs --platform "${{ matrix.platform_key }}"',
    '      - name: Upload to R2',
    '        run: |',
    '          bunx wrangler r2 object put "arcane-releases/dev/latest/${{ matrix.platform_key }}.json" --file m.json --remote --content-type application/json',
  ].join('\n');

  const wf = (source) => ({ ...OK, channelWorkflows: [{ name: 'dev-build.yml', source }] });

  it('accepts a workflow that builds, writes and uploads an update', () => {
    expect(checkVersionSync(wf(WORKFLOW_OK))).toEqual([]);
  });

  it('rejects a channel that ships installers but writes no manifest', () => {
    const source = WORKFLOW_OK.replace('node editor/scripts/write-update-manifest.mjs', 'echo skip');
    expect(checkVersionSync(wf(source)).join(' ')).toContain('dev-build.yml');
  });

  it('rejects a manifest that is written but never uploaded', () => {
    // Written to the runner and left there: the client still gets a 404.
    const source = WORKFLOW_OK.replace(/bunx wrangler.*$/m, 'bunx wrangler r2 object put "x/UnityIDE.dmg" --file d');
    expect(checkVersionSync(wf(source)).join(' ')).toContain('upload');
  });

  it('rejects a macOS bundle list of dmg alone', () => {
    // `dmg` is not an updater-enabled target. Building it alone logs "no
    // updater-enabled targets were built" and produces no .app.tar.gz — so
    // there is nothing for the manifest to point at, and the build still
    // passes.
    const source = WORKFLOW_OK.replace('bundles: app,dmg', 'bundles: dmg');
    expect(checkVersionSync(wf(source)).join(' ')).toContain('app');
  });

  it('leaves an nsis-only matrix entry alone', () => {
    // On Windows the updater artifact IS the installer; there is no second
    // bundle to add.
    const source = WORKFLOW_OK.replace('bundles: app,dmg', 'bundles: nsis');
    expect(checkVersionSync(wf(source))).toEqual([]);
  });

  it('stays valid for callers that pass no workflows at all', () => {
    expect(checkVersionSync(OK)).toEqual([]);
  });
});
