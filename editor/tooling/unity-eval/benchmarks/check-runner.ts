/** bun tooling/unity-eval/benchmarks/check-runner.ts report1.json report2.json report3.json */
import { readFile } from 'node:fs/promises';
import { checkRunnerBenchmark, type RunnerGenerationEvidence } from './endless-runner';
const paths = process.argv.slice(2);
if (paths.length !== 3) throw new Error('Provide three independently collected fresh-generation evidence JSON files. Missing runs do not pass.');
const reports = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as RunnerGenerationEvidence));
const result = checkRunnerBenchmark(reports);
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
