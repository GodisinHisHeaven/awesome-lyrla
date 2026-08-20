-- Run after `supabase db reset` (or after applying every migration to an
-- isolated PostgreSQL database). All fixture state rolls back.
begin;

create function pg_temp.write_lrclib(
  p_exact_key text,
  p_text text,
  p_instrumental boolean default false,
  p_synced boolean default true
)
returns uuid
language plpgsql
as $$
declare
  v_result jsonb;
begin
  v_result := public.upsert_lyrics_document(
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
    case
      when p_instrumental then
        jsonb_build_object(
          'is_instrumental', true,
          'duration_ms', 180000
        )
      when p_synced then
        jsonb_build_object(
          'synced_lyrics', '[00:01.000]' || p_text,
          'plain_lyrics', p_text,
          'is_instrumental', false,
          'duration_ms', 180000
        )
      else
        jsonb_build_object(
          'plain_lyrics', p_text,
          'is_instrumental', false,
          'duration_ms', 180000
        )
    end,
    jsonb_build_object(
      'provider_name', 'lrclib',
      'provider_track_id', 'lrclib-' || p_exact_key
    ),
    'provider'::public.lyrics_acquisition,
    'quarantine'::public.lyrics_status
  );
  return (v_result ->> 'document_id')::uuid;
end;
$$;

create function pg_temp.complete_apple(
  p_exact_key text,
  p_provider_track_id text,
  p_storefront text,
  p_text text,
  p_synced boolean,
  p_duration_ms integer default 180000,
  p_use_v2 boolean default true,
  p_synced_lyrics text default null,
  p_timing_mode text default 'line',
  p_title text default null,
  p_artist text default 'Fixture Artist',
  p_album text default 'Fixture Album'
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
  v_raw_ttml text;
begin
  v_enqueue := public.enqueue_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    p_exact_key,
    1,
    p_storefront,
    'en-US',
    jsonb_build_object(
      'title', coalesce(p_title, p_exact_key),
      'artist', p_artist,
      'album', p_album,
      'duration_ms', p_duration_ms,
      'source', 'fixture'
    ),
    p_provider_track_id,
    null,
    0,
    5
  );
  v_job_id := (v_enqueue ->> 'job_id')::uuid;
  v_claim := public.claim_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'apple-primary-sql-test',
    1,
    300
  ) -> 0;

  if v_claim is null
    or (v_claim ->> 'job_id')::uuid is distinct from v_job_id then
    raise exception 'fixture claimed an unexpected Apple job';
  end if;

  v_payload := case
    when p_synced then
      jsonb_build_object(
        'synced_lyrics', coalesce(
          p_synced_lyrics,
          '[00:01.000]' || p_text
        ),
        'plain_lyrics', p_text,
        'is_instrumental', false,
        'duration_ms', p_duration_ms
      )
    else
      jsonb_build_object(
        'plain_lyrics', p_text,
        'is_instrumental', false,
        'duration_ms', p_duration_ms
      )
  end;
  v_provenance := jsonb_build_object(
    'body_format', case
      when p_synced and p_use_v2
        then 'apple-ttml-line-projection-v2-ms'
      when p_synced
        then 'apple-ttml-line-projection-v1-ms'
      when p_use_v2
        then 'apple-ttml-static-projection-v2'
      else 'apple-ttml-static-projection-v1'
    end,
    'exact_identity_proof_version', 1,
    'exact_identity_evidence', jsonb_build_array('fixture')
  );
  v_raw_ttml := case
    when p_timing_mode = 'none'
      then '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p>'
        || p_text || '</p></div></body></tt>'
    else '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1.0" end="2.0">'
      || p_text || '</p></div></body></tt>'
  end;

  if p_use_v2 then
    perform public.complete_apple_lyrics_backfill_v2(
      v_job_id,
      (v_claim ->> 'lease_token')::uuid,
      p_provider_track_id,
      p_storefront,
      jsonb_build_object(
        'title', coalesce(p_title, p_exact_key),
        'artist', p_artist,
        'album', p_album,
        'duration_ms', p_duration_ms,
        'source', 'fixture'
      ),
      v_payload,
      v_provenance,
      v_raw_ttml,
      'en-US',
      p_timing_mode,
      'original'
    );
  else
    perform public.complete_apple_lyrics_backfill(
      v_job_id,
      (v_claim ->> 'lease_token')::uuid,
      p_provider_track_id,
      p_storefront,
      jsonb_build_object(
        'title', coalesce(p_title, p_exact_key),
        'artist', p_artist,
        'album', p_album,
        'duration_ms', p_duration_ms,
        'source', 'fixture'
      ),
      v_payload,
      v_provenance,
      v_raw_ttml,
      'en-US',
      p_timing_mode,
      'original'
    );
  end if;

  return v_job_id;
end;
$$;

create function pg_temp.redrive_apple(
  p_job_id uuid,
  p_provider_track_id text,
  p_storefront text,
  p_text text,
  p_synced boolean,
  p_duration_ms integer default 180000,
  p_use_v2 boolean default true,
  p_lrc_timestamp text default '00:02.000'
)
returns void
language plpgsql
as $$
declare
  v_job public.apple_lyrics_backfill_jobs%rowtype;
  v_claim jsonb;
  v_payload jsonb;
  v_provenance jsonb;
begin
  perform public.requeue_apple_lyrics_backfill(
    '00000000-0000-4000-8000-000000000001'::uuid,
    p_job_id,
    'sql-test-redrive',
    5
  );
  select job.*
  into strict v_job
  from public.apple_lyrics_backfill_jobs as job
  where job.id = p_job_id;
  v_claim := public.claim_apple_lyrics_backfill(
    v_job.library_id,
    'apple-primary-redrive-test',
    1,
    300
  ) -> 0;
  if v_claim is null
    or (v_claim ->> 'job_id')::uuid is distinct from p_job_id then
    raise exception 'fixture redrive claimed an unexpected Apple job';
  end if;

  v_payload := case
    when p_synced then
      jsonb_build_object(
        'synced_lyrics', '[' || p_lrc_timestamp || ']' || p_text,
        'plain_lyrics', p_text,
        'is_instrumental', false,
        'duration_ms', p_duration_ms
      )
    else
      jsonb_build_object(
        'plain_lyrics', p_text,
        'is_instrumental', false,
        'duration_ms', p_duration_ms
      )
  end;
  v_provenance := jsonb_build_object(
    'body_format', case
      when p_synced and p_use_v2
        then 'apple-ttml-line-projection-v2-ms'
      when p_synced
        then 'apple-ttml-line-projection-v1-ms'
      when p_use_v2
        then 'apple-ttml-static-projection-v2'
      else 'apple-ttml-static-projection-v1'
    end,
    'exact_identity_proof_version', 1,
    'exact_identity_evidence', jsonb_build_array('fixture')
  );

  if p_use_v2 then
    perform public.complete_apple_lyrics_backfill_v2(
      p_job_id,
      (v_claim ->> 'lease_token')::uuid,
      p_provider_track_id,
      p_storefront,
      v_job.track_metadata,
      v_payload,
      v_provenance,
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="2.0" end="3.0">'
        || p_text || '</p></div></body></tt>',
      'en-US',
      'line',
      'original'
    );
  else
    perform public.complete_apple_lyrics_backfill(
      p_job_id,
      (v_claim ->> 'lease_token')::uuid,
      p_provider_track_id,
      p_storefront,
      v_job.track_metadata,
      v_payload,
      v_provenance,
      '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="2.0" end="3.0">'
        || p_text || '</p></div></body></tt>',
      'en-US',
      'line',
      'original'
    );
  end if;
