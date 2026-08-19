import type { TrackMetadata } from '../shared/contracts.js';
import type { AppleLyricsBackfillSinkInput } from './apple-lyrics-backfill.js';
import type { AppleTtmlConversionResult } from './apple-lyrics-ttml.js';
import {
  AppleTtmlProjectionParser,
  AppleTtmlProjectionParserV3,
  SupabaseAppleLyricsBackfillStore,
} from './supabase-apple-lyrics-backfill.js';
import type { SupabaseLyricsClient } from './supabase-lyrics-client.js';

const TRACK: TrackMetadata = {
  title: 'Midnight Circuit (Live)',
  artist: 'Local Drive',
  album: 'After Dark',
  durationMs: 214_000,
  source: 'Apple Music',
};

const JOB_ID = '33333333-3333-4333-8333-333333333333';
const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
const EXACT_KEY = 'midnight circuit::local drive::214::v=live::after dark';
const RAW_TTML = '\uFEFF<tt xmlns="http://www.w3.org/ns/ttml">原文</tt>\n';

function fakeClient() {
  const claimAppleLyricsBackfill = vi.fn<
    SupabaseLyricsClient['claimAppleLyricsBackfill']
  >(async () => []);
  const failAppleLyricsBackfill = vi.fn(async () => undefined);
  const completeAppleLyricsBackfill = vi.fn(async () => undefined);
  return {
    client: {
      claimAppleLyricsBackfill,
      failAppleLyricsBackfill,
      completeAppleLyricsBackfill,
    } as unknown as SupabaseLyricsClient,
    claimAppleLyricsBackfill,
    failAppleLyricsBackfill,
    completeAppleLyricsBackfill,
  };
}

function sinkInput(
  parsed: AppleTtmlConversionResult,
): AppleLyricsBackfillSinkInput<AppleTtmlConversionResult> {
  return {
    idempotencyKey: `apple-ttml:v1:${'a'.repeat(64)}`,
    jobId: JOB_ID,
    leaseToken: LEASE_TOKEN,
    track: TRACK,
    exactKey: EXACT_KEY,
    keyVersion: 1,
    exactIdentity: {
      proofVersion: 1,
      provider: 'apple',
      providerTrackId: '1450330685',
      exactKey: EXACT_KEY,
      keyVersion: 1,
      evidence: ['catalog-id', 'catalog-metadata-v1'],
    },
    artifact: {
      ttml: RAW_TTML,
      sha256: 'a'.repeat(64),
      byteLength: Buffer.byteLength(RAW_TTML, 'utf8'),
      fetchedAtMs: 1_700_000_000_000,
      storefront: 'us',
      language: 'en-US',
      timingMode: 'word',
    },
    parsed,
  };
}

