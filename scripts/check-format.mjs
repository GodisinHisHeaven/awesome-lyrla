import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prettier from 'prettier';
import { changedFiles, resolveQualityBase } from './quality/git-changes.mjs';

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const base = resolveQualityBase(argv);
const supported = /(?:\.(?:cjs|css|html|js|json|jsx|md|mjs|ts|tsx|yaml|yml))$/i;
const candidates = changedFiles(base).filter((file) => supported.test(file));
const failed = [];

for (const file of candidates) {
  const info = await prettier.getFileInfo(file, { ignorePath: '.prettierignore' });
  if (info.ignored || !info.inferredParser) continue;
  const source = await readFile(file, 'utf8');
  const options = {
    ...(await prettier.resolveConfig(file)),
    filepath: path.resolve(file),
  };
  const formatted = await prettier.format(source, options);
  if (formatted === source) continue;
  if (write) {
    await writeFile(file, formatted);
    console.log(`Formatted ${file}`);
  } else {
    failed.push(file);
  }
}

if (failed.length > 0) {
  console.error('Changed files are not formatted:');
  for (const file of failed) console.error(`- ${file}`);
  console.error('Run npm run format:changed and review the result.');
  process.exitCode = 1;
} else {
  console.log(`Formatting gate passed for ${candidates.length} changed candidate(s).`);
}