end;
$$;

-- Exact proof is a hard gate. Missing evidence must fail closed, and malformed
-- non-array evidence must return an anomaly instead of raising from
-- jsonb_array_length.
do $assert$
declare
  v_refresh_definition text := lower(
    pg_get_functiondef(
      'private.refresh_apple_primary_route_for_key(uuid,text,integer)'
        ::regprocedure
    )
  );
begin
  if position('pg_advisory_xact_lock' in v_refresh_definition) = 0
    or position('for update' in v_refresh_definition) > 0
    or position(
      'pg_advisory_xact_lock'
      in v_refresh_definition
    ) > position(
      'apple_primary_completed_document_count'
      in v_refresh_definition
    ) then
    raise exception 'Apple route refresh violated the advisory-only lock invariant';
  end if;
end;
$assert$;

do $assert$
begin
  if private.apple_synced_payload_hard_anomaly(
    '[00:01.000]Missing evidence',
    'Missing evidence',
    false,
    jsonb_build_object('exact_identity_proof_version', 1)
  ) is distinct from 'missing-exact-proof' then
    raise exception 'missing Exact evidence did not fail closed';
  end if;

  if private.apple_synced_payload_hard_anomaly(
    '[00:01.000]Object evidence',
    'Object evidence',
    false,
    jsonb_build_object(
      'exact_identity_proof_version',
      1,
      'exact_identity_evidence',
      jsonb_build_object('fixture', true)
    )
  ) is distinct from 'missing-exact-proof' then
    raise exception 'non-array Exact evidence did not fail closed';
  end if;
end;
$assert$;

-- The duration-relative gate uses a tighter short-track overrun tolerance and
-- a two-level collapse rule. These are structural boundaries, not claims that
-- the timing has been audio-aligned.
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
    raise exception 'duration-overrun tolerance boundary drifted';
  end if;

  if private.apple_synced_payload_timing_anomaly(
    E'[00:00.000]One\n[00:00.050]Two\n[00:00.100]Three\n'
      || E'[00:00.150]Four\n[00:00.200]Five\n[00:00.250]Six\n'
      || E'[00:00.300]Seven\n[00:00.350]Eight\n[00:00.400]Nine\n'
      || E'[00:00.450]Ten\n[00:00.500]Eleven\n[00:00.600]Twelve',
    30000
  ) is distinct from 'collapsed-timeline-coverage' then
    raise exception 'short twelve-line collapse escaped the timing gate';
  end if;

  if private.apple_synced_payload_timing_anomaly(
    E'[00:00.000]One\n[00:00.100]Two\n[00:00.200]Three\n'
      || E'[00:00.300]Four\n[00:00.400]Five\n[00:00.500]Six\n'
      || E'[00:00.600]Seven\n[00:00.700]Eight\n[00:00.800]Nine\n'
      || E'[00:00.900]Ten\n[00:01.000]Eleven',
    180000
  ) is distinct from 'collapsed-timeline-coverage' then
    raise exception 'fully collapsed sparse timeline escaped the timing gate';
  end if;

  if private.apple_synced_payload_timing_anomaly(
    E'[00:00.000]One\n[00:00.100]Two\n[00:00.200]Three\n'
      || E'[00:00.300]Four\n[00:00.400]Five',
    180000
  ) is not null then
    raise exception 'five-line timeline was scored as collapsed';
  end if;

  if private.apple_synced_payload_timing_anomaly(
    E'[00:00.000]One\n[00:00.100]Two\n[00:00.200]Three\n'
      || E'[00:00.300]Four\n[00:00.400]Five\n[00:00.500]Six\n'
      || E'[00:00.600]Seven\n[00:00.700]Eight\n[00:00.800]Nine\n'
      || E'[00:00.900]Ten\n[02:00.000]Outlier',
    180000
  ) is not null then
    raise exception 'sparse timeline with a distributed outlier was collapsed';
  end if;

  if private.apple_synced_payload_timing_anomaly(
    E'[08:00.000]Hidden vocal entrance\n[09:00.000]Medley close',
    600000
  ) is not null then
    raise exception 'hidden-track/medley timing was blocked';
  end if;

  if private.apple_synced_payload_timing_anomaly(
    E'[00:00.000]One\n[00:00.150]Two\n[00:00.300]Three\n'
      || E'[00:00.450]Four\n[00:00.600]Five\n[00:00.750]Six\n'
      || E'[00:00.900]Seven\n[00:01.050]Eight\n[00:01.200]Nine\n'
      || E'[01:00.000]Ten\n[02:00.000]Eleven\n[02:50.000]Twelve',
    180000
  ) is not null then
    raise exception 'twelve-line sub-80-percent cluster was collapsed';
  end if;
end;
$assert$;

-- Valid Apple v2 Exact becomes primary while LRCLIB remains active fallback.
select pg_temp.write_lrclib('route-basic', 'LRCLIB basic');
select pg_temp.complete_apple(
  'route-basic',
  'apple-route-basic',
  'us',
  'Apple basic',
  true
);
set constraints all immediate;
set constraints all deferred;

do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-basic',
    null,
    1
  );
  if v_result ->> 'provider_name' is distinct from 'apple'
    or v_result ->> 'provider_route' is distinct from 'apple-primary-v1'
    or v_result ->> 'synced_lyrics'
      is distinct from '[00:01.000]Apple basic'
    or v_result #>> '{provider_fallback,result_status}'
      is distinct from 'hit'
    or v_result #>> '{provider_fallback,match_kind}'
      is distinct from 'exact'
    or v_result #>> '{provider_fallback,selection_method}'
      is distinct from 'provider'
    or v_result #>> '{provider_fallback,provider_name}'
      is distinct from 'lrclib'
    or v_result #>> '{provider_fallback,synced_lyrics}'
      is distinct from '[00:01.000]LRCLIB basic'
    or v_result #>> '{provider_fallback,document_id}'
      is not distinct from v_result ->> 'document_id'
    or not exists (
      select 1
      from public.lyrics_bindings as binding
      join public.lyrics_revisions as revision
        on revision.document_id = binding.document_id
        and revision.is_current
      where binding.lookup_key = 'route-basic'
        and binding.status = 'active'
        and revision.provider_name = 'lrclib'
    ) then
    raise exception 'valid Apple primary did not preserve LRCLIB fallback';
  end if;
end;
$assert$;

do $assert$
declare
  v_refresh jsonb;
begin
  v_refresh := private.refresh_apple_primary_route_for_key(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-basic',
    1
  );
  if (v_refresh ->> 'changed')::boolean is distinct from false
    or (v_refresh ->> 'route_version')::bigint is distinct from 1 then
    raise exception 'idempotent route refresh reported or wrote a change: %',
      v_refresh;
  end if;
end;
$assert$;

-- Global kill switch is immediate and reversible.
select public.set_apple_lyrics_primary_enabled(
  '00000000-0000-4000-8000-000000000001'::uuid,
  false
);
do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-basic',
    null,
    1
  );
  if v_result ->> 'provider_name' is distinct from 'lrclib'
    or v_result ? 'provider_fallback' then
    raise exception 'kill switch did not restore LRCLIB';
  end if;
end;
$assert$;
select public.set_apple_lyrics_primary_enabled(
  '00000000-0000-4000-8000-000000000001'::uuid,
  true
);

-- Explicit hard block falls back without deleting either source; clearing it
-- deterministically restores the same immutable pin.
select public.set_apple_lyrics_primary_block(
  '00000000-0000-4000-8000-000000000001'::uuid,
  'route-basic',
  1,
  true,
  'fixture-hard-anomaly'
);
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-basic',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib' then
    raise exception 'hard block did not fall back to LRCLIB';
  end if;
