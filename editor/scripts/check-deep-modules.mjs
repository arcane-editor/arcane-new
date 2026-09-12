/**
 * Deep-module boundary check (Global Constraint 3, `editor/CLAUDE.md`):
 * every feature is imported only through its `index.ts` barrel.
 *
 * The checking itself (`checkImportsIn`) is pure — it takes source text, not
 * paths on disk — so it is unit-testable without a fixture tree
 * (`check-deep-modules.test.ts`), the same split `version-sync.mjs` /
 * `check-invoke-args.mjs` use next to it. `main()` is the thin runner that
 * walks the real `src/` tree.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve('src');
const FEATURES_ROOT = path.join(SRC_ROOT, 'features');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (stat.isFile() && SOURCE_EXTENSIONS.has(path.extname(full))) {
      files.push(full);
    }
  }
  return files;
}

/** @param {string} relPosixPath SRC-root-relative, posix-separated (e.g. `features/uitoolkit/index.ts`). */
function featureNameFor(relPosixPath) {
  const parts = relPosixPath.split('/');
  return parts[0] === 'features' && parts[1] ? parts[1] : null;
}

function lineForIndex(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** @param {string} targetRelPosixPath extensionless, SRC-root-relative, posix-separated. */
function isPublicFeatureEntry(targetRelPosixPath, targetFeature) {
  return (
    targetRelPosixPath === `features/${targetFeature}` ||
    targetRelPosixPath === `features/${targetFeature}/index`
  );
}

export function checkFeatureIndexes() {
  if (!existsSync(FEATURES_ROOT)) return [];
  const violations = [];
  for (const entry of readdirSync(FEATURES_ROOT)) {
    const featureDir = path.join(FEATURES_ROOT, entry);
    if (!statSync(featureDir).isDirectory()) continue;
    const indexPath = path.join(featureDir, 'index.ts');
    if (!existsSync(indexPath)) {
      violations.push({
        file: toPosix(path.relative(process.cwd(), featureDir)),
        line: 1,
        specifier: '',
        message: 'Feature folders must expose a public API via index.ts',
      });
    }
  }
  return violations;
}

export function extractImportSpecifiers(text) {
  const results = [];
  const patterns = [
    /(^|\n)\s*import\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /(^|\n)\s*export\s+(?:type\s+)?[^'";]*?\s+from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[2] ?? match[1];
      if (specifier) results.push({ specifier, index: match.index ?? 0 });
    }
  }
  return results;
}

/** `*.test.ts(x)` only — never a production file, however it is named. */
export function isTestFile(relPosixPath) {
  return /\.test\.tsx?$/.test(relPosixPath);
}

/**
 * Deep imports a TEST FILE is allowed to make straight past a feature's
 * barrel — an explicit `{ importer, target }` allowlist, each entry
 * individually justified, not a blanket "every test is exempt" rule.
 *
 * Review round 1 (F2) found the first cut of this check exempted every
 * `*.test.ts(x)` file from the barrel rule codebase-wide, when only ONE test
 * — `ui-templates.test.ts` reaching `uitoolkit/services/render-plan.ts` —
 * actually needed it. A blanket exemption hides every FUTURE unjustified
 * deep import a test happens to make, not just this one; an allowlist keeps
 * the check meaningful for anything not explicitly reasoned about here.
 * `check-deep-modules.test.ts` proves a non-allowlisted test deep import is
 * still flagged.
 *
 * `importer`/`target` are SRC-root-relative, posix-separated, extensionless
 * — the shape `resolveSpecifier` produces.
 */
export const TEST_DEEP_IMPORT_ALLOWLIST = [
  {
    importer: 'features/ai-panel/services/unity-tools/ui-templates/ui-templates.test.ts',
    target: 'features/uitoolkit/services/render-plan',
    reason:
      "features/uitoolkit's barrel (index.ts) statically imports React components " +
      "(UnityUiPanel, UxmlPreviewEditor) that reach stores/theme.ts's module-scope " +
      '`document` access, so the barrel cannot be imported under Bun at all — ' +
      'production code reaches this feature only through a dynamic import() seam ' +
      'inside execute() (see ui-toolkit-tool.ts / ui-layout-tool.ts), which a ' +
      'static test import has no way to use. render-plan.ts itself is pure and ' +
      'DOM-free, so the test reaches it directly instead of through the barrel.',
  },
];

function isAllowlistedTestImport(importerRelPosix, targetRelPosix) {
  return TEST_DEEP_IMPORT_ALLOWLIST.some(
    (entry) => entry.importer === importerRelPosix && entry.target === targetRelPosix,
  );
}

/**
 * Resolve a relative import specifier against the importing file, both given
 * as SRC-root-relative posix paths — pure string math (`path.posix`), no
 * filesystem access, so it works identically for a real file or a fixture.
 * `null` for a bare (non-relative) specifier, which this checker does not
 * police.
 */
export function resolveSpecifier(importerRelPosix, specifier) {
  if (!specifier.startsWith('.')) return null;
  const dir = path.posix.dirname(`/${importerRelPosix}`);
  const resolved = path.posix.normalize(path.posix.join(dir, specifier));
  return resolved.replace(/^\/+/, '');
}

/**
 * Pure: given every source file as `{ file, text }` (SRC-root-relative posix
 * path + full text), find every cross-feature import that does not go
 * through the target feature's `index.ts` barrel — except a deep import a
 * TEST file makes that is explicitly named in `TEST_DEEP_IMPORT_ALLOWLIST`.
 */
export function checkImportsIn(files) {
  const violations = [];
  for (const { file, text } of files) {
    const importerFeature = featureNameFor(file);

    for (const { specifier, index } of extractImportSpecifiers(text)) {
      const targetRelPosix = resolveSpecifier(file, specifier);
      if (targetRelPosix === null) continue;

      const targetFeature = featureNameFor(targetRelPosix);
      if (!targetFeature) continue;
      if (importerFeature === targetFeature) continue;
      if (isPublicFeatureEntry(targetRelPosix, targetFeature)) continue;
      if (isTestFile(file) && isAllowlistedTestImport(file, targetRelPosix)) continue;

      violations.push({
        file: `src/${file}`,
        line: lineForIndex(text, index),
        specifier,
        message: `Feature '${targetFeature}' must be imported through src/features/${targetFeature}/index.ts`,
      });
    }
  }
  return violations;
}

function main() {
  const files = walk(SRC_ROOT).map((absPath) => ({
    file: toPosix(path.relative(SRC_ROOT, absPath)),
    text: readFileSync(absPath, 'utf8'),
  }));

  const violations = [...checkFeatureIndexes(), ...checkImportsIn(files)];

  if (violations.length > 0) {
    console.error('Deep module boundary violations found:\n');
    for (const violation of violations) {
      const location = `${violation.file}:${violation.line}`;
      const specifier = violation.specifier ? ` (${violation.specifier})` : '';
      console.error(`- ${location}${specifier}\n  ${violation.message}`);
    }
    process.exit(1);
  }

  console.log('Deep module boundaries OK');
}

if (import.meta.main) main();
