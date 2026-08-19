\set ON_ERROR_STOP on

-- Run after every migration has been applied to an isolated PostgreSQL
-- database. All fixture state rolls back.
begin;

-- Red before the v3 migration: the deployed schema has no durable repair
-- enqueue/claim/complete contract and the existing queue rejects a v3 target.
do $assert$
begin
  if to_regprocedure(
    'public.enqueue_apple_lyrics_timeline_repair_v3(uuid,integer)'
  ) is null
    or to_regprocedure(
      'public.claim_apple_lyrics_timeline_repair_v3(uuid,text,integer,integer)'
    ) is null
    or to_regprocedure(
      'public.complete_apple_lyrics_timeline_repair_v3(uuid,uuid,jsonb,jsonb,text)'
    ) is null then
    raise exception 'Apple v3 timeline repair RPC contract is missing';
  end if;
end;
$assert$;

-- The v3 migration owns the shared SQL timing-gate override. Keep its short
-- overrun tolerance and two-level collapse boundaries identical to the worker.
do $assert$
begin
  if private.apple_synced_payload_timing_anomaly(
    E'[00:00.000]Start\n[00:12.500]Boundary',
    10000
  ) is not null
    or private.apple_synced_payload_timing_anomaly(
      E'[00:00.000]Start\n[00:12.501]Overrun',
      10000
    ) is distinct from 'timestamp-duration-overrun'
    or private.apple_synced_payload_timing_anomaly(
      E'[00:00.000]Start\n[03:30.000]Boundary',
      180000
    ) is not null
    or private.apple_synced_payload_timing_anomaly(
      E'[00:00.000]Start\n[03:30.001]Overrun',
      180000
    ) is distinct from 'timestamp-duration-overrun' then
    raise exception 'v3 SQL overrun tolerance differs from the worker';
  end if;

  if private.apple_synced_payload_timing_anomaly(
    E'[00:00.000]One\n[00:00.050]Two\n[00:00.100]Three\n'
      || E'[00:00.150]Four\n[00:00.200]Five\n[00:00.250]Six\n'
      || E'[00:00.300]Seven\n[00:00.350]Eight\n[00:00.400]Nine\n'
      || E'[00:00.450]Ten\n[00:00.500]Eleven\n[00:00.600]Twelve',
    30000
  ) is distinct from 'collapsed-timeline-coverage'
    or private.apple_synced_payload_timing_anomaly(
      E'[00:00.000]One\n[00:00.100]Two\n[00:00.200]Three\n'
        || E'[00:00.300]Four\n[00:00.400]Five\n[00:00.500]Six\n'
        || E'[00:00.600]Seven\n[00:00.700]Eight\n[00:00.800]Nine\n'
        || E'[00:00.900]Ten\n[00:01.000]Eleven',
      180000
    ) is distinct from 'collapsed-timeline-coverage' then
    raise exception 'v3 SQL collapse gate missed short or sparse corruption';
  end if;

  if private.apple_synced_payload_timing_anomaly(
    E'[00:00.000]One\n[00:00.100]Two\n[00:00.200]Three\n'
      || E'[00:00.300]Four\n[00:00.400]Five',
    180000
  ) is not null
    or private.apple_synced_payload_timing_anomaly(
      E'[00:00.000]One\n[00:00.100]Two\n[00:00.200]Three\n'
        || E'[00:00.300]Four\n[00:00.400]Five\n[00:00.500]Six\n'
        || E'[00:00.600]Seven\n[00:00.700]Eight\n[00:00.800]Nine\n'
        || E'[00:00.900]Ten\n[02:00.000]Outlier',
      180000
    ) is not null
    or private.apple_synced_payload_timing_anomaly(
      E'[00:00.000]One\n[00:00.150]Two\n[00:00.300]Three\n'
        || E'[00:00.450]Four\n[00:00.600]Five\n[00:00.750]Six\n'
        || E'[00:00.900]Seven\n[00:01.050]Eight\n[00:01.200]Nine\n'
        || E'[01:00.000]Ten\n[02:00.000]Eleven\n[02:50.000]Twelve',
      180000
    ) is not null then
    raise exception 'v3 SQL collapse gate rejected a conservative boundary';
  end if;
end;
$assert$;

-- Every database write/read gate must resolve timing through the function
-- overridden by this migration. Route refresh and resolve use it through the
-- shared candidate-rejection chain.
do $assert$
declare
  v_gate record;
  v_definition text;