end;
$assert$;
select public.set_apple_lyrics_primary_block(
  '00000000-0000-4000-8000-000000000001'::uuid,
  'route-basic',
  1,
  false,
  'fixture-cleared'
);

-- A retained v1 TTML artifact must become routable through the real
-- enqueue/claim/complete reprojection RPC path. The source normalized payload
-- is intentionally unchanged, so the v2 artifact reuses a revision whose
-- provenance still says v1.
select pg_temp.write_lrclib(
  'route-retained-reprojection',
  'LRCLIB retained reprojection'
);
create temporary table retained_reprojection_source_job (
  id uuid primary key
);
insert into retained_reprojection_source_job
select pg_temp.complete_apple(
  'route-retained-reprojection',
  'apple-retained-reprojection',
  'us',
  'Apple retained reprojection',
  true,
  180000,
  false
);
set constraints all immediate;
set constraints all deferred;
select public.enqueue_apple_lyrics_reprojection_v2(
  '00000000-0000-4000-8000-000000000001'::uuid,
  100
);
create temporary table retained_reprojection_claim as
select
  (claimed.item ->> 'job_id')::uuid as job_id,
  (claimed.item ->> 'lease_token')::uuid as lease_token,
  (claimed.item #>> '{source_artifact,revision_id}')::uuid
    as source_revision_id
from jsonb_array_elements(
  public.claim_apple_lyrics_reprojection_v2(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'apple-primary-retained-reprojection-test',
    10,
    300
  )
) as claimed(item)
where claimed.item #>> '{source_artifact,exact_key}' =
  'route-retained-reprojection';
do $assert$
begin
  if (select count(*) from retained_reprojection_claim) <> 1 then
    raise exception 'retained TTML fixture did not claim exactly one job';
  end if;
end;
$assert$;
select public.complete_apple_lyrics_reprojection_v2(
  claim.job_id,
  claim.lease_token,
  jsonb_build_object(
    'synced_lyrics', '[00:01.000]Apple retained reprojection',
    'plain_lyrics', 'Apple retained reprojection',
    'is_instrumental', false,
    'duration_ms', 180000
  ),
  jsonb_build_object(
    'body_format', 'apple-ttml-line-projection-v2-ms'
  ),
  'line'
)
from retained_reprojection_claim as claim;
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-retained-reprojection',
    null,
    1
  );
  if v_result ->> 'provider_name' is distinct from 'apple'
    or v_result ->> 'synced_lyrics'
      is distinct from '[00:01.000]Apple retained reprojection'
    or not exists (
      select 1
      from public.apple_lyrics_primary_routes as route
      join public.lyrics_source_artifacts as artifact
        on artifact.library_id = route.library_id
        and artifact.id = route.artifact_id
      join public.lyrics_revisions as revision
        on revision.id = route.revision_id
      join public.apple_lyrics_v2_completion_evidence as evidence
        on evidence.library_id = route.library_id
        and evidence.artifact_id = route.artifact_id
        and evidence.revision_id = route.revision_id
      where route.exact_key = 'route-retained-reprojection'
        and artifact.derived_from_artifact_id is not null
        and evidence.completion_kind = 'reprojection'
        and revision.provenance ->> 'body_format' =
          'apple-ttml-line-projection-v1-ms'
        and revision.id = (
          select claim.source_revision_id
          from retained_reprojection_claim as claim
        )
    ) then
    raise exception 'retained TTML v2 completion did not auto-route its reused v1 revision';
  end if;
end;
$assert$;

-- Direct backfill_v2 is also valid when normalized hash idempotency reuses a
-- v1 revision. V2 evidence lives on the completed artifact/job, not on mutable
-- revision provenance.
select pg_temp.write_lrclib('route-reused-v1-revision', 'LRCLIB reused v1');
create temporary table reused_v1_revision_job (id uuid primary key);
insert into reused_v1_revision_job
select pg_temp.complete_apple(
  'route-reused-v1-revision',
  'apple-reused-v1-revision',
  'us',
  'Apple reused v1 revision',
  true,
  180000,
  false
);
set constraints all immediate;
set constraints all deferred;
select pg_temp.redrive_apple(
  (select id from reused_v1_revision_job),
  'apple-reused-v1-revision',
  'us',
  'Apple reused v1 revision',
  true,
  180000,
  true,
  '00:01.000'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-reused-v1-revision',
    null,
    1
  ) ->> 'provider_name' is distinct from 'apple'
    or not exists (
      select 1
      from public.apple_lyrics_primary_routes as route
      join public.lyrics_source_artifacts as artifact
        on artifact.library_id = route.library_id
        and artifact.id = route.artifact_id
      join public.lyrics_revisions as revision
        on revision.id = route.revision_id
      join public.apple_lyrics_v2_completion_evidence as evidence
        on evidence.library_id = route.library_id
        and evidence.artifact_id = route.artifact_id
        and evidence.revision_id = route.revision_id
      where route.exact_key = 'route-reused-v1-revision'
        and artifact.projection_version = 'apple-ttml-line-model-v2'
        and evidence.completion_kind = 'backfill'
        and revision.provenance ->> 'body_format' =
          'apple-ttml-line-projection-v1-ms'
    ) then
    raise exception 'direct v2 completion rejected a same-hash v1 revision';
  end if;
end;
$assert$;