describe('SupabaseAppleLyricsBackfillStore', () => {
  it('maps database leases without counting the current attempt twice', async () => {
    const fake = fakeClient();
    fake.claimAppleLyricsBackfill.mockResolvedValueOnce([{
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attempts: 2,
      maxAttempts: 5,
      exactKey: EXACT_KEY,
      keyVersion: 1,
      storefront: 'us',
      locale: 'en-US',
      providerTrackId: '1450330685',
      isrc: 'USAAA2400001',
      track: TRACK,
    }]);
    const store = new SupabaseAppleLyricsBackfillStore(fake.client, {
      workerId: 'worker-1',
      leaseSeconds: 300,
    });

    await expect(store.lease({ limit: 1, nowMs: 123 })).resolves.toEqual([{
      id: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attempts: 2,
      maxAttempts: 5,
      exactKey: EXACT_KEY,
      keyVersion: 1,
      storefront: 'us',
      locale: 'en-US',
      providerTrackId: '1450330685',
      isrc: 'USAAA2400001',
      track: TRACK,
    }]);
  });

  it('forwards operation and finalization signals to every Supabase queue operation', async () => {
    const fake = fakeClient();
    const store = new SupabaseAppleLyricsBackfillStore(fake.client, {
      workerId: 'worker-1',
      leaseSeconds: 300,
      now: () => 10_000,
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const failure = {
      stage: 'fetch' as const,
      code: 'timeout',
      retryable: true,
      exhausted: false,
    };
    const parsed: AppleTtmlConversionResult = {
      kind: 'plain',
      lines: [],
      plainText: '原文',
      sourceTimingMode: 'line',
      diagnostics: [],
      timelineValidation: {
        version: 'apple-timeline-validation-v1',
        outcome: 'rejected',
        sourceAnomaly: 'timestamp-duration-overrun',
        repairMethod: null,
      },
    };

    await store.lease({ limit: 1, nowMs: 10_000 }, options);
    await store.reschedule({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attempts: 1,
      availableAtMs: 20_000,
      failure,
    }, options);
    await store.fail({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attempts: 1,
      failure: { ...failure, retryable: false },
    }, options);
    await store.persist(sinkInput(parsed), options);

    expect(fake.claimAppleLyricsBackfill).toHaveBeenCalledWith(
      expect.any(Object),
      options,
    );
    expect(fake.failAppleLyricsBackfill).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ retryable: true }),
      options,
    );
    expect(fake.failAppleLyricsBackfill).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ retryable: false }),
      options,
    );
    expect(fake.completeAppleLyricsBackfill).toHaveBeenCalledWith(
      expect.any(Object),
      options,
    );
  });

  it('persists millisecond line projection and untouched raw TTML atomically', async () => {
    const fake = fakeClient();
    const store = new SupabaseAppleLyricsBackfillStore(fake.client, {
      workerId: 'worker-1',
      leaseSeconds: 300,
    });
    const parsed: AppleTtmlConversionResult = {
      kind: 'synced',
      lines: [{ id: 'apple-1009-0', startMs: 1_009, text: '原文' }],
      plainText: '原文',
      sourceTimingMode: 'word',
      diagnostics: [],
      timelineValidation: {
        version: 'apple-timeline-validation-v1',
        outcome: 'valid',
        sourceAnomaly: null,
        repairMethod: null,
      },
    };

    await expect(store.persist(sinkInput(parsed))).resolves.toEqual({
      jobCompleted: true,
    });

    expect(fake.completeAppleLyricsBackfill).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        rawTtml: RAW_TTML,
        storefront: 'us',
        locale: 'en-US',
        timingMode: 'word',
        recordingVariant: 'live',
        payload: {
          synced_lyrics: '[00:01.009]原文',
          plain_lyrics: '原文',
          is_instrumental: false,
          duration_ms: TRACK.durationMs,
        },
        provenance: expect.objectContaining({
          body_format: 'apple-ttml-line-projection-v3-ms',
          timeline_validation_version: 'apple-timeline-validation-v1',
          timeline_validation_outcome: 'valid',
          timeline_source_anomaly: null,
          timeline_repair_method: null,
        }),
      }),
    );
  });

  it('records catalog duration as timeline evidence only for duration-independent identity', async () => {
    const fake = fakeClient();
    const store = new SupabaseAppleLyricsBackfillStore(fake.client, {
      workerId: 'worker-1',
      leaseSeconds: 300,
    });
    const parsed: AppleTtmlConversionResult = {
      kind: 'synced',
      lines: [{ id: 'apple-1009-0', startMs: 1_009, text: '原文' }],
      plainText: '原文',
      sourceTimingMode: 'word',
      diagnostics: [],
      timelineValidation: {
        version: 'apple-timeline-validation-v1',
        outcome: 'valid',
        sourceAnomaly: null,
        repairMethod: null,
      },
    };
    const input = sinkInput(parsed);
    input.timelineDurationMs = 180_000;
    input.exactIdentity = {
      ...input.exactIdentity,
      evidence: [
        ...input.exactIdentity.evidence,
        'catalog-metadata-duration-independent-v1',
      ],
    };

    await store.persist(input);

    expect(fake.completeAppleLyricsBackfill).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: expect.objectContaining({
          timeline_duration_ms: 180_000,
        }),
      }),
    );
  });

  it('marks rejected static projections with the v3 validation evidence', async () => {
    const fake = fakeClient();
    const store = new SupabaseAppleLyricsBackfillStore(fake.client, {
      workerId: 'worker-1',
      leaseSeconds: 300,
    });
    const parsed: AppleTtmlConversionResult = {
      kind: 'plain',
      lines: [],
      plainText: '静态原文',
      sourceTimingMode: 'line',
      diagnostics: [],
      timelineValidation: {
        version: 'apple-timeline-validation-v1',
        outcome: 'rejected',
        sourceAnomaly: 'timestamp-duration-overrun',
        repairMethod: null,
      },
    };

    await store.persist(sinkInput(parsed));

    expect(fake.completeAppleLyricsBackfill).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        payload: {
          plain_lyrics: '静态原文',
          is_instrumental: false,
          duration_ms: TRACK.durationMs,
        },
        provenance: expect.objectContaining({
          body_format: 'apple-ttml-static-projection-v3',
          timeline_validation_version: 'apple-timeline-validation-v1',
          timeline_validation_outcome: 'rejected',
          timeline_source_anomaly: 'timestamp-duration-overrun',
          timeline_repair_method: null,
        }),
      }),
    );
  });

  it('refuses to persist a v3 projection without timeline-validation evidence', async () => {
    const fake = fakeClient();
    const store = new SupabaseAppleLyricsBackfillStore(fake.client, {
      workerId: 'worker-1',
      leaseSeconds: 300,
    });
    const parsed: AppleTtmlConversionResult = {
      kind: 'synced',
      lines: [{ id: 'apple-1009-0', startMs: 1_009, text: '原文' }],
      plainText: '原文',
      sourceTimingMode: 'word',
      diagnostics: [],
    };

    await expect(store.persist(sinkInput(parsed))).rejects.toThrow(
      'timeline-validation-missing',
    );
    expect(fake.completeAppleLyricsBackfill).not.toHaveBeenCalled();
  });

  it('refuses internally inconsistent timeline-validation evidence', async () => {
    const fake = fakeClient();
    const store = new SupabaseAppleLyricsBackfillStore(fake.client, {
      workerId: 'worker-1',
      leaseSeconds: 300,
    });
    const parsed: AppleTtmlConversionResult = {
      kind: 'plain',
      lines: [],
      plainText: '静态原文',
      sourceTimingMode: 'line',
      diagnostics: [],
      timelineValidation: {
        version: 'apple-timeline-validation-v1',
        outcome: 'valid',
        sourceAnomaly: null,
        repairMethod: null,
      },
    };

    await expect(store.persist(sinkInput(parsed))).rejects.toThrow(
      'timeline-validation-inconsistent',
    );
    expect(fake.completeAppleLyricsBackfill).not.toHaveBeenCalled();
  });

  it('maps retry scheduling to a bounded database delay without persisting error text', async () => {
    const fake = fakeClient();
    const store = new SupabaseAppleLyricsBackfillStore(fake.client, {
      workerId: 'worker-1',
      leaseSeconds: 300,
      now: () => 10_000,
    });

    await store.reschedule({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attempts: 1,
      availableAtMs: 41_001,
      failure: {
        stage: 'fetch',
        code: 'http-503',
        retryable: true,
        exhausted: false,
      },
    });

    expect(fake.failAppleLyricsBackfill).toHaveBeenCalledWith({
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      errorCode: 'fetch:http-503',
      retryable: true,
      retryAfterSeconds: 32,
    });
  });
});

