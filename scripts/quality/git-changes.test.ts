import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helperPath = fileURLToPath(new URL('./git-changes.mjs', import.meta.url));

function git(repository: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writePolicy(repository: string, mainOnly: boolean, featureOnly: boolean) {
  writeFileSync(
    join(repository, 'policy.ts'),
    [
      `export const mainOnly = ${mainOnly};`,
      'export const stable = true;',
      `export const featureOnly = ${featureOnly};`,
      '',
    ].join('\n'),
  );
}

describe('changedLineNumbers', () => {
  it('diffs from the merge base when the target branch has advanced', () => {
    const repository = mkdtempSync(join(tmpdir(), 'awesome-lyrla-git-changes-'));

    try {
      git(repository, ['init', '--initial-branch=main']);
      git(repository, ['config', 'user.name', 'Quality Test']);
      git(repository, ['config', 'user.email', 'quality@example.invalid']);

      writePolicy(repository, false, false);
      git(repository, ['add', 'policy.ts']);
      git(repository, ['commit', '-m', 'base']);

      git(repository, ['switch', '-c', 'feature']);
      writePolicy(repository, false, true);
      git(repository, ['add', 'policy.ts']);
      git(repository, ['commit', '-m', 'feature change']);

      git(repository, ['switch', 'main']);
      writePolicy(repository, true, false);
      git(repository, ['add', 'policy.ts']);
      git(repository, ['commit', '-m', 'unrelated main change']);
      const mainTip = git(repository, ['rev-parse', 'HEAD']);

      git(repository, ['switch', 'feature']);
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { pathToFileURL } from 'node:url';
const helper = await import(pathToFileURL(process.argv[1]).href);
process.stdout.write(JSON.stringify([...helper.changedLineNumbers('policy.ts', process.argv[2])]));`,
          helperPath,
          mainTip,
        ],
        { cwd: repository, encoding: 'utf8' },
      );

      expect(JSON.parse(output)).toEqual([3]);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