-- Static Apple never displaces LRCLIB.
select pg_temp.write_lrclib('route-static', 'LRCLIB static');
select pg_temp.complete_apple(
  'route-static',
  'apple-route-static',
  'us',
  'Apple static',
  false,
  180000,
  true,
  null,
  'none'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-static',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib' then
    raise exception 'static Apple displaced LRCLIB';
  end if;
end;
$assert$;

-- When no higher-priority result exists, one exact-proven Apple static v2
-- artifact is a direct non-scrolling hit instead of an ambiguous candidate.
select pg_temp.complete_apple(
  'route-static-only',
  'apple-route-static-only',
  'us',
  E'Apple static first line\nApple static second line',
  false,
  180000,
  true,
  null,
  'none'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-static-only',
    null,
    1
  );
  if v_result ->> 'result_status' is distinct from 'hit'
    or v_result ->> 'match_kind' is distinct from 'exact'
    or v_result ->> 'provider_name' is distinct from 'apple'
    or v_result ->> 'provider_route'
      is distinct from 'apple-static-fallback-v1'
    or (v_result ->> 'auto_scroll')::boolean is distinct from false
    or v_result ->> 'synced_lyrics' is not null
    or v_result ->> 'plain_lyrics'
      is distinct from E'Apple static first line\nApple static second line'
    or v_result ->> 'status' is distinct from 'active'
    or v_result ->> 'storage_binding_status'
      is distinct from 'quarantine'
    or v_result ? 'provider_fallback' then
    raise exception 'verified Apple static payload was not a direct static hit: %',
      v_result;
  end if;
end;
$assert$;

-- Retained v1 artifacts are eligible only for this same static path. They
-- remain excluded from the synchronized Apple primary route table.
select pg_temp.complete_apple(
  'route-static-v1-only',
  'apple-route-static-v1-only',
  'us',
  'Apple retained v1 static',
  false,
  180000,
  false,
  null,
  'none'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-static-v1-only',
    null,
    1
  );
  if v_result ->> 'provider_name' is distinct from 'apple'
    or v_result ->> 'provider_route'
      is distinct from 'apple-static-fallback-v1'
    or (v_result ->> 'auto_scroll')::boolean is distinct from false
    or v_result ->> 'synced_lyrics' is not null
    or v_result ->> 'plain_lyrics'
      is distinct from 'Apple retained v1 static'
    or not exists (
      select 1
      from public.lyrics_source_artifacts as artifact
      where artifact.exact_key = 'route-static-v1-only'
        and artifact.projection_version = 'apple-ttml-line-model-v1'
        and artifact.timing_mode = 'none'
    )
    or exists (
      select 1
      from public.apple_lyrics_primary_routes as route
      where route.exact_key = 'route-static-v1-only'
        and route.enabled
    ) then
    raise exception 'completed retained Apple v1 static was not safely served: %',
      v_result;
  end if;
end;
$assert$;

-- The v1 evidence allowance is static-only. A retained synchronized v1
-- artifact remains quarantined until the existing v2 reprojection path
-- completes; this fallback cannot bypass synchronized primary validation.
select pg_temp.complete_apple(
  'route-synced-v1-not-static',
  'apple-route-synced-v1-not-static',
  'us',
  'Apple retained v1 synced',
  true,
  180000,
  false
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-synced-v1-not-static',
    null,
    1
  ) ->> 'result_status' is distinct from 'ambiguous'
    or exists (
      select 1
      from public.apple_lyrics_primary_routes as route
      where route.exact_key = 'route-synced-v1-not-static'
        and route.enabled
    ) then
    raise exception 'synchronized Apple v1 bypassed v2 primary validation';
  end if;
end;
$assert$;

-- Plain text with a non-static artifact timing declaration is not eligible;
-- only the parser's explicit `none` mode can use this fallback.
select pg_temp.complete_apple(
  'route-static-wrong-timing',
  'apple-route-static-wrong-timing',
  'us',
  'Apple static wrong timing',
  false
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-static-wrong-timing',
    null,
    1
  ) ->> 'result_status' is distinct from 'ambiguous' then
    raise exception 'non-none Apple timing entered static fallback';
  end if;
end;
$assert$;

-- The static fallback shares the Apple kill switch. Disabling Apple routing
-- restores the pre-existing ambiguous candidate response.
select public.set_apple_lyrics_primary_enabled(
  '00000000-0000-4000-8000-000000000001'::uuid,
  false
);
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-static-only',
    null,
    1
  ) ->> 'result_status' is distinct from 'ambiguous' then
    raise exception 'Apple kill switch did not disable static fallback';
  end if;
end;
$assert$;
select public.set_apple_lyrics_primary_enabled(
  '00000000-0000-4000-8000-000000000001'::uuid,
  true
);

-- Two completed Apple documents are still unsafe even when both are static.
select pg_temp.complete_apple(
  'route-static-ambiguous',
  'apple-static-ambiguous-us',
  'us',
  'Apple static ambiguous US',
  false,
  180000,
  true,
  null,
  'none'
);
set constraints all immediate;
set constraints all deferred;
select pg_temp.complete_apple(
  'route-static-ambiguous',
  'apple-static-ambiguous-gb',
  'gb',
  'Apple static ambiguous GB',
  false,
  180000,
  true,
  null,
  'none'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-static-ambiguous',
    null,
    1
  ) ->> 'result_status' is distinct from 'ambiguous' then
    raise exception 'multiple Apple static documents bypassed ambiguity';
  end if;
end;
$assert$;

-- Tesla can report a wildly wrong duration while every other byte of the v1
-- Exact fingerprint still names the same recording. Reuse the one valid Apple
-- primary pin as Work-shaped fallback while retaining its validated timeline.
select pg_temp.complete_apple(
  '童言无忌 不插电::王以太::300::闪火mixtape ep',
  'apple-duration-alias-tongyan',
  'cn',
  E'童言无忌第一行\n童言无忌第二行',
  true,
  300141,
  true,
  E'[00:01.000]童言无忌第一行\n[00:02.000]童言无忌第二行',
  'line',
  '童言无忌 (不插电)',
  '王以太',
  '闪火mixtape - EP'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_result jsonb;
begin
  if private.lyrics_v1_exact_duration_family(
    '童言无忌 不插电::王以太::300::闪火mixtape ep'
  ) is distinct from '童言无忌 不插电::王以太::闪火mixtape ep'
    or private.lyrics_v1_exact_duration_family(
      'versioned song::fixture artist::300::v=acoustic,live::fixture album'
    ) is distinct from
      'versioned song::fixture artist::v=acoustic,live::fixture album'
    or private.lyrics_v1_exact_duration_family(
      'malformed-duration::fixture artist::soon::fixture album'
    ) is not null then
    raise exception 'v1 duration family parser accepted or changed unsafe bytes';
  end if;

  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    '童言无忌 不插电::王以太::216::闪火mixtape ep',
    '童言无忌::王以太',
    1
  );
  if v_result ->> 'result_status' is distinct from 'hit'
    or v_result ->> 'match_kind' is distinct from 'work'
    or v_result ->> 'provider_name' is distinct from 'apple'
    or v_result ->> 'provider_track_id'
      is distinct from 'apple-duration-alias-tongyan'
    or v_result ->> 'provider_route'
      is distinct from 'apple-duration-alias-synced-v1'
    or (v_result ->> 'auto_scroll')::boolean is distinct from true
    or v_result ->> 'synced_lyrics'
      is distinct from E'[00:01.000]童言无忌第一行\n[00:02.000]童言无忌第二行'
    or v_result ->> 'plain_lyrics'
      is distinct from E'童言无忌第一行\n童言无忌第二行'
    or v_result ->> 'storage_binding_status'
      is distinct from 'quarantine' then
    raise exception 'valid Apple duration alias did not retain its timeline: %',
      v_result;
  end if;

  if exists (
    select 1
    from public.lyrics_bindings as binding
    where binding.library_id =
      '00000000-0000-4000-8000-000000000001'::uuid
      and binding.binding_kind = 'work'
      and binding.lookup_key = '童言无忌::王以太'
  ) then
    raise exception 'duration alias created a generic Apple Work binding';
  end if;

  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    '童言无忌 不插电::王以太::216::闪火mixtape ep',
    null,
    1
  ) ->> 'result_status' is distinct from 'miss' then
    raise exception 'duration alias ran without explicit Work permission';
  end if;

  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    '童言无忌 不插电::王以太::216::另一张专辑',
    '童言无忌::王以太',
    1
  ) ->> 'result_status' is distinct from 'miss'
    or public.resolve_lyrics(
      '00000000-0000-4000-8000-000000000001'::uuid,
      '童言有忌 不插电::王以太::216::闪火mixtape ep',
      '童言无忌::王以太',
      1
    ) ->> 'result_status' is distinct from 'miss'
    or public.resolve_lyrics(
      '00000000-0000-4000-8000-000000000001'::uuid,
      '童言无忌 不插电::王以太::216::v=live::闪火mixtape ep',
      '童言无忌::王以太',
      1
    ) ->> 'result_status' is distinct from 'miss' then
    raise exception 'duration alias crossed album, title, or version bytes';
  end if;
end;
$assert$;

-- Human Exact, provider Exact, and existing active Work remain ahead of the
-- duration alias. A synchronized Apple alias now supersedes an automatic
-- LRCLIB Exact only when that Exact has static text; current Apple static
-- routes still retain their existing priority.
select pg_temp.complete_apple(
  'alias manual::fixture artist::300::fixture album',
  'apple-alias-manual-source',
  'us',
  'Apple alias manual source',
  true,
  300000
);
select public.upsert_lyrics_document(
  '00000000-0000-4000-8000-000000000001'::uuid,
  'alias manual::fixture artist::216::fixture album',
  null,
  1,
  '{"title":"Alias Manual","artist":"Fixture Artist","album":"Fixture Album","duration_ms":216000}'::jsonb,
  '{"plain_lyrics":"Human alias manual","is_instrumental":false,"duration_ms":216000}'::jsonb,
  '{"provider_name":"manual","idempotency_key":"alias-manual","selection_version":81}'::jsonb,
  'manual'::public.lyrics_acquisition,
  'active'::public.lyrics_status
);

