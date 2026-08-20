import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { changedFiles, resolveQualityBase } from './quality/git-changes.mjs';

const mutationReady = new Set([
  'src/server/apple-lyrics-timeline.ts',
  'src/server/bounded-lru.ts',
  'src/shared/lrc.ts',
  'src/shared/track.ts',
]);
const argv = process.argv.slice(2);
const base = resolveQualityBase(argv);
const touched = changedFiles(base).filter((file) => mutationReady.has(file));
const forced = process.env.QUALITY_FORCE_MUTATION === '1' || argv.includes('--force');
const targetIndex = argv.indexOf('--target');
const requestedTarget = targetIndex >= 0 ? argv[targetIndex + 1] : null;
if (requestedTarget && !mutationReady.has(requestedTarget)) {
  throw new Error(`Unsupported mutation target: ${requestedTarget}`);
}

if (!requestedTarget && !forced && touched.length === 0) {
  console.log('Critical mutation gate skipped: no mutation-ready policy changed.');
  process.exit(0);
}

const targets = requestedTarget ? [requestedTarget] : forced ? [...mutationReady] : touched;
console.log(`Critical mutation gate targets: ${targets.join(', ')}`);
const cli = path.resolve('node_modules/@stryker-mutator/core/bin/stryker.js');
const result = spawnSync(process.execPath, [cli, 'run', '--mutate', targets.join(',')], {
  cwd: process.cwd(),
  encoding: 'utf8',
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