begin
  for v_gate in
    select gate.signature
    from (
      values
        ('private.apple_primary_candidate_rejection_code(uuid,uuid,uuid,uuid)'),
        ('public.enqueue_apple_lyrics_timeline_repair_v3(uuid,integer)'),
        ('public.claim_apple_lyrics_timeline_repair_v3(uuid,text,integer,integer)'),
        ('public.complete_apple_lyrics_timeline_repair_v3(uuid,uuid,jsonb,jsonb,text)'),
        ('public.complete_apple_lyrics_backfill_v3(uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text,text,text)'),
        ('private.enqueue_apple_timeline_repair_from_evidence()')
    ) as gate(signature)
  loop
    v_definition := lower(
      pg_get_functiondef(to_regprocedure(v_gate.signature))
    );
    if position(
      'private.apple_synced_payload_timing_anomaly'
      in v_definition
    ) = 0 then
      raise exception 'server timing gate % bypasses the shared function',
        v_gate.signature;
    end if;
  end loop;

  if position(
    'private.apple_primary_candidate_rejection_code'
    in lower(
      pg_get_functiondef(
        'private.refresh_apple_primary_route_for_key(uuid,text,integer)'
          ::regprocedure
      )
    )
  ) = 0
    or position(
      'private.apple_primary_candidate_rejection_code'
      in lower(
        pg_get_functiondef(
          'private.is_apple_primary_route_valid(uuid,text,integer,uuid,uuid,uuid,uuid,text,timestamptz,uuid,timestamptz)'
            ::regprocedure
        )
      )
    ) = 0
    or position(
      'private.resolve_lyrics_before_apple_static_fallback_v1'
      in lower(
        pg_get_functiondef(
          'public.resolve_lyrics(uuid,text,text,integer)'::regprocedure
        )
      )
    ) = 0
    or position(
      'private.is_apple_primary_route_valid'
      in lower(
        pg_get_functiondef(
          'private.resolve_lyrics_before_apple_static_fallback_v1(uuid,text,text,integer)'
            ::regprocedure
        )
      )
    ) = 0 then
    raise exception 'Apple primary read/refresh chain bypasses timing rejection';
  end if;
end;
$assert$;

create function pg_temp.write_lrclib(
  p_exact_key text,
  p_text text
)
returns void
language plpgsql
as $$
begin
  perform public.upsert_lyrics_document(
    '00000000-0000-4000-8000-000000000001'::uuid,
    p_exact_key,
    null,
    1,
    jsonb_build_object(
      'title', p_exact_key,
      'artist', 'Fixture Artist',
      'album', 'Fixture Album',
      'duration_ms', 180000
    ),
    jsonb_build_object(
      'synced_lyrics', '[00:01.000]' || p_text,
      'plain_lyrics', p_text,
      'is_instrumental', false,
      'duration_ms', 180000
    ),
    jsonb_build_object(
      'provider_name', 'lrclib',
      'provider_track_id', 'lrclib-' || p_exact_key
    ),
    'provider'::public.lyrics_acquisition,
    'quarantine'::public.lyrics_status
  );
end;
$$;

create function pg_temp.complete_apple_direct(
  p_exact_key text,
  p_provider_track_id text,
  p_synced_lyrics text,
  p_plain_lyrics text,
  p_duration_ms integer,
  p_projection_version integer default 2
)
returns uuid
language plpgsql
as $$
declare
  v_enqueue jsonb;
  v_claim jsonb;
  v_job_id uuid;
  v_payload jsonb;
  v_provenance jsonb;
  v_raw_metadata jsonb;
  v_raw_ttml text;
begin
  v_raw_metadata := jsonb_build_object(
    'title', p_exact_key,
    'artist', 'Fixture Artist',
    'album', 'Fixture Album',
    'duration_ms', p_duration_ms,
    'source', 'fixture'
  );
  v_payload := jsonb_build_object(
    'synced_lyrics', p_synced_lyrics,
    'plain_lyrics', p_plain_lyrics,
    'is_instrumental', false,
    'duration_ms', p_duration_ms
  );
  v_provenance := jsonb_build_object(
    'body_format', case p_projection_version
      when 3 then 'apple-ttml-line-projection-v3-ms'
      else 'apple-ttml-line-projection-v2-ms'
    end,
    'exact_identity_proof_version', 1,
    'exact_identity_evidence', jsonb_build_array('fixture')
  ) || case
    when p_projection_version = 3 then
      jsonb_build_object(
        'timeline_validation_version', 'apple-timeline-validation-v1',
        'timeline_validation_outcome', 'valid',
        'timeline_source_anomaly', null,
        'timeline_repair_method', null
      )
    else '{}'::jsonb
  end;
  v_raw_ttml :=
    '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1">'
    || replace(p_plain_lyrics, '&', '&amp;')
    || '</p></div></body></tt>';

  v_enqueue := public.enqueue_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    p_exact_key,
    1,
    'us',
    'en-US',
    v_raw_metadata,
    p_provider_track_id,
    null,
    0,
    5
  );
  v_job_id := (v_enqueue ->> 'job_id')::uuid;
  v_claim := public.claim_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'apple-v3-sql-test',
    1,
    300
  ) -> 0;

  if v_claim is null
    or (v_claim ->> 'job_id')::uuid is distinct from v_job_id then
    raise exception 'fixture claimed an unexpected direct Apple job';
  end if;

  if p_projection_version = 3 then
    perform public.complete_apple_lyrics_backfill_v3(
      v_job_id,
      (v_claim ->> 'lease_token')::uuid,
      p_provider_track_id,
      'us',
      v_raw_metadata,
      v_payload,
      v_provenance,
      v_raw_ttml,
      'en-US',
      'line',
      'original'
    );
  else
    perform public.complete_apple_lyrics_backfill_v2(
      v_job_id,
      (v_claim ->> 'lease_token')::uuid,
      p_provider_track_id,
      'us',
      v_raw_metadata,
      v_payload,
      v_provenance,
      v_raw_ttml,
      'en-US',
      'line',
      'original'
    );
  end if;

  return v_job_id;
end;
$$;

create function pg_temp.redrive_apple_v2(
  p_job_id uuid,
  p_synced_lyrics text,
  p_plain_lyrics text
)
returns void
language plpgsql
as $$
declare
  v_job public.apple_lyrics_backfill_jobs%rowtype;
  v_claim jsonb;