select pg_temp.complete_apple(
  'alias lrclib::fixture artist::300::fixture album',
  'apple-alias-lrclib-source',
  'us',
  'Apple alias LRCLIB source',
  true,
  300000
);
select pg_temp.write_lrclib(
  'alias lrclib::fixture artist::216::fixture album',
  'LRCLIB exact before alias',
  false,
  false
);

select pg_temp.complete_apple(
  'alias provider exact::fixture artist::300::fixture album',
  'apple-alias-provider-source',
  'us',
  'Apple alias provider source',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias provider exact::fixture artist::216::fixture album',
  'apple-alias-provider-current',
  'us',
  'Apple current Exact',
  true,
  216000
);

select pg_temp.complete_apple(
  'alias active work::fixture artist::300::fixture album',
  'apple-alias-active-work-source',
  'us',
  'Apple alias active Work source',
  true,
  300000
);
select public.upsert_lyrics_document(
  '00000000-0000-4000-8000-000000000001'::uuid,
  null,
  'alias active work::fixture artist',
  1,
  '{"title":"Alias Active Work","artist":"Fixture Artist","album":"Fixture Album","duration_ms":0}'::jsonb,
  '{"plain_lyrics":"Existing human Work","is_instrumental":false,"duration_ms":0}'::jsonb,
  '{"provider_name":"manual","idempotency_key":"alias-active-work","selection_version":82}'::jsonb,
  'manual'::public.lyrics_acquisition,
  'active'::public.lyrics_status
);

select pg_temp.complete_apple(
  'alias current static::fixture artist::300::fixture album',
  'apple-alias-current-static-source',
  'us',
  'Apple alias current static source',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias current static::fixture artist::216::fixture album',
  'apple-alias-current-static',
  'us',
  'Apple current static',
  false,
  216000,
  true,
  null,
  'none'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias manual::fixture artist::216::fixture album',
    'alias manual::fixture artist',
    1
  );
  if v_result ->> 'provider_name' is distinct from 'manual'
    or v_result ->> 'plain_lyrics' is distinct from 'Human alias manual' then
    raise exception 'human Exact did not outrank duration alias: %', v_result;
  end if;

  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias lrclib::fixture artist::216::fixture album',
    'alias lrclib::fixture artist',
    1
  );
  if v_result ->> 'provider_name' is distinct from 'apple'
    or v_result ->> 'provider_route'
      is distinct from 'apple-duration-alias-synced-v1'
    or v_result ->> 'match_kind' is distinct from 'work'
    or (v_result ->> 'auto_scroll')::boolean is distinct from true
    or v_result ->> 'synced_lyrics'
      is distinct from E'[00:01.000]Apple alias LRCLIB source' then
    raise exception 'synchronized Apple duration alias did not supersede static LRCLIB Exact: %', v_result;
  end if;

  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias provider exact::fixture artist::216::fixture album',
    'alias provider exact::fixture artist',
    1
  );
  if v_result ->> 'provider_track_id'
      is distinct from 'apple-alias-provider-current'
    or v_result ->> 'match_kind' is distinct from 'exact'
    or (v_result ->> 'auto_scroll')::boolean is distinct from true then
    raise exception 'current Apple Exact did not outrank duration alias: %',
      v_result;
  end if;

  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias active work::fixture artist::216::fixture album',
    'alias active work::fixture artist',
    1
  );
  if v_result ->> 'provider_name' is distinct from 'manual'
    or v_result ->> 'match_kind' is distinct from 'work'
    or v_result ->> 'plain_lyrics' is distinct from 'Existing human Work' then
    raise exception 'existing active Work did not outrank duration alias: %',
      v_result;
  end if;

  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias current static::fixture artist::216::fixture album',
    'alias current static::fixture artist',
    1
  );
  if v_result ->> 'provider_track_id'
      is distinct from 'apple-alias-current-static'
    or v_result ->> 'provider_route'
      is distinct from 'apple-static-fallback-v1'
    or v_result ->> 'match_kind' is distinct from 'exact' then
    raise exception 'current Exact static did not outrank duration alias: %',
      v_result;
  end if;
end;
$assert$;

-- Cross-duration candidates fail closed when more than one Apple document or
-- more than one immutable content hash exists in the same byte-exact family.
select pg_temp.complete_apple(
  'alias ambiguous document::fixture artist::300::fixture album',
  'apple-alias-ambiguous-document-a',
  'us',
  'Apple ambiguous document A',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias ambiguous document::fixture artist::302::fixture album',
  'apple-alias-ambiguous-document-b',
  'us',
  'Apple ambiguous document B',
  true,
  302000
);
select pg_temp.complete_apple(
  'alias ambiguous content::fixture artist::300::fixture album',
  'apple-alias-ambiguous-content',
  'us',
  'Apple ambiguous content A',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias ambiguous content::fixture artist::302::fixture album',
  'apple-alias-ambiguous-content',
  'us',
  'Apple ambiguous content B',
  true,
  302000
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias ambiguous document::fixture artist::216::fixture album',
    'alias ambiguous document::fixture artist',
    1
  ) ->> 'result_status' is distinct from 'miss' then
    raise exception 'multiple Apple documents did not fail duration alias closed';
  end if;

  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias ambiguous content::fixture artist::216::fixture album',
    'alias ambiguous content::fixture artist',
    1
  ) ->> 'result_status' is distinct from 'miss' then
    raise exception 'multiple Apple content hashes did not fail duration alias closed';
  end if;
end;
$assert$;

-- Kill switch, hard anomaly block, and human rejection apply to the source
-- Exact route before it can be reused as a duration alias.
select pg_temp.complete_apple(
  'alias kill switch::fixture artist::300::fixture album',
  'apple-alias-kill-switch',
  'us',
  'Apple alias kill switch',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias blocked::fixture artist::300::fixture album',
  'apple-alias-blocked',
  'us',
  'Apple alias blocked',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias rejected::fixture artist::300::fixture album',
  'apple-alias-rejected',
  'us',
  'Apple alias rejected',
  true,
  300000
);
-- These sibling controls deliberately share one immutable document/content
-- across durations. Their explicit block/rejection must still suppress the
-- otherwise safe alias family.
select pg_temp.complete_apple(
  'alias sibling blocked::fixture artist::300::fixture album',
  'apple-alias-sibling-blocked',
  'us',
  'Apple alias sibling blocked',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias sibling blocked::fixture artist::302::fixture album',
  'apple-alias-sibling-blocked',
  'us',
  'Apple alias sibling blocked',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias sibling rejected::fixture artist::300::fixture album',
  'apple-alias-sibling-rejected',
  'us',
  'Apple alias sibling rejected',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias sibling rejected::fixture artist::302::fixture album',
  'apple-alias-sibling-rejected',
  'us',
  'Apple alias sibling rejected',
  true,
  300000
);
-- A retained disabled sibling with different immutable content is also
-- ambiguity evidence even though it is absent from the valid route set.
select pg_temp.complete_apple(
  'alias sibling disabled::fixture artist::300::fixture album',
  'apple-alias-sibling-disabled-a',
  'us',
  'Apple alias sibling disabled A',
  true,
  300000
);
select pg_temp.complete_apple(
  'alias sibling disabled::fixture artist::302::fixture album',
  'apple-alias-sibling-disabled-b',
  'us',
  'Apple alias sibling disabled B',
  true,
  302000
);
set constraints all immediate;
set constraints all deferred;
select public.set_apple_lyrics_primary_block(
  '00000000-0000-4000-8000-000000000001'::uuid,
  'alias blocked::fixture artist::300::fixture album',
  1,
  true,
  'sql-test-duration-alias'
);
select public.set_apple_lyrics_primary_block(
  '00000000-0000-4000-8000-000000000001'::uuid,
  'alias sibling blocked::fixture artist::302::fixture album',
  1,
  true,
  'sql-test-duration-alias-sibling'
);
update public.lyrics_bindings as binding
set
  status = 'rejected',
  status_reason = 'sql-test-duration-alias-rejected'
