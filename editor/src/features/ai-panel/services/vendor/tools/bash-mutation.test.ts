import { describe, it, expect } from 'bun:test';
import { detectBashMutation } from './bash-mutation';

describe('detectBashMutation — read-only commands', () => {
  const readOnly = [
    'ls -la',
    'cat Assets/Foo.cs',
    'grep -rn "Update" Assets',
    'git status',
    'git diff --stat',
    'bun test src',
    'dotnet build 2>&1',
    'find . -name "*.cs"',
    'echo "rm -rf /"',
    'sed -n "1,10p" Assets/Foo.cs',
  ];
  for (const cmd of readOnly) {
    it(`treats \`${cmd}\` as read-only`, () => {
      expect(detectBashMutation(cmd)).toBeNull();
    });
  }
});

describe('detectBashMutation — mutating commands', () => {
  const mutating = [
    'echo "class A {}" > Assets/A.cs',
    'cat template.cs >> Assets/A.cs',
    'rm Assets/Old.cs',
    'rm -rf Assets/Temp',
    'mv Assets/A.cs Assets/B.cs',
    'cp Assets/A.cs Assets/B.cs',
    'mkdir -p Assets/New',
    'touch Assets/A.cs',
    'sed -i "" "s/foo/bar/" Assets/A.cs',
    'sed -i.bak "s/foo/bar/" Assets/A.cs',
    'git checkout -- Assets/A.cs',
    'git reset --hard',
    'ls && rm Assets/A.cs',
    'sudo rm Assets/A.cs',
    'tee Assets/A.cs',
  ];
  for (const cmd of mutating) {
    it(`flags \`${cmd}\``, () => {
      expect(detectBashMutation(cmd)).not.toBeNull();
    });
  }
});

describe('detectBashMutation — precision', () => {
  it('is not fooled by a mutating word inside a quoted string', () => {
    expect(detectBashMutation('grep -rn "rm -rf" Assets')).toBeNull();
  });

  it('does not count stderr redirection as a file write', () => {
    expect(detectBashMutation('bun test 2>&1')).toBeNull();
  });

  it('does not mistake a flag for the rm command', () => {
    expect(detectBashMutation('bun run build --rm-cache')).toBeNull();
  });

  it('names the reason so the note can be specific', () => {
    expect(detectBashMutation('rm Assets/A.cs')).toContain('rm');
    expect(detectBashMutation('echo x > A.cs')).toContain('redirect');
  });
});