begin
  perform public.requeue_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    p_job_id,
    'v3-sql-newer-snapshot',
    5
  );

  select job.*
  into strict v_job
  from public.apple_lyrics_backfill_jobs as job
  where job.id = p_job_id;

  v_claim := public.claim_apple_lyrics_backfill(
    v_job.library_id,
    'apple-v3-newer-snapshot-test',
    1,
    300
  ) -> 0;
  if v_claim is null
    or (v_claim ->> 'job_id')::uuid is distinct from p_job_id then
    raise exception 'fixture claimed an unexpected redriven Apple job';
  end if;

  perform public.complete_apple_lyrics_backfill_v2(
    p_job_id,
    (v_claim ->> 'lease_token')::uuid,
    v_job.provider_track_id,
    coalesce(v_job.resolved_storefront, v_job.storefront),
    v_job.track_metadata,
    jsonb_build_object(
      'synced_lyrics', p_synced_lyrics,
      'plain_lyrics', p_plain_lyrics,
      'is_instrumental', false,
      'duration_ms', v_job.track_metadata -> 'duration_ms'
    ),
    jsonb_build_object(
      'body_format', 'apple-ttml-line-projection-v2-ms',
      'exact_identity_proof_version', 1,
      'exact_identity_evidence', jsonb_build_array('fixture-redrive')
    ),
    '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>'
      || '<p begin="5">' || p_plain_lyrics || '</p>'
      || '</div></body></tt>',
    v_job.locale,
    'line',
    'original'
  );
end;
$$;

do $assert$
declare
  v_enqueue jsonb;
begin
  select public.enqueue_apple_lyrics_timeline_repair_v3(
    '00000000-0000-4000-8000-000000000001'::uuid,
    10000
  )
  into v_enqueue;
  if (v_enqueue ->> 'enqueued')::integer <> 0
    or (v_enqueue ->> 'remaining')::integer <> 0
    or exists (
      select 1
      from public.apple_lyrics_reprojection_jobs as job
      where job.target_projection_version = 'apple-ttml-line-model-v3'
    ) then
    raise exception 'clean migration unexpectedly seeded a v3 repair job';
  end if;
end;
$assert$;

-- A rolling v3 direct worker uses the v2 parameter/response shape, persists a
-- v3 artifact, and participates in Apple primary without weakening LRCLIB.
select pg_temp.write_lrclib('v3-direct', 'LRCLIB direct');
select pg_temp.complete_apple_direct(
  'v3-direct',
  'apple-v3-direct',
  '[00:05.000]Apple direct',
  'Apple direct',
  180000,
  3
);
set constraints all immediate;
set constraints all deferred;

do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v3-direct',
    null,
    1
  ) ->> 'provider_name' is distinct from 'apple' then
    raise exception 'valid direct v3 Apple artifact did not become primary';
  end if;

  if not exists (
    select 1
    from public.apple_lyrics_backfill_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.id = job.artifact_id
      and artifact.library_id = job.library_id
    join public.apple_lyrics_v2_completion_evidence as evidence
      on evidence.library_id = artifact.library_id
      and evidence.artifact_id = artifact.id
      and evidence.revision_id = artifact.revision_id
    where job.exact_key = 'v3-direct'
      and job.status = 'completed'
      and artifact.projection_version = 'apple-ttml-line-model-v3'
      and evidence.completion_kind = 'backfill'
  ) then
    raise exception 'direct v3 completion did not persist route evidence';
  end if;

  if not exists (
    select 1
    from public.lyrics_bindings as binding
    join public.lyrics_revisions as revision
      on revision.document_id = binding.document_id
      and revision.is_current
    where binding.lookup_key = 'v3-direct'
      and binding.status = 'active'
      and revision.provider_name = 'lrclib'
  ) then
    raise exception 'direct v3 completion changed the LRCLIB fallback';
  end if;
end;
$assert$;

delete from public.apple_lyrics_primary_routes
where exact_key = 'v3-direct';
select public.refresh_apple_lyrics_primary_routes(
  '00000000-0000-4000-8000-000000000001'::uuid,
  10000
);
do $assert$
begin
  if not exists (
    select 1
    from public.apple_lyrics_primary_routes as route
    where route.exact_key = 'v3-direct'
      and route.enabled
  )
    or public.resolve_lyrics(
      '00000000-0000-4000-8000-000000000001'::uuid,
      'v3-direct',
      null,
      1
    ) ->> 'provider_name' is distinct from 'apple' then
    raise exception 'full refresh did not rediscover a v3-only key';
  end if;
end;
$assert$;

-- The direct v3 SQL boundary rejects contradictory parser evidence before it
-- can acknowledge the leased job, then accepts the consistent retry.
do $assert$
declare
  v_enqueue jsonb;
  v_claim jsonb;
  v_job_id uuid;
  v_lease_token uuid;
  v_metadata jsonb := jsonb_build_object(
    'title', 'v3-direct-evidence',
    'artist', 'Fixture Artist',
    'album', 'Fixture Album',
    'duration_ms', 180000,
    'source', 'fixture'
  );
  v_payload jsonb := jsonb_build_object(
    'synced_lyrics', '[00:05.000]Evidence',
    'plain_lyrics', 'Evidence',
    'is_instrumental', false,
    'duration_ms', 180000
  );
  v_ttml text :=
    '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>'
    || '<p begin="5">Evidence</p></div></body></tt>';
