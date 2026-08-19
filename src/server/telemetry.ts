import { createServer, type Server as TcpServer } from 'node:net';
import { Aedes, type AedesPublishPacket, type Client } from 'aedes';
import { config } from './config.js';
import type { PlayerCoordinator } from './player.js';
import { productionObservability, type ProductionObservability } from './production-observability.js';

type TelemetryPlayer = Pick<PlayerCoordinator, 'ingest' | 'setConnection'>;
type TelemetryTarget = TelemetryPlayer & Pick<PlayerCoordinator, 'selectedVin'>;

function safeJson(payload: Buffer | string, onInvalid?: () => void): unknown {
  const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
  try {
    return JSON.parse(raw);
  } catch {
    onInvalid?.();
    return raw;
  }
}

function exactTopicSuffix(topic: string, topicBase: string): string[] | null {
  const segments = topic.split('/');
  const baseSegments = topicBase.split('/');
  if (
    segments.some((segment) => !segment || segment.trim() !== segment)
    || baseSegments.some((segment) => !segment || segment.trim() !== segment)
    || segments.length < baseSegments.length
    || !baseSegments.every((segment, index) => segments[index] === segment)
  ) return null;
  return segments.slice(baseSegments.length);
}

export function parseMetricTopic(
  topic: string,
  topicBase = config.telemetry.mqttTopicBase,
): { vin: string; field: string } | null {
  const suffix = exactTopicSuffix(topic, topicBase);
  if (!suffix || suffix.length !== 3) return null;
  const [vin, marker, field] = suffix;
  if (!['v', 'metrics', 'vehicle'].includes(marker)) return null;
  return { vin, field };
}

export function parseConnectivityTopic(
  topic: string,
  topicBase = config.telemetry.mqttTopicBase,
): { vin: string } | null {
  const suffix = exactTopicSuffix(topic, topicBase);
  if (!suffix || suffix.length !== 2 || suffix[1] !== 'connectivity') return null;
  return { vin: suffix[0] };
}

export function telemetryIsConnected(status: unknown): boolean {
  return String(status ?? '').trim().toLowerCase() === 'connected';
}

function resolveTelemetryPlayer(
  target: TelemetryTarget,
  vin: string,
): { vin: string; player: TelemetryPlayer } | undefined {
  const selectedVin = target.selectedVin();
  if (!selectedVin || selectedVin.trim().toUpperCase() !== vin.toUpperCase()) {
    return undefined;
  }
  return { vin: selectedVin, player: target };
}

export function routeTelemetryMessage(
  target: TelemetryTarget,
  topic: string,
  payload: Buffer | string,
  topicBase = config.telemetry.mqttTopicBase,
  observability: ProductionObservability = productionObservability,
): boolean {
  const metric = parseMetricTopic(topic, topicBase);
  if (metric) {
    const route = resolveTelemetryPlayer(target, metric.vin);
    if (!route) {
      observability.observeTelemetryMessage('unrouted', metric.field);
      return false;
    }
    route.player.ingest(
      route.vin,
      metric.field,
      safeJson(payload, () => observability.observeTelemetryInvalidPayload()),
    );
    observability.observeTelemetryMessage('routed', metric.field);
    return true;
  }

  const connectivity = parseConnectivityTopic(topic, topicBase);
  if (!connectivity) {
    observability.observeTelemetryMessage('unknown-topic');
    return false;
  }
  const route = resolveTelemetryPlayer(target, connectivity.vin);
  if (!route) {
    observability.observeTelemetryMessage('unrouted', 'connectivity');
    return false;
  }
  const decoded = safeJson(payload, () => observability.observeTelemetryInvalidPayload());
  const status = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? (decoded as { Status?: unknown }).Status
    : decoded;
  const connected = telemetryIsConnected(status);
  route.player.setConnection(connected);
  observability.observeTelemetryMessage('routed', 'connectivity');
  observability.observeTelemetryConnectivityChange(connected);
  return true;
}

export class TelemetryBroker {
  private broker: Aedes | null = null;
  private server: TcpServer | null = null;
  private ready = false;

  constructor(
    private readonly target: TelemetryTarget,
    private readonly observability: ProductionObservability = productionObservability,
  ) {}

  async start(): Promise<void> {
    if (config.demoMode) return;
    if (!config.telemetry.mqttPassword) {
      throw new Error('MQTT_PASSWORD is required when DEMO_MODE is disabled');
    }
    const broker = await Aedes.createBroker({ maxClientsIdLength: 64 });
    this.broker = broker;
    broker.authenticate = (_client, username, password, done) => {
      const name = username;
      const secret = password?.toString();
      done(
        null,
        name === config.telemetry.mqttUsername && secret === config.telemetry.mqttPassword,
      );
    };
    broker.on('publish', (packet: AedesPublishPacket, client: Client | null) => {
      if (!client) return;
      routeTelemetryMessage(this.target, packet.topic, packet.payload, config.telemetry.mqttTopicBase, this.observability);
    });
    this.server = createServer(broker.handle);
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(config.telemetry.mqttPort, '127.0.0.1', resolve);
    });
    this.ready = true;
    console.log(`Private MQTT broker listening on 127.0.0.1:${config.telemetry.mqttPort}`);
  }

  isReady(): boolean {
    return config.demoMode || this.ready;
  }

  async close(): Promise<void> {
    this.ready = false;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    await this.broker?.close();
  }
}
