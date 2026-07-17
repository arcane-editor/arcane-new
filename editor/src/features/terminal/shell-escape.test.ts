import { describe, expect, it } from 'bun:test';
import { escapePathForShell } from './shell-escape';

describe('escapePathForShell (posix)', () => {
  it('quotes a plain path', () => {
    expect(escapePathForShell('/tmp/a.png', 'posix')).toBe("'/tmp/a.png'");
  });

  it('quotes paths containing spaces', () => {
    expect(escapePathForShell('/Users/me/My Screenshots/a.png', 'posix')).toBe(
      "'/Users/me/My Screenshots/a.png'"
    );
  });

  // The one character a single-quoted string cannot contain. Without the
  // close/escape/reopen dance the quoting breaks out and the rest of the
  // filename is read by the shell as syntax.
  it('escapes embedded single quotes so they cannot break out', () => {
    expect(escapePathForShell("/tmp/it's here.png", 'posix')).toBe(
      `'/tmp/it'\\''s here.png'`
    );
  });

  // These are the reason this function exists: a dropped file is input the
  // user never typed, going straight into a live shell.
  it('neutralises shell metacharacters', () => {
    const cases: Array<[string, string]> = [
      ['/tmp/$(rm -rf ~).png', "'/tmp/$(rm -rf ~).png'"],
      ['/tmp/`whoami`.png', "'/tmp/`whoami`.png'"],
      ['/tmp/a;rm -rf b.png', "'/tmp/a;rm -rf b.png'"],
      ['/tmp/a && b.png', "'/tmp/a && b.png'"],
      ['/tmp/$HOME.png', "'/tmp/$HOME.png'"],
      ['/tmp/a\nb.png', "'/tmp/a\nb.png'"],
    ];
    for (const [input, expected] of cases) {
      expect(escapePathForShell(input, 'posix')).toBe(expected);
    }
  });

  // Belt and braces: whatever the input, the result must be a single-quoted
  // string whose only bare quotes are the escape sequence itself.
  it('always produces a balanced single-quoted string', () => {
    for (const p of ["a'b", "'", "''", 'a', '', "a'''b"]) {
      const out = escapePathForShell(p, 'posix');
      expect(out.startsWith("'")).toBe(true);
      expect(out.endsWith("'")).toBe(true);
      // Round-trip through the same rule a shell applies: strip the outer
      // quotes, turn every '\'' back into a quote, and we should be back where
      // we started.
      const unquoted = out.slice(1, -1).split(`'\\''`).join("'");
      expect(unquoted).toBe(p);
    }
  });
});

describe('escapePathForShell (win32)', () => {
  it('double-quotes and doubles embedded quotes', () => {
    expect(escapePathForShell('C:\\Users\\me\\a b.png', 'win32')).toBe(
      '"C:\\Users\\me\\a b.png"'
    );
    expect(escapePathForShell('C:\\a"b.png', 'win32')).toBe('"C:\\a""b.png"');
  });
});
