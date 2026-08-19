import { generateKeyPairSync } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outputDir = path.resolve(process.cwd(), 'secrets');
const privatePath = path.join(outputDir, 'tesla-private-key.pem');
const publicPath = path.join(outputDir, 'tesla-public-key.pem');
const force = process.argv.includes('--force');

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

if (!force && ((await exists(privatePath)) || (await exists(publicPath)))) {
  throw new Error('Tesla key files already exist. Pass --force only if you intend to re-pair the vehicle.');
}

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'sec1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

await mkdir(outputDir, { recursive: true });
await writeFile(privatePath, privateKey, { mode: 0o600 });
await writeFile(publicPath, publicKey, { mode: 0o644 });
console.log(`Private key: ${privatePath}`);
console.log(`Public key:  ${publicPath}`);
console.log('Keep the private key secret. The public key is served by the app at the Tesla well-known URL.');