describe('AppleTtmlProjectionParser', () => {
  it('rejects malformed TTML as a permanent parser failure', async () => {
    const parser = new AppleTtmlProjectionParser();

    await expect(parser.parse({ ttml: '<tt><body>' })).rejects.toThrow('ttml-invalid');
  });
});

describe('AppleTtmlProjectionParserV3', () => {
  it('validates against the verified catalog duration', async () => {
    const parser = new AppleTtmlProjectionParserV3();
    const parsed = await parser.parse({
      ttml: [
        '<tt xmlns="http://www.w3.org/ns/ttml"',
        ' xmlns:apple="http://music.apple.com/lyric-ttml-internal"',
        ' apple:timing="Line"><body><p begin="1s">Line</p></body></tt>',
      ].join(''),
      durationMs: 180_000,
    });

    expect(parsed.timelineValidation).toMatchObject({
      outcome: 'valid',
      sourceAnomaly: null,
    });
  });

  it('validates against Apple catalog duration when playback metadata drifts', async () => {
    const parser = new AppleTtmlProjectionParserV3();
    const input = {
      ttml: [
        '<tt xmlns="http://www.w3.org/ns/ttml"',
        ' xmlns:apple="http://music.apple.com/lyric-ttml-internal"',
        ' apple:timing="Line"><body><p begin="210.300s">Line</p></body></tt>',
      ].join(''),
      track: {
        ...TRACK,
        durationMs: 180_000,
      },
      fetched: {
        catalogTrack: {
          ...TRACK,
          durationMs: 180_499,
        },
      },
    };

    const parsed = await parser.parse(input);
    expect(parsed.kind).toBe('synced');
    expect(parsed.timelineValidation).toMatchObject({
      outcome: 'valid',
      sourceAnomaly: null,
    });
  });
});