where binding.lookup_key =
    'alias rejected::fixture artist::300::fixture album'
  and binding.status = 'quarantine'
  and exists (
    select 1
    from public.lyrics_revisions as revision
    where revision.document_id = binding.document_id
      and revision.provider_name = 'apple'
  );
update public.lyrics_bindings as binding
set
  status = 'rejected',
  status_reason = 'sql-test-duration-alias-sibling-rejected'
where binding.lookup_key =
    'alias sibling rejected::fixture artist::302::fixture album'
  and binding.status = 'quarantine'
  and exists (
    select 1
    from public.lyrics_revisions as revision
    where revision.document_id = binding.document_id
      and revision.provider_name = 'apple'
  );
update public.apple_lyrics_primary_routes as route
set
  enabled = false,
  disabled_reason = 'sql-test-disabled-sibling'
where route.library_id =
    '00000000-0000-4000-8000-000000000001'::uuid
  and route.key_version = 1
  and route.exact_key =
    'alias sibling disabled::fixture artist::302::fixture album';
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias sibling blocked::fixture artist::216::fixture album',
    'alias sibling blocked::fixture artist',
    1
  ) ->> 'result_status' is distinct from 'miss'
    or public.resolve_lyrics(
      '00000000-0000-4000-8000-000000000001'::uuid,
      'alias sibling rejected::fixture artist::216::fixture album',
      'alias sibling rejected::fixture artist',
      1
    ) ->> 'result_status' is distinct from 'miss'
    or public.resolve_lyrics(
      '00000000-0000-4000-8000-000000000001'::uuid,
      'alias sibling disabled::fixture artist::216::fixture album',
      'alias sibling disabled::fixture artist',
      1
    ) ->> 'result_status' is distinct from 'miss' then
    raise exception
      'blocked, rejected, or disabled sibling escaped family protection';
  end if;
end;
$assert$;
select public.refresh_apple_lyrics_primary_routes(
  '00000000-0000-4000-8000-000000000001'::uuid,
  10000
);
select public.set_apple_lyrics_primary_enabled(
  '00000000-0000-4000-8000-000000000001'::uuid,
  false
);
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias kill switch::fixture artist::216::fixture album',
    'alias kill switch::fixture artist',
    1
  ) ->> 'result_status' is distinct from 'miss' then
    raise exception 'Apple kill switch did not disable duration alias';
  end if;
end;
$assert$;
select public.set_apple_lyrics_primary_enabled(
  '00000000-0000-4000-8000-000000000001'::uuid,
  true
);
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'alias blocked::fixture artist::216::fixture album',
    'alias blocked::fixture artist',
    1
  ) ->> 'result_status' is distinct from 'miss'
    or public.resolve_lyrics(
      '00000000-0000-4000-8000-000000000001'::uuid,
      'alias rejected::fixture artist::216::fixture album',
      'alias rejected::fixture artist',
      1
    ) ->> 'result_status' is distinct from 'miss' then
    raise exception 'blocked or rejected Apple Exact entered duration alias';
  end if;
end;
$assert$;

-- The newest completed source snapshot is selected before quality. A newer
-- static v2 snapshot disables the older synced route.
select pg_temp.write_lrclib('route-newest-static', 'LRCLIB newest static');
create temporary table newest_static_job (id uuid primary key);
insert into newest_static_job
select pg_temp.complete_apple(
  'route-newest-static',
  'apple-newest-static',
  'us',
  'Apple older synced',
  true
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-newest-static',
    null,
    1
  ) ->> 'provider_name' is distinct from 'apple' then
    raise exception 'older synced fixture never became Apple primary';
  end if;
end;
$assert$;
select pg_temp.redrive_apple(
  (select id from newest_static_job),
  'apple-newest-static',
  'us',
  'Apple newer static',
  false
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-newest-static',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib'
    or not exists (
      select 1
      from public.apple_lyrics_primary_routes as route
      where route.exact_key = 'route-newest-static'
        and not route.enabled
        and route.disabled_reason = 'missing-synced-lyrics'
    ) then
    raise exception 'newest static v2 did not invalidate older synced route';
  end if;
end;
$assert$;

-- A later v1 refresh can change document.current, but the immutable v2 pin
-- remains valid and serves its pinned synced revision.
select pg_temp.write_lrclib('route-immutable-pin', 'LRCLIB immutable');
create temporary table immutable_pin_job (id uuid primary key);
insert into immutable_pin_job
select pg_temp.complete_apple(
  'route-immutable-pin',
  'apple-immutable-pin',
  'us',
  'Apple pinned synced',
  true
);
set constraints all immediate;
set constraints all deferred;
select pg_temp.redrive_apple(
  (select id from immutable_pin_job),
  'apple-immutable-pin',
  'us',
  'Later v1 static current',
  false,
  180000,
  false
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-immutable-pin',
    null,
    1
  );
  if v_result ->> 'provider_name' is distinct from 'apple'
    or v_result ->> 'synced_lyrics'
      is distinct from '[00:01.000]Apple pinned synced' then
    raise exception 'route followed mutable document.current instead of its pin: %',
      jsonb_build_object(
        'result', v_result,
        'route', (
          select to_jsonb(route)
          from public.apple_lyrics_primary_routes as route
          where route.exact_key = 'route-immutable-pin'
        )
      );
  end if;
end;
$assert$;

-- Two completed Apple documents for one Exact key are ambiguous regardless of
-- completion order; LRCLIB remains the deterministic result.
select pg_temp.write_lrclib('route-ambiguous', 'LRCLIB ambiguous');
select pg_temp.complete_apple(
  'route-ambiguous',
  'apple-ambiguous-us',
  'us',
  'Apple ambiguous US',
  true
);
set constraints all immediate;
set constraints all deferred;
select pg_temp.complete_apple(
  'route-ambiguous',
  'apple-ambiguous-gb',
  'gb',
  'Apple ambiguous GB',
  true
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-ambiguous',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib'
    or not exists (
      select 1
      from public.apple_lyrics_primary_routes as route
      where route.exact_key = 'route-ambiguous'
        and not route.enabled
        and route.disabled_reason = 'ambiguous-apple-documents'
    ) then
    raise exception 'cross-document Apple ambiguity did not fail closed';
  end if;
end;
$assert$;

-- Human Exact selection remains above Apple. Existing Exact-before-Work
-- ordering is otherwise unchanged.
select pg_temp.write_lrclib('route-manual', 'LRCLIB manual');
select pg_temp.complete_apple(
  'route-manual',
  'apple-route-manual',
  'us',
  'Apple manual',
  true
);
set constraints all immediate;
set constraints all deferred;
select public.upsert_lyrics_document(
  '00000000-0000-4000-8000-000000000001'::uuid,
  'route-manual',
  null,
  1,
  '{"title":"route-manual","artist":"Fixture Artist","album":"Fixture Album","duration_ms":180000}'::jsonb,
  '{"synced_lyrics":"[00:01.000]Human manual","plain_lyrics":"Human manual","is_instrumental":false,"duration_ms":180000}'::jsonb,
  '{"provider_name":"manual","idempotency_key":"sql-test-manual","selection_version":42}'::jsonb,
  'manual'::public.lyrics_acquisition,
  'active'::public.lyrics_status
);
do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-manual',
    null,
    1
  );
  if v_result ->> 'provider_name' is distinct from 'manual'
    or v_result ? 'provider_fallback' then
    raise exception 'human Exact selection did not outrank Apple';
  end if;
end;
$assert$;

-- An explicit candidate Exact is also a human selection. It remains above the
-- Apple route and must not expose the displaced provider Exact as a fallback.
select pg_temp.write_lrclib('route-candidate', 'LRCLIB provider candidate');
select pg_temp.complete_apple(
  'route-candidate',
  'apple-route-candidate',
  'us',
  'Apple candidate',
  true
);
set constraints all immediate;
set constraints all deferred;
select public.upsert_lyrics_document(
  '00000000-0000-4000-8000-000000000001'::uuid,
  'route-candidate',
  null,
  1,
  '{"title":"route-candidate","artist":"Fixture Artist","album":"Fixture Album","duration_ms":180000}'::jsonb,
  '{"synced_lyrics":"[00:01.000]Human candidate","plain_lyrics":"Human candidate","is_instrumental":false,"duration_ms":180000}'::jsonb,
  '{"provider_name":"lrclib","provider_track_id":"selected-route-candidate","selection_version":43}'::jsonb,
  'candidate'::public.lyrics_acquisition,
  'active'::public.lyrics_status
);
do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-candidate',
    null,
    1
  );
  if v_result ->> 'selection_method' is distinct from 'candidate'
    or v_result ->> 'synced_lyrics'
      is distinct from '[00:01.000]Human candidate'
    or v_result ? 'provider_fallback' then
    raise exception 'candidate Exact selection did not exclusively outrank Apple';
  end if;