begin
  v_enqueue := public.enqueue_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v3-direct-evidence',
    1,
    'us',
    'en-US',
    v_metadata,
    'apple-v3-direct-evidence',
    null,
    0,
    5
  );
  v_job_id := (v_enqueue ->> 'job_id')::uuid;
  v_claim := public.claim_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'apple-v3-direct-evidence-test',
    1,
    300
  ) -> 0;
  v_lease_token := (v_claim ->> 'lease_token')::uuid;

  begin
    perform public.complete_apple_lyrics_backfill_v3(
      v_job_id,
      v_lease_token,
      'apple-v3-direct-evidence',
      'us',
      v_metadata,
      v_payload || jsonb_build_object(
        'synced_lyrics', (v_payload ->> 'synced_lyrics') || E'\n'
      ),
      jsonb_build_object(
        'body_format', 'apple-ttml-line-projection-v3-ms',
        'timeline_validation_version', 'apple-timeline-validation-v1',
        'timeline_validation_outcome', 'valid',
        'timeline_source_anomaly', null,
        'timeline_repair_method', null,
        'exact_identity_proof_version', 1,
        'exact_identity_evidence', jsonb_build_array('fixture')
      ),
      v_ttml,
      'en-US',
      'line',
      'original'
    );
    raise exception 'outer-whitespace direct v3 payload unexpectedly completed';
  exception
    when invalid_parameter_value then null;
  end;

  begin
    perform public.complete_apple_lyrics_backfill_v3(
      v_job_id,
      v_lease_token,
      'apple-v3-direct-evidence',
      'us',
      v_metadata,
      v_payload || jsonb_build_object(
        'synced_lyrics', '[05:00.000]Evidence',
        'duration_ms', 86400000
      ),
      jsonb_build_object(
        'body_format', 'apple-ttml-line-projection-v3-ms',
        'timeline_validation_version', 'apple-timeline-validation-v1',
        'timeline_validation_outcome', 'valid',
        'timeline_source_anomaly', null,
        'timeline_repair_method', null,
        'exact_identity_proof_version', 1,
        'exact_identity_evidence', jsonb_build_array('fixture')
      ),
      v_ttml,
      'en-US',
      'line',
      'original'
    );
    raise exception 'inflated-duration direct v3 payload unexpectedly completed';
  exception
    when invalid_parameter_value then null;
  end;

  begin
    perform public.complete_apple_lyrics_backfill_v3(
      v_job_id,
      v_lease_token,
      'apple-v3-direct-evidence',
      'us',
      v_metadata,
      v_payload || jsonb_build_object('duration_ms', 0),
      jsonb_build_object(
        'body_format', 'apple-ttml-line-projection-v3-ms',
        'timeline_validation_version', 'apple-timeline-validation-v1',
        'timeline_validation_outcome', 'valid',
        'timeline_source_anomaly', null,
        'timeline_repair_method', null,
        'exact_identity_proof_version', 1,
        'exact_identity_evidence', jsonb_build_array('fixture')
      ),
      v_ttml,
      'en-US',
      'line',
      'original'
    );
    raise exception 'zero-duration direct v3 payload unexpectedly completed';
  exception
    when invalid_parameter_value then null;
  end;

  begin
    perform public.complete_apple_lyrics_backfill_v3(
      v_job_id,
      v_lease_token,
      'apple-v3-direct-evidence',
      'us',
      v_metadata,
      v_payload,
      jsonb_build_object(
        'body_format', 'apple-ttml-line-projection-v3-ms',
        'timeline_validation_version', 'apple-timeline-validation-v1',
        'timeline_validation_outcome', 'rejected',
        'timeline_source_anomaly', 'timestamp-duration-overrun',
        'timeline_repair_method', null,
        'exact_identity_proof_version', 1,
        'exact_identity_evidence', jsonb_build_array('fixture')
      ),
      v_ttml,
      'en-US',
      'line',
      'original'
    );
    raise exception 'contradictory direct v3 evidence unexpectedly completed';
  exception
    when invalid_parameter_value then null;
  end;

  perform public.complete_apple_lyrics_backfill_v3(
    v_job_id,
    v_lease_token,
    'apple-v3-direct-evidence',
    'us',
    v_metadata,
    v_payload,
    jsonb_build_object(
      'body_format', 'apple-ttml-line-projection-v3-ms',
      'timeline_validation_version', 'apple-timeline-validation-v1',
      'timeline_validation_outcome', 'valid',
      'timeline_source_anomaly', null,
      'timeline_repair_method', null,
      'timelineValidationVersion', 'spoofed-version',
      'exact_identity_proof_version', 1,
      'exact_identity_evidence', jsonb_build_array('fixture')
    ),
    v_ttml,
    'en-US',
    'line',
    'original'
  );
end;
$assert$;
set constraints all immediate;
set constraints all deferred;

do $assert$
begin
  if not exists (
    select 1
    from public.apple_lyrics_backfill_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.artifact_id
    join public.lyrics_revisions as revision
      on revision.id = artifact.revision_id
    where job.exact_key = 'v3-direct-evidence'
      and job.status = 'completed'
      and artifact.projection_version = 'apple-ttml-line-model-v3'
      and revision.provenance ->> 'timeline_validation_version' =
        'apple-timeline-validation-v1'
      and not (revision.provenance ? 'timelineValidationVersion')
  ) then
    raise exception 'consistent direct v3 evidence did not complete';
  end if;
end;
$assert$;

