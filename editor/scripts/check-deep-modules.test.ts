// `checkImportsIn` is pure (SRC-root-relative posix paths + text in,
// violations out — no real filesystem), so the deep-module barrel rule and
// its test-file allowlist are both exercised here with fixtures rather than
// a real `src/` tree.

import { describe, it, expect } from 'bun:test';
import {
  checkImportsIn,
  resolveSpecifier,
  isTestFile,
  TEST_DEEP_IMPORT_ALLOWLIST,
} from './check-deep-modules.mjs';

describe('resolveSpecifier', () => {
  it('resolves a relative import against the importing file', () => {
    expect(
      resolveSpecifier(
        'features/ai-panel/services/unity-tools/ui-templates/ui-templates.test.ts',
        '../../../../uitoolkit/services/render-plan',
      ),
    ).toBe('features/uitoolkit/services/render-plan');
  });

  it('returns null for a bare (non-relative) specifier — not this checker\'s concern', () => {
    expect(resolveSpecifier('features/foo/bar.ts', 'react')).toBeNull();
  });

  it('resolves a barrel import to the feature\'s index', () => {
    expect(resolveSpecifier('features/ai-panel/services/foo.ts', '../../acp/index')).toBe(
      'features/acp/index',
    );
  });
});

describe('checkImportsIn — production code', () => {
  it('flags a production file that deep-imports another feature\'s internal module', () => {
    const files = [
      {
        file: 'features/ai-panel/services/foo.ts',
        text: `import { bar } from '../../other-feature/services/internal';\n`,
      },
    ];
    const violations = checkImportsIn(files);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('features/other-feature/index.ts');
  });

  it('allows an import through the target feature\'s barrel', () => {
    const files = [
      {
        file: 'features/ai-panel/services/foo.ts',
        text: `import { bar } from '../../other-feature';\n`,
      },
    ];
    expect(checkImportsIn(files)).toEqual([]);
  });

  it('allows an import within the same feature', () => {
    const files = [
      {
        file: 'features/ai-panel/services/foo.ts',
        text: `import { bar } from './internal';\n`,
      },
    ];
    expect(checkImportsIn(files)).toEqual([]);
  });

  it('is not fooled by a test file\'s own deep import — production stays production', () => {
    // Sanity: a PRODUCTION file with the exact same import as the allowlisted
    // test entry is still flagged. The allowlist is keyed on the importer
    // file, not merely on the target module.
    const files = [
      {
        file: 'features/ai-panel/services/unity-tools/ui-templates/not-a-test.ts',
        text: `import { buildRenderPlanFromText } from '../../../../uitoolkit/services/render-plan';\n`,
      },
    ];
    const violations = checkImportsIn(files);
    expect(violations).toHaveLength(1);
  });
});

describe('checkImportsIn — test-file allowlist is narrow, not blanket (F2 regression)', () => {
  it('allows the one entry actually on TEST_DEEP_IMPORT_ALLOWLIST, using the real file\'s own import line', () => {
    expect(TEST_DEEP_IMPORT_ALLOWLIST).toHaveLength(1);
    const entry = TEST_DEEP_IMPORT_ALLOWLIST[0];
    expect(isTestFile(entry.importer)).toBe(true);

    // The exact specifier `ui-templates.test.ts` actually writes (4 `../` to
    // climb from `unity-tools/ui-templates/` to `features/`, then into
    // `uitoolkit/services/render-plan`) — asserted against the real target
    // first, so this test breaks loudly if the file ever moves.
    const specifier = '../../../../uitoolkit/services/render-plan';
    expect(resolveSpecifier(entry.importer, specifier)).toBe(entry.target);

    const files = [{ file: entry.importer, text: `import { buildRenderPlanFromText } from '${specifier}';\n` }];
    expect(checkImportsIn(files)).toEqual([]);
  });

  it('still flags a DIFFERENT deep import from a test file that is not on the allowlist', () => {
    const files = [
      {
        file: 'features/ai-panel/services/unity-tools/ui-templates/ui-templates.test.ts',
        // Same importer as the real allowlist entry, but a DIFFERENT target —
        // proves the allowlist matches the (importer, target) pair, not just
        // "this test file may deep-import anything".
        text: `import { something } from '../../../../uitoolkit/services/usage-index';\n`,
      },
    ];
    const violations = checkImportsIn(files);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('features/uitoolkit/index.ts');
  });

  it('still flags a deep import from a DIFFERENT, non-allowlisted test file', () => {
    const files = [
      {
        file: 'features/ai-panel/services/some-other.test.ts',
        text: `import { buildRenderPlanFromText } from '../../uitoolkit/services/render-plan';\n`,
      },
    ];
    const violations = checkImportsIn(files);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('src/features/ai-panel/services/some-other.test.ts');
  });
});
