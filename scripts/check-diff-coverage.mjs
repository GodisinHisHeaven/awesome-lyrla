import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { changedFiles, changedLineNumbers, resolveQualityBase } from './quality/git-changes.mjs';

const argv = process.argv.slice(2);
const minimumIndex = argv.indexOf('--minimum');
const minimum = Number(minimumIndex >= 0 ? argv[minimumIndex + 1] : 90);
if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
  throw new Error('--minimum must be a percentage between 0 and 100');
}

const base = resolveQualityBase(argv);
if (!base) throw new Error('Unable to resolve a base commit for diff coverage');

const lcov = await readFile('coverage/lcov.info', 'utf8');
const coverage = new Map();
let currentFile = null;
for (const record of lcov.split('\n')) {
  if (record.startsWith('SF:')) {
    const source = record.slice(3);
    currentFile = (
      path.isAbsolute(source) ? path.relative(process.cwd(), source) : source
    ).replaceAll(path.sep, '/');
    coverage.set(currentFile, new Map());
  } else if (record.startsWith('DA:') && currentFile) {
    const [line, hits] = record.slice(3).split(',').map(Number);
    coverage.get(currentFile).set(line, hits);
  } else if (record === 'end_of_record') {
    currentFile = null;
  }
}

const sourceFiles = changedFiles(base).filter(
  (file) =>
    /^src\/.*\.(?:ts|tsx)$/.test(file) &&
    !/\.test\.(?:ts|tsx)$/.test(file) &&
    !file.startsWith('src/test/'),
);

let coverable = 0;
let covered = 0;
const misses = [];
for (const file of sourceFiles) {
  const fileCoverage = coverage.get(file);
  if (!fileCoverage) {
    throw new Error(`Coverage report is missing changed source file: ${file}`);
  }
  const changed = changedLineNumbers(file, base);
  for (const line of changed) {
    if (!fileCoverage.has(line)) continue;
    coverable += 1;
    if (fileCoverage.get(line) > 0) covered += 1;
    else misses.push(`${file}:${line}`);
  }
}

if (coverable === 0) {
  console.log('Diff coverage passed: no changed executable source lines.');
  process.exit(0);
}

const percent = (covered / coverable) * 100;
console.log(`Diff coverage: ${covered}/${coverable} (${percent.toFixed(2)}%), minimum ${minimum}%`);
if (percent + Number.EPSILON < minimum) {
  console.error('Changed executable lines without coverage:');
  for (const miss of misses.slice(0, 80)) console.error(`- ${miss}`);
  if (misses.length > 80) console.error(`- ...and ${misses.length - 80} more`);
  process.exitCode = 1;
}