-- Static Apple payloads have no line timeline to validate. The explicit
-- not-evaluated state is valid only without a source anomaly or repair method.
do $assert$
declare
  v_enqueue jsonb;
  v_claim jsonb;
  v_job_id uuid;
  v_metadata jsonb := jsonb_build_object(
    'title', 'v3-direct-static',
    'artist', 'Fixture Artist',
    'album', 'Fixture Album',
    'duration_ms', 0,
    'source', 'fixture'
  );
begin
  v_enqueue := public.enqueue_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v3-direct-static',
    1,
    'us',
    'en-US',
    v_metadata,
    'apple-v3-direct-static',
    null,
    0,
    5
  );
  v_job_id := (v_enqueue ->> 'job_id')::uuid;
  v_claim := public.claim_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'apple-v3-direct-static-test',
    1,
    300
  ) -> 0;

  perform public.complete_apple_lyrics_backfill_v3(
    v_job_id,
    (v_claim ->> 'lease_token')::uuid,
    'apple-v3-direct-static',
    'us',
    v_metadata,
    jsonb_build_object(
      'plain_lyrics', 'Static evidence',
      'is_instrumental', false,
      'duration_ms', 0
    ),
    jsonb_build_object(
      'body_format', 'apple-ttml-static-projection-v3',
      'timeline_validation_version', 'apple-timeline-validation-v1',
      'timeline_validation_outcome', 'not-evaluated',
      'timeline_source_anomaly', null,
      'timeline_repair_method', null,
      'exact_identity_proof_version', 1,
      'exact_identity_evidence', jsonb_build_array('fixture')
    ),
    '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>'
      || '<p>Static evidence</p></div></body></tt>',
    'en-US',
    'none',
    'original'
  );
end;
$assert$;
set constraints all immediate;
set constraints all deferred;

do $assert$
begin
  if not exists (
    select 1
    from public.apple_lyrics_backfill_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.artifact_id
    join public.lyrics_revisions as revision
      on revision.id = artifact.revision_id
    where job.exact_key = 'v3-direct-static'
      and job.status = 'completed'
      and artifact.projection_version = 'apple-ttml-line-model-v3'
      and revision.provenance ->> 'timeline_validation_outcome' =
        'not-evaluated'
  ) then
    raise exception 'valid static v3 timeline evidence did not complete';
  end if;
end;
$assert$;

-- Old v2 completion remains callable and a valid v2 artifact remains primary.
select pg_temp.write_lrclib('v2-rolling', 'LRCLIB rolling');
select pg_temp.complete_apple_direct(
  'v2-rolling',
  'apple-v2-rolling',
  '[00:05.000]Apple rolling',
  'Apple rolling',
  180000,
  2
);
set constraints all immediate;
set constraints all deferred;

do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v2-rolling',
    null,
    1
  ) ->> 'provider_name' is distinct from 'apple' then
    raise exception 'rolling-compatible v2 completion stopped routing';
  end if;
end;
$assert$;

-- A hard duration overrun fails closed to LRCLIB and is queued exactly once
-- after its completed-v2 evidence becomes visible.
select pg_temp.write_lrclib('v3-overrun', 'Repair me');
select pg_temp.complete_apple_direct(
  'v3-overrun',
  'apple-v3-overrun',
  '[05:00.000]Repair me',
  'Repair me',
  180000,
  2
);
set constraints all immediate;
set constraints all deferred;

do $assert$
declare
  v_enqueue jsonb;
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v3-overrun',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib' then
    raise exception 'anomalous v2 Apple source did not fail closed to LRCLIB';
  end if;

  if (
    select count(*)
    from public.apple_lyrics_reprojection_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.id = job.source_artifact_id
      and artifact.library_id = job.library_id
    where artifact.exact_key = 'v3-overrun'
      and job.target_projection_version = 'apple-ttml-line-model-v3'
      and job.source_anomaly_code = 'timestamp-duration-overrun'
  ) <> 1 then
    raise exception 'duration overrun did not enqueue exactly one v3 repair';
  end if;

  v_enqueue := public.enqueue_apple_lyrics_timeline_repair_v3(
    '00000000-0000-4000-8000-000000000001'::uuid,
    10000
  );
  if (v_enqueue ->> 'enqueued')::integer <> 0
    or (v_enqueue ->> 'remaining')::integer <> 0 then
    raise exception 'v3 repair enqueue was not idempotent: %', v_enqueue;
  end if;
end;
$assert$;

-- A still-running v2 reprojection worker must ignore the shared queue's v3
-- row, including its cleanup path, throughout the rolling release.
do $assert$
declare
  v_old_claim jsonb;
