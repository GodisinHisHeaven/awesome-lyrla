import {
  parseConnectivityTopic,
  parseMetricTopic,
  routeTelemetryMessage,
  telemetryIsConnected,
} from './telemetry.js';

describe('Fleet Telemetry MQTT topics', () => {
  it('extracts VIN and field from the supported per-field topic shapes', () => {
    expect(parseMetricTopic('awesome-lyrla/7SAYGDEE1RF000000/v/MediaNowPlayingTitle')).toEqual({
      vin: '7SAYGDEE1RF000000',
      field: 'MediaNowPlayingTitle',
    });
    expect(parseMetricTopic('awesome-lyrla/VIN/metrics/MediaPlaybackStatus')).toEqual({
      vin: 'VIN',
      field: 'MediaPlaybackStatus',
    });
    expect(parseMetricTopic('awesome-lyrla/VIN/vehicle/MediaNowPlayingElapsed')).toEqual({
      vin: 'VIN',
      field: 'MediaNowPlayingElapsed',
    });
  });

  it('requires the exact configured base, shape, marker, and field depth', () => {
    expect(parseMetricTopic('awesome-lyrla/VIN/connectivity')).toBeNull();
    expect(parseMetricTopic('awesome-lyrla/v/MediaNowPlayingTitle')).toBeNull();
    expect(parseMetricTopic('prefix/awesome-lyrla/VIN/v/MediaNowPlayingTitle')).toBeNull();
    expect(parseMetricTopic('/awesome-lyrla/VIN/v/MediaNowPlayingTitle')).toBeNull();
    expect(parseMetricTopic('awesome-lyrla//VIN/v/MediaNowPlayingTitle')).toBeNull();
    expect(parseMetricTopic('awesome-lyrla/VIN/V/MediaNowPlayingTitle')).toBeNull();
    expect(parseMetricTopic('awesome-lyrla/VIN/v/MediaNowPlayingTitle/extra')).toBeNull();
    expect(parseMetricTopic('other/VIN/v/MediaNowPlayingTitle')).toBeNull();
    expect(parseMetricTopic(
      'fleet/awesome-lyrla/VIN/v/MediaNowPlayingTitle',
      'fleet/awesome-lyrla',
    )).toEqual({ vin: 'VIN', field: 'MediaNowPlayingTitle' });
  });

  it('parses only an exact per-VIN connectivity topic', () => {
    expect(parseConnectivityTopic('awesome-lyrla/VINA/connectivity')).toEqual({ vin: 'VINA' });
    expect(parseConnectivityTopic('awesome-lyrla/VINA/v/connectivity')).toBeNull();
    expect(parseConnectivityTopic('prefix/awesome-lyrla/VINA/connectivity')).toBeNull();
    expect(parseConnectivityTopic('awesome-lyrla/VINA/connectivity/extra')).toBeNull();
  });

  it('does not mistake DISCONNECTED for CONNECTED', () => {
    expect(telemetryIsConnected('CONNECTED')).toBe(true);
    expect(telemetryIsConnected('DISCONNECTED')).toBe(false);
    expect(telemetryIsConnected(undefined)).toBe(false);
  });
});

describe('single-vehicle telemetry routing', () => {
  function player(vin = 'VINA') {
    return {
      selectedVin: vi.fn(() => vin),
      ingest: vi.fn(),
      setConnection: vi.fn(),
    };
  }

  it('routes metric and connectivity messages for the selected VIN', () => {
    const target = player();

    expect(routeTelemetryMessage(
      target,
      'awesome-lyrla/VINA/v/MediaNowPlayingTitle',
      Buffer.from('{"value":"First song"}'),
    )).toBe(true);
    expect(routeTelemetryMessage(
      target,
      'awesome-lyrla/VINA/connectivity',
      Buffer.from('{"Status":"CONNECTED"}'),
    )).toBe(true);

    expect(target.ingest).toHaveBeenCalledWith(
      'VINA',
      'MediaNowPlayingTitle',
      { value: 'First song' },
    );
    expect(target.setConnection).toHaveBeenCalledWith(true);
  });

  it('drops messages for any VIN other than the selected vehicle', () => {
    const target = player();

    expect(routeTelemetryMessage(
      target,
      'awesome-lyrla/VINB/v/MediaNowPlayingTitle',
      Buffer.from('"wrong car"'),
    )).toBe(false);
    expect(routeTelemetryMessage(
      target,
      'awesome-lyrla/VINB/connectivity',
      Buffer.from('{"Status":"CONNECTED"}'),
    )).toBe(false);

    expect(target.ingest).not.toHaveBeenCalled();
    expect(target.setConnection).not.toHaveBeenCalled();
  });

  it('maps a disconnected payload to the player connection state', () => {
    const target = player();

    expect(routeTelemetryMessage(
      target,
      'awesome-lyrla/VINA/connectivity',
      Buffer.from('DISCONNECTED'),
    )).toBe(true);
    expect(target.setConnection).toHaveBeenCalledWith(false);
  });
});
