import { execFileSync } from 'node:child_process';

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usableCommit(candidate) {
  if (!candidate || /^0+$/.test(candidate)) return false;
  return Boolean(
    git(['rev-parse', '--verify', `${candidate}^{commit}`], {
      allowFailure: true,
      quiet: true,
    }),
  );
}

export function resolveQualityBase(argv = process.argv.slice(2)) {
  const requested = argumentValue(argv, '--base') ?? process.env.QUALITY_BASE_SHA;
  const candidates = [requested, 'origin/main', 'HEAD^'];
  return candidates.find(usableCommit) ?? null;
}

function addLines(target, output) {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) target.add(trimmed);
  }
}

export function changedFiles(base = resolveQualityBase()) {
  const files = new Set();
  if (base) {
    addLines(
      files,
      git(['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`], { allowFailure: true }),
    );
  }
  addLines(files, git(['diff', '--name-only', '--diff-filter=ACMR']));
  addLines(files, git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']));
  addLines(files, git(['ls-files', '--others', '--exclude-standard']));
  return [...files].sort();
}

export function changedLineNumbers(file, base = resolveQualityBase()) {
  if (!base) return new Set();
  const comparisonBase =
    git(['merge-base', base, 'HEAD'], { allowFailure: true, quiet: true }) || base;
  const patch = git(
    ['diff', '--unified=0', '--no-color', '--diff-filter=ACMR', comparisonBase, '--', file],
    { allowFailure: true },
  );
  const lines = new Set();
  for (const line of patch.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let lineNumber = start; lineNumber < start + count; lineNumber += 1) {
      lines.add(lineNumber);
    }
  }
  return lines;
}
