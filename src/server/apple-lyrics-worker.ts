import 'dotenv/config';
import { createServer } from 'node:http';
import {
  createAppleLyricsRuntime,
} from './apple-lyrics-runtime.js';
import { appleLyricsWorkerHealthPayload } from './apple-lyrics-worker-health.js';
import { productionObservability } from './production-observability.js';
import {
  config,
  validateProductionConfig,
  validateProductionProcessGroup,
} from './config.js';

const missingConfig = [
  ...validateProductionConfig(),
  ...validateProductionProcessGroup('apple_worker', { required: true }),
];
if (missingConfig.length > 0) {
  throw new Error(`Missing production configuration: ${missingConfig.join(', ')}`);
}
if (config.appleLyrics.runnerMode !== 'external') {
  throw new Error('The standalone Apple lyrics worker requires external runner mode');
}
productionObservability.setEnabled(config.isProduction);

let restartScheduled = false;
const runtime = createAppleLyricsRuntime({
  onWedged(error) {
    if (restartScheduled) return;
    restartScheduled = true;
    console.error(
      'Apple lyrics worker watchdog is restarting the worker process:',
      error.name,
    );
    setImmediate(() => process.exit(1));
  },
});
let runtimeStarted = false;

const server = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/healthz') {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  const stats = runtime.stats();
  const body = appleLyricsWorkerHealthPayload(stats, {
    started: runtimeStarted,
    revision: config.revision,
    processGroup: config.processGroup,
  });
  response.writeHead(body.live ? 200 : 503, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
  });
  response.end(JSON.stringify(body));
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(config.appleLyrics.healthPort, '0.0.0.0', resolve);
});
runtime.start();
runtimeStarted = true;

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  runtimeStarted = false;
  shutdownPromise = (async () => {
    await runtime.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  })();
  return shutdownPromise;
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