begin
  v_old_claim := public.claim_apple_lyrics_reprojection_v2(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'rolling-v2-reprojection-worker',
    10,
    300
  );

  if exists (
    select 1
    from jsonb_array_elements(v_old_claim) as claimed(item)
    where claimed.item ->> 'target_projection_version' =
      'apple-ttml-line-model-v3'
  ) then
    raise exception 'old v2 worker claimed a v3 repair job';
  end if;

  if not exists (
    select 1
    from public.apple_lyrics_reprojection_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.source_artifact_id
    where artifact.exact_key = 'v3-overrun'
      and job.target_projection_version = 'apple-ttml-line-model-v3'
      and job.status = 'pending'
  ) then
    raise exception 'old v2 worker cleanup changed a pending v3 job';
  end if;

  update public.apple_lyrics_reprojection_jobs as job
  set
    status = 'processing',
    attempt_count = job.max_attempts,
    lease_token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    lease_owner = 'expired-v3-fixture',
    lease_expires_at = transaction_timestamp() - interval '1 second'
  from public.lyrics_source_artifacts as artifact
  where artifact.library_id = job.library_id
    and artifact.id = job.source_artifact_id
    and artifact.exact_key = 'v3-overrun'
    and job.target_projection_version = 'apple-ttml-line-model-v3';

  perform public.claim_apple_lyrics_reprojection_v2(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'rolling-v2-expired-cleanup-worker',
    10,
    300
  );
  if not exists (
    select 1
    from public.apple_lyrics_reprojection_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.source_artifact_id
    where artifact.exact_key = 'v3-overrun'
      and job.target_projection_version = 'apple-ttml-line-model-v3'
      and job.status = 'processing'
      and job.lease_owner = 'expired-v3-fixture'
  ) then
    raise exception 'old v2 worker cleanup changed an expired v3 lease';
  end if;

  -- Restore this synthetic expired row so the v3 worker can exercise its
  -- ordinary claim/completion path below.
  update public.apple_lyrics_reprojection_jobs as job
  set
    status = 'pending',
    attempt_count = 0,
    lease_token = null,
    lease_owner = null,
    lease_expires_at = null
  from public.lyrics_source_artifacts as artifact
  where artifact.library_id = job.library_id
    and artifact.id = job.source_artifact_id
    and artifact.exact_key = 'v3-overrun'
    and job.target_projection_version = 'apple-ttml-line-model-v3';
end;
$assert$;

create temporary table v3_overrun_claim as
select claimed.item
from jsonb_array_elements(
  public.claim_apple_lyrics_timeline_repair_v3(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'apple-v3-repair-sql-test',
    10,
    300
  )
) as claimed(item)
where claimed.item #>> '{source_artifact,exact_key}' = 'v3-overrun';

do $assert$
begin
  if (select count(*) from v3_overrun_claim) <> 1
    or (
      select item ->> 'source_anomaly_code'
      from v3_overrun_claim
    ) is distinct from 'timestamp-duration-overrun'
    or (
      select item ->> 'target_projection_version'
      from v3_overrun_claim
    ) is distinct from 'apple-ttml-line-model-v3'
    or (
      select item #>> '{source_artifact,projection_version}'
      from v3_overrun_claim
    ) is distinct from 'apple-ttml-line-model-v2' then
    raise exception 'v3 claim did not preserve source anomaly/projection';
  end if;
end;
$assert$;

select public.complete_apple_lyrics_timeline_repair_v3(
  (claim.item ->> 'job_id')::uuid,
  (claim.item ->> 'lease_token')::uuid,
  jsonb_build_object(
    'synced_lyrics', '[00:05.000]Repair me',
    'plain_lyrics', 'Repair me',
    'is_instrumental', false,
    'duration_ms', 180000
  ),
  jsonb_build_object(
    'body_format', 'apple-ttml-line-projection-v3-ms',
    'timeline_validation_version', 'apple-timeline-validation-v1',
    'timeline_validation_outcome', 'repaired',
    'timeline_source_anomaly', 'timestamp-duration-overrun',
    'timeline_repair_method', 'word-span-line-start-v1',
    'timelineValidationVersion', 'spoofed-version'
  ),
  'line'
)
from v3_overrun_claim as claim;
set constraints all immediate;
set constraints all deferred;

do $assert$
declare
  v_route public.apple_lyrics_primary_routes%rowtype;
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v3-overrun',
    null,
    1
  ) ->> 'provider_name' is distinct from 'apple' then
    raise exception 'valid v3 repair did not atomically replace LRCLIB primary';
  end if;

  select route.*
  into strict v_route
  from public.apple_lyrics_primary_routes as route
  where route.exact_key = 'v3-overrun';

  if not v_route.enabled
    or not exists (
      select 1
      from public.lyrics_source_artifacts as repaired
      join public.lyrics_source_artifacts as source
        on source.library_id = repaired.library_id
        and source.id = repaired.derived_from_artifact_id
      join public.lyrics_revisions as revision
        on revision.id = repaired.revision_id
      join public.apple_lyrics_v2_completion_evidence as evidence
        on evidence.library_id = repaired.library_id
        and evidence.artifact_id = repaired.id
        and evidence.revision_id = repaired.revision_id
      where repaired.id = v_route.artifact_id
        and repaired.projection_version = 'apple-ttml-line-model-v3'
        and source.projection_version = 'apple-ttml-line-model-v2'
        and repaired.raw_ttml = source.raw_ttml
        and repaired.content_hash = source.content_hash
        and repaired.byte_size = source.byte_size
        and repaired.fetched_at = source.fetched_at
        and evidence.completion_kind = 'timeline-repair'
        and revision.provenance ->> 'source_anomaly_code' =
          'timestamp-duration-overrun'
        and revision.provenance ->> 'repair_algorithm_version' =
          'apple-ttml-timeline-repair-v1'
        and revision.provenance ->> 'repair_strategy' =
          'word-span-line-start-v1'
        and revision.provenance ->> 'timeline_validation_version' =
          'apple-timeline-validation-v1'
        and not (revision.provenance ? 'timelineValidationVersion')
        and revision.provenance ->> 'body_format' =
          'apple-ttml-line-projection-v3-ms'
    ) then
    raise exception 'v3 repair lineage/evidence/provenance is incomplete';
  end if;

  if exists (
    select 1
    from public.apple_lyrics_reprojection_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.source_artifact_id
    where artifact.exact_key = 'v3-overrun'
      and job.target_projection_version = 'apple-ttml-line-model-v3'
      and job.status <> 'completed'
  ) then
    raise exception 'completed v3 repair retained a live duplicate job';
  end if;

  if not exists (
    select 1
    from public.lyrics_bindings as binding
    join public.lyrics_revisions as revision
      on revision.document_id = binding.document_id
      and revision.is_current
    where binding.lookup_key = 'v3-overrun'
      and binding.status = 'active'
      and revision.provider_name = 'lrclib'
  ) then
    raise exception 'successful v3 repair changed LRCLIB fallback state';
  end if;
