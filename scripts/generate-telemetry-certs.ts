import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const hostname = process.argv.find((argument) => !argument.startsWith('-') && argument !== process.argv[0] && argument !== process.argv[1]);
if (!hostname) throw new Error('Usage: npm run tesla:certgen -- telemetry.example.com');
if (!/^[a-z0-9.-]+$/i.test(hostname)) throw new Error('Telemetry hostname is invalid');

const outputDir = path.resolve(process.cwd(), 'secrets');
const caKey = path.join(outputDir, 'telemetry-ca-key.pem');
const caCert = path.join(outputDir, 'telemetry-ca.pem');
const telemetryKey = path.join(outputDir, 'telemetry-server-key.pem');
const telemetryCert = path.join(outputDir, 'telemetry-server-cert.pem');
const proxyKey = path.join(outputDir, 'proxy-server-key.pem');
const proxyCert = path.join(outputDir, 'proxy-server-cert.pem');
const force = process.argv.includes('--force');

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

if (
  !force &&
  (await Promise.all([caKey, caCert, telemetryKey, telemetryCert, proxyKey, proxyCert].map(exists))).some(Boolean)
) {
  throw new Error('Certificate files already exist. Replacing the CA requires reconfiguring the vehicle; pass --force only if intentional.');
}

async function createLeaf(name: string, key: string, cert: string, sans: string[]): Promise<void> {
  const csr = path.join(outputDir, `${name}.csr`);
  const extension = path.join(outputDir, `${name}.cnf`);
  await writeFile(
    extension,
    `[v3_req]\nsubjectAltName=${sans.join(',')}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyAgreement\n`,
  );
  await run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
  await run('openssl', ['req', '-new', '-key', key, '-out', csr, '-subj', `/CN=${name}`]);
  await run('openssl', [
    'x509', '-req', '-in', csr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial',
    '-out', cert, '-days', '825', '-sha256', '-extfile', extension, '-extensions', 'v3_req',
  ]);
  await rm(csr, { force: true });
  await rm(extension, { force: true });
}

await mkdir(outputDir, { recursive: true });
await run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', caKey]);
await run('openssl', [
  'req', '-x509', '-new', '-sha256', '-key', caKey, '-out', caCert, '-days', '3650',
  '-subj', '/CN=Lyrla Personal Telemetry CA',
]);
await createLeaf(hostname, telemetryKey, telemetryCert, [`DNS:${hostname}`]);
await createLeaf('localhost', proxyKey, proxyCert, ['DNS:localhost', 'IP:127.0.0.1']);
await rm(path.join(outputDir, 'telemetry-ca.srl'), { force: true });
console.log(`Generated a private CA plus telemetry/proxy server certificates in ${outputDir}`);
console.log('Validate the telemetry certificate with Tesla check_server_cert.sh before configuring the car.');
