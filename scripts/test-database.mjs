import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('node_modules/.bin/supabase');
const projectId = readFileSync('supabase/config.toml', 'utf8').match(
  /^project_id\s*=\s*"([^"]+)"/m,
)?.[1];
if (!projectId) throw new Error('supabase/config.toml is missing project_id');
const databaseContainer = `supabase_db_${projectId}`;
const excludedServices = [
  'gotrue',
  'realtime',
  'storage-api',
  'imgproxy',
  'kong',
  'mailpit',
  'postgrest',
  'postgres-meta',
  'studio',
  'edge-runtime',
  'logflare',
  'vector',
  'supavisor',
].join(',');

function run(args, options = {}) {
  const result = spawnSync(cli, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(`supabase ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function runSqlTest(file) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      databaseContainer,
      'psql',
      '--username',
      'postgres',
      '--dbname',
      'postgres',
      '--set',
      'ON_ERROR_STOP=1',
      '--file',
      '-',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: readFileSync(file, 'utf8'),
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  );
  if (result.status !== 0) throw new Error(`Database contract failed: ${file}`);
}

const existing = run(['status', '--output', 'json'], {
  allowFailure: true,
  capture: true,
});
const startedHere = existing.status !== 0;

try {
  if (startedHere) run(['start', '--exclude', excludedServices]);
  console.log('Resetting the isolated local database and replaying every migration...');
  run(['db', 'reset', '--local', '--no-seed']);

  const tests = readdirSync('supabase/tests')
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (tests.length === 0) throw new Error('No Supabase SQL tests were found');

  for (const test of tests) {
    const file = path.join('supabase', 'tests', test);
    console.log(`Running ${file}`);
    runSqlTest(file);
  }
  console.log(`Supabase database gate passed (${tests.length} SQL test files).`);
} finally {
  if (startedHere && process.env.SUPABASE_DB_TEST_KEEP !== '1') {
    run(['stop', '--no-backup'], { allowFailure: true });
  }
}
