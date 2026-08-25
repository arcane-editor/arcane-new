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