end;
$assert$;

-- Completion is fail-closed: text/order/count, duration, and the post-repair
-- timing gate are all checked before a revision/artifact/route can commit.
select pg_temp.write_lrclib('v3-invalid-repair', 'Keep text');
select pg_temp.complete_apple_direct(
  'v3-invalid-repair',
  'apple-v3-invalid-repair',
  '[05:00.000]Keep text',
  'Keep text',
  180000,
  2
);
set constraints all immediate;
set constraints all deferred;

create temporary table v3_invalid_claim as
select claimed.item
from jsonb_array_elements(
  public.claim_apple_lyrics_timeline_repair_v3(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'apple-v3-invalid-repair-test',
    10,
    300
  )
) as claimed(item)
where claimed.item #>> '{source_artifact,exact_key}' = 'v3-invalid-repair';

do $assert$
declare
  v_job_id uuid := (
    select (item ->> 'job_id')::uuid from v3_invalid_claim
  );
  v_lease_token uuid := (
    select (item ->> 'lease_token')::uuid from v3_invalid_claim
  );
  v_base_provenance jsonb := jsonb_build_object(
    'body_format', 'apple-ttml-line-projection-v3-ms',
    'timeline_validation_version', 'apple-timeline-validation-v1',
    'timeline_validation_outcome', 'repaired',
    'timeline_source_anomaly', 'timestamp-duration-overrun',
    'timeline_repair_method', 'word-span-line-start-v1'
  );
begin
  if v_job_id is null or v_lease_token is null then
    raise exception 'invalid-repair fixture was not claimed';
  end if;

  begin
    perform public.complete_apple_lyrics_timeline_repair_v3(
      v_job_id,
      v_lease_token,
      jsonb_build_object(
        'synced_lyrics', '[00:05.000]Keep text',
        'plain_lyrics', 'Keep text',
        'is_instrumental', false,
        'duration_ms', 180000
      ),
      v_base_provenance - 'timeline_validation_version',
      'line'
    );
    raise exception 'unversioned v3 repair unexpectedly completed';
  exception
    when check_violation then null;
  end;

  begin
    perform public.complete_apple_lyrics_timeline_repair_v3(
      v_job_id,
      v_lease_token,
      jsonb_build_object(
        'synced_lyrics', '[00:05.000]Keep text',
        'plain_lyrics', 'Keep text ',
        'is_instrumental', false,
        'duration_ms', 180000
      ),
      v_base_provenance,
      'line'
    );
    raise exception 'outer-whitespace v3 repair unexpectedly completed';
  exception
    when check_violation then null;
  end;

  begin
    perform public.complete_apple_lyrics_timeline_repair_v3(
      v_job_id,
      v_lease_token,
      jsonb_build_object(
        'synced_lyrics', '[00:05.000]Changed text',
        'plain_lyrics', 'Changed text',
        'is_instrumental', false,
        'duration_ms', 180000
      ),
      v_base_provenance,
      'line'
    );
    raise exception 'text-changing v3 repair unexpectedly completed';
  exception
    when check_violation then null;
  end;

  begin
    perform public.complete_apple_lyrics_timeline_repair_v3(
      v_job_id,
      v_lease_token,
      jsonb_build_object(
        'synced_lyrics', '[00:05.000]Keep text',
        'plain_lyrics', 'Keep text',
        'is_instrumental', false,
        'duration_ms', 179999
      ),
      v_base_provenance,
      'line'
    );
    raise exception 'duration-changing v3 repair unexpectedly completed';
  exception
    when check_violation then null;
  end;

  begin
    perform public.complete_apple_lyrics_timeline_repair_v3(
      v_job_id,
      v_lease_token,
      jsonb_build_object(
        'synced_lyrics', '[05:01.000]Keep text',
        'plain_lyrics', 'Keep text',
        'is_instrumental', false,
        'duration_ms', 180000
      ),
      v_base_provenance,
      'line'
    );
    raise exception 'still-anomalous v3 repair unexpectedly completed';
  exception
    when check_violation then null;
  end;

  perform public.fail_apple_lyrics_timeline_repair_v3(
    v_job_id,
    v_lease_token,
    'parse:no-safe-repair',
    false,
    1
  );
end;
$assert$;

do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v3-invalid-repair',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib' then
    raise exception 'failed v3 repair changed the LRCLIB fallback route';
  end if;

  if exists (
    select 1
    from public.lyrics_source_artifacts as artifact
    where artifact.exact_key = 'v3-invalid-repair'
      and artifact.projection_version = 'apple-ttml-line-model-v3'
  ) then
    raise exception 'failed v3 repair persisted a v3 artifact';
  end if;

  if not exists (
    select 1
    from public.apple_lyrics_reprojection_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.source_artifact_id
    where artifact.exact_key = 'v3-invalid-repair'
      and job.target_projection_version = 'apple-ttml-line-model-v3'
      and job.status = 'dead_letter'
      and job.last_error_code = 'parse:no-safe-repair'
  ) then
    raise exception 'failed v3 repair was not durably dead-lettered';
  end if;
