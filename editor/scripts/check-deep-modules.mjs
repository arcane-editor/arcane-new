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

function featureNameFor(absPath) {
  const rel = path.relative(SRC_ROOT, absPath);
  const parts = rel.split(path.sep);
  return parts[0] === 'features' && parts[1] ? parts[1] : null;
}

function lineForIndex(text, index) {
  return text.slice(0, index).split('\n').length;
}

function isPublicFeatureEntry(targetAbsPath, targetFeature) {
  const rel = toPosix(path.relative(SRC_ROOT, targetAbsPath));
  return rel === `features/${targetFeature}` || rel === `features/${targetFeature}/index`;
}

function checkFeatureIndexes() {
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

function extractImportSpecifiers(text) {
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
function isTestFile(absPath) {
  return /\.test\.tsx?$/.test(absPath);
}

function checkImports() {
  const violations = [];
  for (const file of walk(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    const importerFeature = featureNameFor(file);
    // Tests are exempt from the barrel-only rule: a test asserting against a
    // pure leaf module (e.g. `features/uitoolkit/services/render-plan.ts`)
    // needs to reach it directly, because importing the OTHER feature's
    // barrel would pull in that feature's React components / DOM-touching
    // code and break under Bun's DOM-less test runtime (Global Constraint 4)
    // — the exact problem the barrel-only rule does not have for production
    // code, which reaches the same modules through an injected-deps seam
    // instead. Production files still cross features only through index.ts.
    if (isTestFile(file)) continue;

    for (const { specifier, index } of extractImportSpecifiers(text)) {
      if (!specifier.startsWith('.')) continue;

      const targetAbsPath = path.normalize(path.resolve(path.dirname(file), specifier));
      const targetFeature = featureNameFor(targetAbsPath);
      if (!targetFeature) continue;
      if (importerFeature === targetFeature) continue;
      if (isPublicFeatureEntry(targetAbsPath, targetFeature)) continue;

      violations.push({
        file: toPosix(path.relative(process.cwd(), file)),
        line: lineForIndex(text, index),
        specifier,
        message: `Feature '${targetFeature}' must be imported through src/features/${targetFeature}/index.ts`,
      });
    }
  }
  return violations;
}

const violations = [...checkFeatureIndexes(), ...checkImports()];

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