end;
$assert$;

-- A routed Apple document is stored as a quarantined provider Exact. Without
-- a separate active provider Exact, the old resolver yields only a candidate;
-- that candidate must never be attached as provider_fallback.
select pg_temp.complete_apple(
  'route-quarantine-only',
  'apple-route-quarantine-only',
  'us',
  'Apple quarantine only',
  true
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_result jsonb;
begin
  v_result := public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-quarantine-only',
    null,
    1
  );
  if v_result ->> 'provider_name' is distinct from 'apple'
    or v_result ->> 'storage_binding_status' is distinct from 'quarantine'
    or v_result ? 'provider_fallback' then
    raise exception 'quarantined provider Exact was exposed as a fallback';
  end if;
end;
$assert$;

-- Duration metadata is not a hard gate: a structurally valid timestamp under
-- the absolute 24h bound remains eligible despite a polluted tiny duration.
-- The timing gate deliberately uses a generous absolute allowance.
select pg_temp.write_lrclib('route-duration-drift', 'LRCLIB duration');
select pg_temp.complete_apple(
  'route-duration-drift',
  'apple-duration-drift',
  'us',
  'Apple duration drift',
  true,
  1
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-duration-drift',
    null,
    1
  ) ->> 'provider_name' is distinct from 'apple' then
    raise exception 'duration drift incorrectly blocked Apple primary';
  end if;
end;
$assert$;