end;
$assert$;

-- If a newer completed v2 snapshot arrives before claim, the older repair is
-- cancelled and can never overwrite the new primary.
select pg_temp.write_lrclib('v3-stale-source', 'Stale source');
create temporary table v3_stale_backfill_job (id uuid primary key);
insert into v3_stale_backfill_job
select pg_temp.complete_apple_direct(
  'v3-stale-source',
  'apple-v3-stale-source',
  '[05:00.000]Stale source',
  'Stale source',
  180000,
  2
);
set constraints all immediate;
set constraints all deferred;

select pg_temp.redrive_apple_v2(
  (select id from v3_stale_backfill_job),
  '[00:05.000]Stale source',
  'Stale source'
);
set constraints all immediate;
set constraints all deferred;

do $assert$
declare
  v_claim jsonb;
begin
  v_claim := public.claim_apple_lyrics_timeline_repair_v3(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'apple-v3-stale-source-test',
    10,
    300
  );

  if exists (
    select 1
    from jsonb_array_elements(v_claim) as claimed(item)
    where claimed.item #>> '{source_artifact,exact_key}' = 'v3-stale-source'
  ) then
    raise exception 'stale v2 source was still claimable for v3 repair';
  end if;

  if not exists (
    select 1
    from public.apple_lyrics_reprojection_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.source_artifact_id
    where artifact.exact_key = 'v3-stale-source'
      and job.target_projection_version = 'apple-ttml-line-model-v3'
      and job.status = 'cancelled'
      and job.last_error_code = 'source-no-longer-eligible'
  ) then
    raise exception 'stale v3 repair job was not cancelled';
  end if;

  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v3-stale-source',
    null,
    1
  ) ->> 'provider_name' is distinct from 'apple' then
    raise exception 'new valid v2 snapshot did not remain Apple primary';
  end if;
end;
$assert$;

-- The second fixed anomaly code uses the same future trigger and durable
-- claim contract.
select pg_temp.write_lrclib(
  'v3-collapse',
  E'One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine\nTen\nEleven'
);
select pg_temp.complete_apple_direct(
  'v3-collapse',
  'apple-v3-collapse',
  E'[00:00.000]One\n[00:00.150]Two\n[00:00.300]Three\n'
    || E'[00:00.450]Four\n[00:00.600]Five\n[00:00.750]Six\n'
    || E'[00:00.900]Seven\n[00:01.050]Eight\n[00:01.200]Nine\n'
    || E'[00:01.350]Ten\n[00:01.500]Eleven',
  E'One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine\nTen\nEleven',
  180000,
  2
);
set constraints all immediate;
set constraints all deferred;

do $assert$
begin
  if not exists (
    select 1
    from public.apple_lyrics_reprojection_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.source_artifact_id
    where artifact.exact_key = 'v3-collapse'
      and job.target_projection_version = 'apple-ttml-line-model-v3'
      and job.source_anomaly_code = 'collapsed-timeline-coverage'
      and job.status = 'pending'
  ) then
    raise exception 'collapsed v2 timeline did not enqueue a v3 repair';
  end if;

  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v3-collapse',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib' then
    raise exception 'collapsed v2 timeline did not remain on LRCLIB';
  end if;
end;
$assert$;

select pg_temp.write_lrclib(
  'v3-short-collapse',
  E'One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine\nTen\nEleven\nTwelve'
);
select pg_temp.complete_apple_direct(
  'v3-short-collapse',
  'apple-v3-short-collapse',
  E'[00:00.000]One\n[00:00.050]Two\n[00:00.100]Three\n'
    || E'[00:00.150]Four\n[00:00.200]Five\n[00:00.250]Six\n'
    || E'[00:00.300]Seven\n[00:00.350]Eight\n[00:00.400]Nine\n'
    || E'[00:00.450]Ten\n[00:00.500]Eleven\n[00:00.600]Twelve',
  E'One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine\nTen\nEleven\nTwelve',
  30000,
  2
);
set constraints all immediate;
set constraints all deferred;

do $assert$
begin
  if not exists (
    select 1
    from public.apple_lyrics_reprojection_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.source_artifact_id
    where artifact.exact_key = 'v3-short-collapse'
      and job.target_projection_version = 'apple-ttml-line-model-v3'
      and job.source_anomaly_code = 'collapsed-timeline-coverage'
      and job.status = 'pending'
  ) then
    raise exception 'short collapsed v2 timeline did not enqueue v3 repair';
  end if;

  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'v3-short-collapse',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib' then
    raise exception 'short collapsed v2 timeline did not remain on LRCLIB';
  end if;
end;
$assert$;

-- Only the service role can execute the repair surface; it still has no
-- direct table privileges.
set local role service_role;
do $assert$
begin
  if (
    public.enqueue_apple_lyrics_timeline_repair_v3(
      '00000000-0000-4000-8000-000000000001'::uuid,
      10000
    ) ->> 'target_projection_version'
  ) is distinct from 'apple-ttml-line-model-v3' then
    raise exception 'service_role could not execute v3 repair enqueue';
  end if;
end;
$assert$;
reset role;

rollback;
