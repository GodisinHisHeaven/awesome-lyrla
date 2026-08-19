import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const checkOnly = process.argv.includes('--check-only');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture
      ? (result.stderr || result.stdout || '').trim()
      : '';
    throw new Error(
      `${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`,
    );
  }
  return options.capture ? result.stdout.trim() : '';
}

function assertReleaseCommit() {
  const branch = run('git', ['branch', '--show-current'], { capture: true });
  if (branch !== 'main') throw new Error('Production deploys must run from main');
  if (run('git', ['status', '--porcelain'], { capture: true })) {
    throw new Error('Production deploys require a clean worktree');
  }
  run('git', ['fetch', 'origin', 'main']);
  const head = run('git', ['rev-parse', 'HEAD'], { capture: true });
  const remote = run('git', ['rev-parse', 'origin/main'], { capture: true });
  if (head !== remote) {
    throw new Error('main must exactly match origin/main before deployment');
  }
  return head;
}

function assertMigrations() {
  const names = readdirSync('supabase/migrations')
    .filter((name) => name.endsWith('.sql'));
  const timestamps = new Set();
  for (const name of names) {
    const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match) throw new Error(`Invalid migration filename: ${name}`);
    if (timestamps.has(match[1])) {
      throw new Error(`Duplicate migration timestamp: ${match[1]}`);
    }
    timestamps.add(match[1]);
  }
}

if (!existsSync('fly.toml')) {
  throw new Error('Copy fly.toml.example to fly.toml and configure your Fly app first');
}

const revision = assertReleaseCommit();
assertMigrations();
run('npm', ['ci']);
run('npm', ['run', 'typecheck']);
run('npm', ['test']);
run('npm', ['run', 'build']);
run('flyctl', ['config', 'validate', '--strict', '--config', 'fly.toml']);

if (checkOnly) {
  console.log(`Release checks passed for ${revision}`);
} else {
  run('flyctl', [
    'deploy',
    '--config',
    'fly.toml',
    '--build-arg',
    `APP_REVISION=${revision}`,
  ]);
}