-- A structurally valid LRC must not become primary when its final timestamp is
-- catastrophically beyond an otherwise credible Apple catalog duration.
select pg_temp.write_lrclib(
  'route-duration-overrun',
  'LRCLIB duration overrun'
);
select pg_temp.complete_apple(
  'route-duration-overrun',
  'apple-duration-overrun',
  'us',
  'Apple duration overrun',
  true,
  180000,
  true,
  E'[00:01.000]Opening\n[15:00.000]Impossible tail'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_refresh jsonb;
begin
  v_refresh := private.refresh_apple_primary_route_for_key(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-duration-overrun',
    1
  );
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-duration-overrun',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib'
    or v_refresh ->> 'state' is distinct from 'fallback'
    or v_refresh ->> 'reason'
      is distinct from 'timestamp-duration-overrun'
    or exists (
      select 1
      from public.apple_lyrics_primary_routes as route
      where route.exact_key = 'route-duration-overrun'
        and route.enabled
    ) then
    raise exception 'duration-overrun Apple timing became primary';
  end if;
end;
$assert$;

-- Upgrade safety does not depend on rewriting every materialized route inside
-- one migration transaction. Even a stale enabled pin must fail closed at
-- resolve time through is_apple_primary_route_valid.
insert into public.apple_lyrics_primary_routes (
  library_id,
  key_version,
  exact_key,
  binding_id,
  document_id,
  revision_id,
  artifact_id,
  revision_content_hash,
  source_snapshot_at,
  source_snapshot_id,
  artifact_fetched_at,
  enabled,
  disabled_reason
)
select
  artifact.library_id,
  artifact.key_version,
  artifact.exact_key,
  binding.id,
  binding.document_id,
  revision.id,
  artifact.id,
  revision.content_hash,
  coalesce(source_artifact.fetched_at, artifact.fetched_at),
  coalesce(source_artifact.id, artifact.id),
  artifact.fetched_at,
  true,
  null
from public.lyrics_source_artifacts as artifact
join public.lyrics_revisions as revision
  on revision.id = artifact.revision_id
join public.lyrics_bindings as binding
  on binding.library_id = artifact.library_id
  and binding.document_id = revision.document_id
  and binding.binding_kind = 'exact'
  and binding.key_version = artifact.key_version
  and binding.lookup_key = artifact.exact_key
left join public.lyrics_source_artifacts as source_artifact
  on source_artifact.library_id = artifact.library_id
  and source_artifact.id = artifact.derived_from_artifact_id
where artifact.exact_key = 'route-duration-overrun'
  and artifact.projection_version = 'apple-ttml-line-model-v2'
order by artifact.fetched_at desc, artifact.id desc
limit 1
on conflict (library_id, key_version, exact_key)
do update set enabled = true, disabled_reason = null;
do $assert$
begin
  if not exists (
    select 1
    from public.apple_lyrics_primary_routes as route
    where route.exact_key = 'route-duration-overrun'
      and route.enabled
  )
    or public.resolve_lyrics(
      '00000000-0000-4000-8000-000000000001'::uuid,
      'route-duration-overrun',
      null,
      1
    ) ->> 'provider_name' is distinct from 'lrclib' then
    raise exception 'stale enabled Apple route bypassed the read-time timing gate';
  end if;
end;
$assert$;

-- A fully collapsed sparse eleven-line timeline must also stay on LRCLIB.
select pg_temp.write_lrclib(
  'route-collapsed-timeline',
  'LRCLIB collapsed timeline'
);
select pg_temp.complete_apple(
  'route-collapsed-timeline',
  'apple-collapsed-timeline',
  'us',
  'Apple collapsed timeline',
  true,
  180000,
  true,
  E'[00:00.000]One\n[00:00.150]Two\n[00:00.300]Three\n'
    || E'[00:00.450]Four\n[00:00.600]Five\n[00:00.750]Six\n'
    || E'[00:00.900]Seven\n[00:01.050]Eight\n[00:01.200]Nine\n'
    || E'[00:01.350]Ten\n[00:01.500]Eleven'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_refresh jsonb;
begin
  v_refresh := private.refresh_apple_primary_route_for_key(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-collapsed-timeline',
    1
  );
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-collapsed-timeline',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib'
    or v_refresh ->> 'state' is distinct from 'fallback'
    or v_refresh ->> 'reason'
      is distinct from 'collapsed-timeline-coverage'
    or exists (
      select 1
      from public.apple_lyrics_primary_routes as route
      where route.exact_key = 'route-collapsed-timeline'
        and route.enabled
    ) then
    raise exception 'collapsed Apple timeline became primary';
  end if;
end;
$assert$;

-- Short recordings no longer bypass collapse detection. At thirty seconds
-- the duration-relative window is six hundred milliseconds, inclusive.
select pg_temp.write_lrclib(
  'route-short-collapsed-timeline',
  'LRCLIB short collapsed timeline'
);
select pg_temp.complete_apple(
  'route-short-collapsed-timeline',
  'apple-short-collapsed-timeline',
  'us',
  'Apple short collapsed timeline',
  true,
  30000,
  true,
  E'[00:00.000]One\n[00:00.050]Two\n[00:00.100]Three\n'
    || E'[00:00.150]Four\n[00:00.200]Five\n[00:00.250]Six\n'
    || E'[00:00.300]Seven\n[00:00.350]Eight\n[00:00.400]Nine\n'
    || E'[00:00.450]Ten\n[00:00.500]Eleven\n[00:00.600]Twelve'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_refresh jsonb;
begin
  v_refresh := private.refresh_apple_primary_route_for_key(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-short-collapsed-timeline',
    1
  );
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-short-collapsed-timeline',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib'
    or v_refresh ->> 'reason'
      is distinct from 'collapsed-timeline-coverage'
    or exists (
      select 1
      from public.apple_lyrics_primary_routes as route
      where route.exact_key = 'route-short-collapsed-timeline'
        and route.enabled
    ) then
    raise exception 'short collapsed Apple timeline became primary';
  end if;
end;
$assert$;

-- A single plausible outlier must not hide a catastrophically collapsed
-- majority. Mixed-unit projections can otherwise bypass an endpoint-only
-- span check while almost every lyric line still fires at song start.
select pg_temp.write_lrclib(
  'route-collapsed-with-outlier',
  'LRCLIB collapsed with outlier'
);
select pg_temp.complete_apple(
  'route-collapsed-with-outlier',
  'apple-collapsed-with-outlier',
  'us',
  'Apple collapsed with outlier',
  true,
  180000,
  true,
  E'[00:00.000]One\n[00:00.150]Two\n[00:00.300]Three\n'
    || E'[00:00.450]Four\n[00:00.600]Five\n[00:00.750]Six\n'
    || E'[00:00.900]Seven\n[00:01.050]Eight\n[00:01.200]Nine\n'
    || E'[00:01.350]Ten\n[00:01.500]Eleven\n[02:50.000]Outlier'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_refresh jsonb;
begin
  v_refresh := private.refresh_apple_primary_route_for_key(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-collapsed-with-outlier',
    1
  );
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-collapsed-with-outlier',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib'
    or v_refresh ->> 'reason'
      is distinct from 'collapsed-timeline-coverage' then
    raise exception 'collapsed Apple majority escaped through one outlier';
  end if;
end;
$assert$;

-- Two plausible outliers must not hide ten of twelve lines (more than 80%)
-- collapsing into the same opening window. Fixed quantiles miss this
-- asymmetric distribution because their upper percentile lands on an outlier.
select pg_temp.write_lrclib(
  'route-collapsed-with-two-outliers',
  'LRCLIB collapsed with two outliers'
);
select pg_temp.complete_apple(
  'route-collapsed-with-two-outliers',
  'apple-collapsed-with-two-outliers',
  'us',
  'Apple collapsed with two outliers',
  true,
  180000,
  true,
  E'[00:00.000]One\n[00:00.150]Two\n[00:00.300]Three\n'
    || E'[00:00.450]Four\n[00:00.600]Five\n[00:00.750]Six\n'
    || E'[00:00.900]Seven\n[00:01.050]Eight\n[00:01.200]Nine\n'
    || E'[00:01.350]Ten\n[01:00.000]Outlier one\n'
    || E'[02:50.000]Outlier two'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
declare
  v_refresh jsonb;
begin
  v_refresh := private.refresh_apple_primary_route_for_key(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-collapsed-with-two-outliers',
    1
  );
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-collapsed-with-two-outliers',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib'
    or v_refresh ->> 'reason'
      is distinct from 'collapsed-timeline-coverage' then
    raise exception '80-percent Apple collapse escaped through two outliers';
  end if;
end;
$assert$;

-- Do not turn a hard corruption gate into a fuzzy song-shape scorer. A long
-- instrumental intro and outro are both legitimate.
select pg_temp.write_lrclib(
  'route-long-intro-outro',
  'LRCLIB long intro and outro'
);
select pg_temp.complete_apple(
  'route-long-intro-outro',
  'apple-long-intro-outro',
  'us',
  'Apple long intro and outro',
  true,
  180000,
  true,
  E'[02:15.000]Late vocal entrance\n[02:35.000]Last vocal'
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-long-intro-outro',
    null,
    1
  ) ->> 'provider_name' is distinct from 'apple' then
    raise exception 'legitimate long intro/outro was blocked';
  end if;
end;
$assert$;

-- LRCLIB instrumental versus verified Apple text is not an Apple anomaly.
select pg_temp.write_lrclib(
  'route-lrclib-instrumental',
  'unused',
  true
);
select pg_temp.complete_apple(
  'route-lrclib-instrumental',
  'apple-lrclib-instrumental',
  'us',
  'Verified Apple text',
  true
);
set constraints all immediate;
set constraints all deferred;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-lrclib-instrumental',
    null,
    1
  ) ->> 'provider_name' is distinct from 'apple' then
    raise exception 'LRCLIB instrumental incorrectly vetoed verified Apple';
  end if;
end;
$assert$;

-- Rejected Apple binding invalidates the route and leaves LRCLIB intact.
select pg_temp.write_lrclib('route-rejected', 'LRCLIB rejected');
select pg_temp.complete_apple(
  'route-rejected',
  'apple-route-rejected',
  'us',
  'Apple rejected',
  true
);
set constraints all immediate;
set constraints all deferred;
update public.lyrics_bindings as binding
set
  status = 'rejected',
  status_reason = 'sql-test-rejected'
where binding.lookup_key = 'route-rejected'
  and binding.status = 'quarantine'
  and exists (
    select 1
    from public.lyrics_revisions as revision
    where revision.document_id = binding.document_id
      and revision.provider_name = 'apple'
  );
select public.refresh_apple_lyrics_primary_routes(
  '00000000-0000-4000-8000-000000000001'::uuid,
  10000
);
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-rejected',
    null,
    1
  ) ->> 'provider_name' is distinct from 'lrclib' then
    raise exception 'rejected Apple binding still routed';
  end if;
end;
$assert$;

-- The production caller has only RPC execution, not direct access to routing
-- tables. Verify the SECURITY DEFINER boundary under the actual service role.
set local role service_role;
do $assert$
begin
  if public.resolve_lyrics(
    '00000000-0000-4000-8000-000000000001'::uuid,
    'route-basic',
    null,
    1
  ) ->> 'provider_route' is distinct from 'apple-primary-v1' then
    raise exception 'service_role could not resolve the Apple primary route';
  end if;
end;
$assert$;
reset role;

rollback;
