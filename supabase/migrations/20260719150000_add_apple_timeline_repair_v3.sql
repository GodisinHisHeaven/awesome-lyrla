-- Repair only deterministic hard timing anomalies from retained, immutable
-- Apple v2 TTML. The existing v2 RPC surface remains unchanged for rolling
-- workers; v3 uses the same durable lease table with a distinct target.

-- Keep the shared SQL gate in lockstep with the v3 worker validator. The
-- earlier conservative gate exempted sub-minute tracks and fewer than twelve
-- lines; those exemptions let severe short/sparse collapses become primary.
-- Short tracks also need a duration-relative overrun tolerance instead of the
-- long-track thirty-second floor.
create or replace function private.apple_synced_payload_timing_anomaly(
  p_synced_lyrics text,
  p_duration_ms integer
)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_lines text[];
  v_line text;
  v_match text[];
  v_start_ms bigint;
  v_last_nonempty_ms bigint;
  v_nonempty_timestamps bigint[] := array[]::bigint[];
  v_nonempty_lines integer := 0;
  v_duration_tolerance_ms bigint;
  v_collapsed_span_limit_ms bigint;
  v_window_start_index integer := 1;
  v_window_end_index integer;
  v_max_window_lines integer := 0;
  v_required_window_lines integer;
begin
  -- The structural gate owns malformed/static input. Unknown or degenerate
  -- duration metadata carries no trustworthy relative-timing signal.
  if p_synced_lyrics is null
    or btrim(p_synced_lyrics) = ''
    or p_duration_ms is null
    or p_duration_ms <= 0
    or p_duration_ms > 86400000 then
    return null;
  end if;

  v_lines := regexp_split_to_array(
    replace(p_synced_lyrics, E'\r\n', E'\n'),
    E'\n'
  );

  foreach v_line in array v_lines
  loop
    v_match := regexp_match(
      v_line,
      '^\[([0-9]{2,4}):([0-5][0-9])\.([0-9]{3})\](.*)$'
    );
    if v_match is null then
      return null;
    end if;

    if btrim(v_match[4]) <> '' then
      v_start_ms :=
        v_match[1]::bigint * 60000
        + v_match[2]::bigint * 1000
        + v_match[3]::bigint;
      v_last_nonempty_ms := greatest(
        coalesce(v_last_nonempty_ms, v_start_ms),
        v_start_ms
      );
      v_nonempty_timestamps := array_append(
        v_nonempty_timestamps,
        v_start_ms
      );
      v_nonempty_lines := v_nonempty_lines + 1;
    end if;
  end loop;

  if v_last_nonempty_ms is null then
    return null;
  end if;

  v_duration_tolerance_ms := case
    when p_duration_ms < 120000 then
      greatest(
        2000::bigint,
        ceil(p_duration_ms::numeric * 0.25)::bigint
      )
    else
      greatest(
        30000::bigint,
        least(
          120000::bigint,
          ceil(p_duration_ms::numeric * 0.10)::bigint
        )
      )
  end;
  if v_last_nonempty_ms
    > p_duration_ms::bigint + v_duration_tolerance_ms then
    return 'timestamp-duration-overrun';
  end if;

  -- At twelve or more nonempty lines, 80% inside one short window is a
  -- catastrophic majority collapse. Sparse six-to-eleven-line songs require
  -- every line in the window; fewer than six lines are not scored.
  if v_nonempty_lines < 6 then
    return null;
  end if;

  v_collapsed_span_limit_ms := least(
    2000::bigint,
    floor(p_duration_ms::numeric * 0.02)::bigint
  );
  v_required_window_lines := case
    when v_nonempty_lines >= 12 then
      ceil(v_nonempty_lines::numeric * 0.80)::integer
    else v_nonempty_lines
  end;

  select array_agg(sample.start_ms order by sample.start_ms)
  into v_nonempty_timestamps
  from unnest(v_nonempty_timestamps) as sample(start_ms);

  for v_window_end_index in 1..v_nonempty_lines
  loop
    while v_nonempty_timestamps[v_window_end_index]
      - v_nonempty_timestamps[v_window_start_index]
      > v_collapsed_span_limit_ms
    loop
      v_window_start_index := v_window_start_index + 1;
    end loop;
    v_max_window_lines := greatest(
      v_max_window_lines,
      v_window_end_index - v_window_start_index + 1
    );
  end loop;

  if v_max_window_lines >= v_required_window_lines then
    return 'collapsed-timeline-coverage';
  end if;

  return null;
end;
$$;

revoke all on function private.apple_synced_payload_timing_anomaly(
  text,
  integer
) from public, anon, authenticated, service_role;

comment on function private.apple_synced_payload_timing_anomaly(
  text,
  integer
) is
  'Return a fixed hard anomaly for duration overrun or conservative two-level timeline collapse; null is not an audio-alignment quality verdict.';

alter table public.apple_lyrics_reprojection_jobs
  drop constraint apple_lyrics_reprojection_jobs_target_v2;

alter table public.apple_lyrics_reprojection_jobs
  add column source_anomaly_code text;

alter table public.apple_lyrics_reprojection_jobs
  add constraint apple_lyrics_reprojection_jobs_target_version
  check (
    target_projection_version in (
      'apple-ttml-line-model-v2',
      'apple-ttml-line-model-v3'
    )
  ),
  add constraint apple_lyrics_reprojection_jobs_source_anomaly
  check (
    (
      target_projection_version = 'apple-ttml-line-model-v2'
      and source_anomaly_code is null
    )
    or
    (
      target_projection_version = 'apple-ttml-line-model-v3'
      and source_anomaly_code in (
        'timestamp-duration-overrun',
        'collapsed-timeline-coverage'
      )
    )
  );

comment on column
  public.apple_lyrics_reprojection_jobs.source_anomaly_code is
  'Immutable hard timing anomaly that justified a v3 repair job. Null for the rolling-compatible v1-to-v2 reprojection path.';

-- The deployed v2 claim candidate query already filters target=v2, but its
-- expired-lease and ineligible cleanup statements predate the shared v3
-- target. Patch those two statements in place so an old worker polling during
-- the rolling release cannot cancel or dead-letter a v3 job.
do $migration$
declare
  v_function regprocedure :=
    'public.claim_apple_lyrics_reprojection_v2(uuid,text,integer,integer)'::regprocedure;
  v_definition text;
  v_processing_pattern text :=
    E'where job.library_id = p_library_id\n'
    || E'    and job.status = ''processing''';
  v_processing_replacement text :=
    E'where job.library_id = p_library_id\n'
    || E'    and job.target_projection_version = '
    || E'''apple-ttml-line-model-v2''\n'
    || E'    and job.status = ''processing''';
  v_pending_pattern text :=
    E'where job.library_id = p_library_id\n'
    || E'    and (\n'
    || E'      job.status in (''pending'', ''retry_wait'')';
  v_pending_replacement text :=
    E'where job.library_id = p_library_id\n'
    || E'    and job.target_projection_version = '
    || E'''apple-ttml-line-model-v2''\n'
    || E'    and (\n'
    || E'      job.status in (''pending'', ''retry_wait'')';
  v_processing_count integer;
  v_pending_count integer;
begin
  select pg_get_functiondef(v_function)
  into v_definition;

  v_processing_count := (
    char_length(v_definition)
    - char_length(replace(v_definition, v_processing_pattern, ''))
  ) / char_length(v_processing_pattern);
  v_pending_count := (
    char_length(v_definition)
    - char_length(replace(v_definition, v_pending_pattern, ''))
  ) / char_length(v_pending_pattern);

  if v_processing_count <> 1 or v_pending_count <> 1 then
    raise exception 'unexpected claim_apple_lyrics_reprojection_v2 definition; refusing unsafe rolling patch'
      using errcode = '55000';
  end if;

  v_definition := replace(
    v_definition,
    v_processing_pattern,
    v_processing_replacement
  );
  v_definition := replace(
    v_definition,
    v_pending_pattern,
    v_pending_replacement
  );
  execute v_definition;
end;
$migration$;

alter table public.apple_lyrics_v2_completion_evidence
  drop constraint apple_lyrics_v2_completion_evidence_kind;

alter table public.apple_lyrics_v2_completion_evidence
  add constraint apple_lyrics_v2_completion_evidence_kind
  check (
    completion_kind in (
      'backfill',
      'reprojection',
      'timeline-repair'
    )
  );

comment on table public.apple_lyrics_v2_completion_evidence is
  'Append-only proof that an immutable Apple v2-or-later primary artifact completed through a leased backfill, retained-TTML reprojection, or deterministic timeline repair RPC.';

-- Preserve the stable helper signature used throughout the Apple-primary
-- route implementation while widening its evidence boundary to v3.
create or replace function private.is_completed_apple_v2_artifact(
  p_library_id uuid,
  p_binding_id uuid,
  p_revision_id uuid,
  p_artifact_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.lyrics_source_artifacts as artifact
    join public.lyrics_revisions as revision
      on revision.id = artifact.revision_id
    join public.lyrics_documents as document
      on document.id = revision.document_id
      and document.library_id = artifact.library_id
    join public.lyrics_bindings as binding
      on binding.library_id = artifact.library_id
      and binding.document_id = document.id
      and binding.binding_kind = 'exact'
      and binding.key_version = artifact.key_version
      and binding.lookup_key = artifact.exact_key
    where artifact.library_id = p_library_id
      and artifact.id = p_artifact_id
      and revision.id = p_revision_id
      and binding.id = p_binding_id
      and artifact.provider_name = 'apple'
      and artifact.projection_version in (
        'apple-ttml-line-model-v2',
        'apple-ttml-line-model-v3'
      )
      and revision.provider_name = 'apple'
      and revision.provider_track_id = artifact.provider_track_id
      and (
        exists (
          select 1
          from public.apple_lyrics_v2_completion_evidence as evidence
          where evidence.library_id = artifact.library_id
            and evidence.artifact_id = artifact.id
            and evidence.revision_id = revision.id
        )
        or exists (
          select 1
          from public.apple_lyrics_backfill_jobs as source_job
          where source_job.library_id = artifact.library_id
            and source_job.status = 'completed'
            and source_job.artifact_id = artifact.id
            and source_job.revision_id = revision.id
        )
        or exists (
          select 1
          from public.apple_lyrics_reprojection_jobs as reprojection
          where reprojection.library_id = artifact.library_id
            and reprojection.status = 'completed'
            and reprojection.result_artifact_id = artifact.id
            and reprojection.result_revision_id = revision.id
        )
      )
  );
$$;

comment on function private.is_completed_apple_v2_artifact(
  uuid,
  uuid,
  uuid,
  uuid
) is
  'Rolling-compatible evidence boundary for completed Apple v2 and deterministic v3 artifacts eligible for immutable primary routing.';

-- Full operator refresh must discover v3-only keys even when no materialized
-- route row exists (for example after an audited route rebuild).
do $migration$
declare
  v_function regprocedure :=
    'public.refresh_apple_lyrics_primary_routes(uuid,integer)'::regprocedure;
  v_definition text;
  v_pattern text :=
    E'and artifact.projection_version = '
    || E'''apple-ttml-line-model-v2''';
  v_replacement text :=
    E'and artifact.projection_version in (\n'
    || E'          ''apple-ttml-line-model-v2'',\n'
    || E'          ''apple-ttml-line-model-v3''\n'
    || E'        )';
  v_count integer;
begin
  select pg_get_functiondef(v_function)
  into v_definition;
  v_count := (
    char_length(v_definition)
    - char_length(replace(v_definition, v_pattern, ''))
  ) / char_length(v_pattern);
  if v_count <> 1 then
    raise exception 'unexpected refresh_apple_lyrics_primary_routes definition; refusing unsafe v3 patch'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_pattern, v_replacement);
end;
$migration$;

comment on function public.refresh_apple_lyrics_primary_routes(
  uuid,
  integer
) is
  'Idempotently recompute immutable Apple-primary pins from completed v2/v3 evidence. Multiple Apple documents fail closed; one document uses its newest source snapshot before quality validation.';

create function private.apple_synced_payload_line_texts(
  p_synced_lyrics text
)
returns text[]
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_result text[] := array[]::text[];
  v_line text;
  v_match text[];
begin
  if p_synced_lyrics is null or btrim(p_synced_lyrics) = '' then
    return null;
  end if;

  foreach v_line in array regexp_split_to_array(
    replace(p_synced_lyrics, E'\r\n', E'\n'),
    E'\n'
  )
  loop
    v_match := regexp_match(
      v_line,
      '^\[[0-9]{2,4}:[0-5][0-9]\.[0-9]{3}\](.*)$'
    );
    if v_match is null then
      return null;
    end if;
    v_result := array_append(v_result, v_match[1]);
  end loop;

  return v_result;
end;
$$;

revoke all on function private.apple_synced_payload_line_texts(text)
  from public, anon, authenticated, service_role;

-- A repair source must still be the newest completed snapshot for the one
-- unambiguous Apple document. A successful v3 descendant makes its v2 parent
-- immediately ineligible, preventing repair loops.
create function private.is_apple_ttml_v2_timeline_repair_eligible(
  p_library_id uuid,
  p_artifact_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.lyrics_source_artifacts as artifact
    join public.lyrics_revisions as revision
      on revision.id = artifact.revision_id
    join public.lyrics_documents as document
      on document.id = revision.document_id
      and document.library_id = artifact.library_id
    join public.lyrics_bindings as binding
      on binding.library_id = artifact.library_id
      and binding.document_id = document.id
      and binding.binding_kind = 'exact'
      and binding.key_version = artifact.key_version
      and binding.lookup_key = artifact.exact_key
    where artifact.library_id = p_library_id
      and artifact.id = p_artifact_id
      and artifact.provider_name = 'apple'
      and artifact.projection_version = 'apple-ttml-line-model-v2'
      and binding.status = 'quarantine'
      and binding.selection_method = 'provider'
      and binding.selection_version is null
      and revision.provider_name = 'apple'
      and revision.provider_track_id = artifact.provider_track_id
      and private.is_valid_apple_lyrics_track_metadata(binding.raw_metadata)
      and octet_length(binding.raw_metadata::text) <= 16384
      and private.apple_primary_completed_document_count(
        artifact.library_id,
        artifact.exact_key,
        artifact.key_version
      ) = 1
      and private.is_completed_apple_v2_artifact(
        artifact.library_id,
        binding.id,
        revision.id,
        artifact.id
      )
      and private.apple_primary_candidate_rejection_code(
        artifact.library_id,
        binding.id,
        revision.id,
        artifact.id
      ) in (
        'timestamp-duration-overrun',
        'collapsed-timeline-coverage'
      )
      and not exists (
        select 1
        from public.lyrics_source_artifacts as newer
        join public.lyrics_revisions as newer_revision
          on newer_revision.id = newer.revision_id
        join public.lyrics_bindings as newer_binding
          on newer_binding.library_id = newer.library_id
          and newer_binding.document_id = newer_revision.document_id
          and newer_binding.binding_kind = 'exact'
          and newer_binding.key_version = newer.key_version
          and newer_binding.lookup_key = newer.exact_key
        left join public.lyrics_source_artifacts as newer_source
          on newer_source.library_id = newer.library_id
          and newer_source.id = newer.derived_from_artifact_id
        left join public.lyrics_source_artifacts as artifact_source
          on artifact_source.library_id = artifact.library_id
          and artifact_source.id = artifact.derived_from_artifact_id
        where newer.library_id = artifact.library_id
          and newer.exact_key = artifact.exact_key
          and newer.key_version = artifact.key_version
          and newer_revision.document_id = revision.document_id
          and private.is_completed_apple_v2_artifact(
            newer.library_id,
            newer_binding.id,
            newer_revision.id,
            newer.id
          )
          and (
            coalesce(newer_source.fetched_at, newer.fetched_at),
            newer_revision.revision_number,
            coalesce(newer_source.id, newer.id),
            newer.fetched_at,
            newer.id
          ) > (
            coalesce(artifact_source.fetched_at, artifact.fetched_at),
            revision.revision_number,
            coalesce(artifact_source.id, artifact.id),
            artifact.fetched_at,
            artifact.id
          )
      )
  );
$$;

revoke all on function
  private.is_apple_ttml_v2_timeline_repair_eligible(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.enqueue_apple_lyrics_timeline_repair_v3(
  p_library_id uuid,
  p_limit integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted integer := 0;
  v_remaining bigint := 0;
begin
  if not exists (
    select 1
    from public.lyrics_libraries as library
    where library.id = p_library_id
  ) then
    raise exception 'lyrics library does not exist'
      using errcode = '23503';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'limit must be between 1 and 10000'
      using errcode = '22023';
  end if;

  insert into public.apple_lyrics_reprojection_jobs (
    library_id,
    source_artifact_id,
    target_projection_version,
    source_anomaly_code
  )
  select
    artifact.library_id,
    artifact.id,
    'apple-ttml-line-model-v3',
    private.apple_synced_payload_timing_anomaly(
      revision.synced_lyrics,
      revision.duration_ms
    )
  from public.lyrics_source_artifacts as artifact
  join public.lyrics_revisions as revision
    on revision.id = artifact.revision_id
  where artifact.library_id = p_library_id
    and private.is_apple_ttml_v2_timeline_repair_eligible(
      artifact.library_id,
      artifact.id
    )
    and not exists (
      select 1
      from public.apple_lyrics_reprojection_jobs as existing
      where existing.library_id = artifact.library_id
        and existing.source_artifact_id = artifact.id
        and existing.target_projection_version =
          'apple-ttml-line-model-v3'
    )
  order by artifact.fetched_at, artifact.created_at, artifact.id
  limit p_limit
  on conflict (
    library_id,
    source_artifact_id,
    target_projection_version
  ) do nothing;

  get diagnostics v_inserted = row_count;

  select count(*)
  into v_remaining
  from public.lyrics_source_artifacts as artifact
  where artifact.library_id = p_library_id
    and private.is_apple_ttml_v2_timeline_repair_eligible(
      artifact.library_id,
      artifact.id
    )
    and not exists (
      select 1
      from public.apple_lyrics_reprojection_jobs as existing
      where existing.library_id = artifact.library_id
        and existing.source_artifact_id = artifact.id
        and existing.target_projection_version =
          'apple-ttml-line-model-v3'
    );

  return jsonb_build_object(
    'target_projection_version', 'apple-ttml-line-model-v3',
    'enqueued', v_inserted,
    'remaining', v_remaining
  );
end;
$$;

comment on function public.enqueue_apple_lyrics_timeline_repair_v3(
  uuid,
  integer
) is
  'Idempotently enqueue latest anomalous completed v2 artifacts for deterministic v3 repair. Existing terminal jobs are audit records and are never reset; a future repair algorithm must use a new target projection version.';

create function public.claim_apple_lyrics_timeline_repair_v3(
  p_library_id uuid,
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_worker_id text := nullif(btrim(p_worker_id), '');
  v_jobs jsonb;
begin
  if not exists (
    select 1
    from public.lyrics_libraries as library
    where library.id = p_library_id
  ) then
    raise exception 'lyrics library does not exist'
      using errcode = '23503';
  end if;

  if v_worker_id is null or char_length(v_worker_id) > 120 then
    raise exception 'worker_id must contain between 1 and 120 characters'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'limit must be between 1 and 10'
      using errcode = '22023';
  end if;

  if p_lease_seconds is null
    or p_lease_seconds < 30
    or p_lease_seconds > 900 then
    raise exception 'lease_seconds must be between 30 and 900'
      using errcode = '22023';
  end if;

  update public.apple_lyrics_reprojection_jobs as job
  set
    status = 'dead_letter',
    lease_token = null,
    lease_owner = null,
    lease_expires_at = null,
    last_error_code = coalesce(job.last_error_code, 'lease-expired'),
    completed_at = v_now,
    updated_at = v_now
  where job.library_id = p_library_id
    and job.target_projection_version = 'apple-ttml-line-model-v3'
    and job.status = 'processing'
    and job.lease_expires_at <= v_now
    and job.attempt_count >= job.max_attempts;

  update public.apple_lyrics_reprojection_jobs as job
  set
    status = 'cancelled',
    lease_token = null,
    lease_owner = null,
    lease_expires_at = null,
    last_error_code = 'source-no-longer-eligible',
    completed_at = v_now,
    updated_at = v_now
  where job.library_id = p_library_id
    and job.target_projection_version = 'apple-ttml-line-model-v3'
    and (
      job.status in ('pending', 'retry_wait')
      or (
        job.status = 'processing'
        and job.lease_expires_at <= v_now
      )
    )
    and (
      not private.is_apple_ttml_v2_timeline_repair_eligible(
        job.library_id,
        job.source_artifact_id
      )
      or job.source_anomaly_code is distinct from (
        select private.apple_synced_payload_timing_anomaly(
          revision.synced_lyrics,
          revision.duration_ms
        )
        from public.lyrics_source_artifacts as artifact
        join public.lyrics_revisions as revision
          on revision.id = artifact.revision_id
        where artifact.library_id = job.library_id
          and artifact.id = job.source_artifact_id
      )
    );

  with candidates as (
    select job.id
    from public.apple_lyrics_reprojection_jobs as job
    where job.library_id = p_library_id
      and job.target_projection_version = 'apple-ttml-line-model-v3'
      and job.attempt_count < job.max_attempts
      and private.is_apple_ttml_v2_timeline_repair_eligible(
        job.library_id,
        job.source_artifact_id
      )
      and job.source_anomaly_code = (
        select private.apple_synced_payload_timing_anomaly(
          revision.synced_lyrics,
          revision.duration_ms
        )
        from public.lyrics_source_artifacts as artifact
        join public.lyrics_revisions as revision
          on revision.id = artifact.revision_id
        where artifact.library_id = job.library_id
          and artifact.id = job.source_artifact_id
      )
      and (
        (
          job.status in ('pending', 'retry_wait')
          and job.next_attempt_at <= v_now
        )
        or (
          job.status = 'processing'
          and job.lease_expires_at <= v_now
        )
      )
    order by job.next_attempt_at, job.created_at, job.id
    limit p_limit
    for update of job skip locked
  ),
  claimed as (
    update public.apple_lyrics_reprojection_jobs as job
    set
      status = 'processing',
      attempt_count = job.attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_owner = v_worker_id,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      last_error_code = null,
      updated_at = v_now
    from candidates
    where job.id = candidates.id
    returning job.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'job_id', claimed.id,
        'lease_token', claimed.lease_token,
        'lease_expires_at', claimed.lease_expires_at,
        'attempt_count', claimed.attempt_count,
        'max_attempts', claimed.max_attempts,
        'target_projection_version', claimed.target_projection_version,
        'source_anomaly_code', claimed.source_anomaly_code,
        'source_artifact', jsonb_build_object(
          'id', artifact.id,
          'revision_id', artifact.revision_id,
          'provider_name', artifact.provider_name,
          'provider_track_id', artifact.provider_track_id,
          'storefront', artifact.storefront,
          'exact_key', artifact.exact_key,
          'key_version', artifact.key_version,
          'locale', artifact.locale,
          'timing_mode', artifact.timing_mode,
          'recording_variant', artifact.recording_variant,
          'projection_version', artifact.projection_version,
          'raw_ttml', artifact.raw_ttml,
          'content_hash', artifact.content_hash,
          'byte_size', artifact.byte_size,
          'fetched_at', artifact.fetched_at
        ),
        'track_metadata', binding.raw_metadata,
        'identity_proof', jsonb_build_object(
          'proof_version',
            revision.provenance -> 'exact_identity_proof_version',
          'evidence',
            revision.provenance -> 'exact_identity_evidence',
          'provider_name', 'apple',
          'provider_track_id', artifact.provider_track_id,
          'exact_key', artifact.exact_key,
          'key_version', artifact.key_version
        )
      )
      order by claimed.created_at, claimed.id
    ),
    '[]'::jsonb
  )
  into v_jobs
  from claimed
  join public.lyrics_source_artifacts as artifact
    on artifact.library_id = claimed.library_id
    and artifact.id = claimed.source_artifact_id
  join public.lyrics_revisions as revision
    on revision.id = artifact.revision_id
  join public.lyrics_bindings as binding
    on binding.library_id = artifact.library_id
    and binding.document_id = revision.document_id
    and binding.binding_kind = 'exact'
    and binding.key_version = artifact.key_version
    and binding.lookup_key = artifact.exact_key;

  return v_jobs;
end;
$$;

create function public.fail_apple_lyrics_timeline_repair_v3(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.apple_lyrics_reprojection_jobs as job
    where job.id = p_job_id
      and job.target_projection_version = 'apple-ttml-line-model-v3'
  ) then
    raise exception 'Apple v3 timeline repair job does not exist'
      using errcode = '22023';
  end if;

  return public.fail_apple_lyrics_reprojection_v2(
    p_job_id,
    p_lease_token,
    p_error_code,
    p_retryable,
    p_retry_after_seconds
  );
end;
$$;

create function public.complete_apple_lyrics_timeline_repair_v3(
  p_job_id uuid,
  p_lease_token uuid,
  p_payload jsonb,
  p_provenance jsonb,
  p_timing_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_row record;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_provenance jsonb := coalesce(p_provenance, '{}'::jsonb);
  v_timing_mode text := lower(
    coalesce(nullif(btrim(p_timing_mode), ''), 'unknown')
  );
  v_repair_strategy text := lower(
    nullif(
      btrim(
        coalesce(
          p_provenance ->> 'repair_strategy',
          p_provenance ->> 'timeline_repair_method',
          ''
        )
      ),
      ''
    )
  );
  v_repaired_synced text;
  v_repaired_plain text;
  v_repaired_is_instrumental boolean;
  v_repaired_duration integer;
  v_repaired_language text;
  v_source_anomaly text;
  v_source_idempotency text;
  v_write_result jsonb;
  v_document_id uuid;
  v_revision_id uuid;
  v_normalized_hash text;
  v_artifact_identity text;
  v_artifact_id uuid;
  v_active_binding_before uuid;
  v_active_binding_after uuid;
  v_document_has_active_binding boolean;
  v_binding_status public.lyrics_status;
  v_binding_method public.lyrics_acquisition;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job_id and lease_token are required'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_payload) <> 'object'
    or octet_length(v_payload::text) > 1048576 then
    raise exception 'payload must be a JSON object no larger than 1048576 bytes'
      using errcode = '22023';
  end if;

  if v_payload ?| array['ttml', 'raw_ttml', 'rawTtml'] then
    raise exception 'raw TTML must remain only in lyrics_source_artifacts'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_provenance) <> 'object'
    or octet_length(v_provenance::text) > 16384 then
    raise exception 'provenance must be a JSON object no larger than 16384 bytes'
      using errcode = '22023';
  end if;

  if v_timing_mode not in ('line', 'word', 'syllable') then
    raise exception 'v3 timeline repair requires synchronized timing'
      using errcode = '22023';
  end if;

  if v_repair_strategy is distinct from 'word-span-line-start-v1' then
    raise exception 'repair_strategy is not an approved deterministic repair'
      using errcode = '22023';
  end if;

  v_repaired_synced := coalesce(
    v_payload ->> 'synced_lyrics',
    v_payload ->> 'syncedLyrics'
  );
  if v_repaired_synced is null
    or btrim(v_repaired_synced, E' \t\n\r\f') = '' then
    raise exception 'v3 timeline repair requires synced lyrics'
      using errcode = '22023';
  end if;

  if v_repaired_synced is distinct from
    btrim(v_repaired_synced, E' \t\n\r\f') then
    raise exception 'v3 repair synced lyrics must not have outer whitespace'
      using errcode = '23514';
  end if;

  if v_provenance ->> 'body_format'
    is distinct from 'apple-ttml-line-projection-v3-ms' then
    raise exception 'body_format does not match the v3 normalized payload'
      using errcode = '22023';
  end if;

  select
    job.id as job_id,
    job.library_id,
    job.status,
    job.lease_token,
    job.lease_expires_at,
    job.target_projection_version,
    job.source_anomaly_code,
    artifact.id as source_artifact_id,
    artifact.revision_id as source_revision_id,
    artifact.provider_track_id,
    artifact.storefront,
    artifact.exact_key,
    artifact.key_version,
    artifact.locale,
    artifact.recording_variant,
    artifact.raw_ttml,
    artifact.content_hash as artifact_content_hash,
    artifact.byte_size as artifact_byte_size,
    artifact.fetched_at as artifact_fetched_at,
    revision.document_id as source_document_id,
    revision.content_hash as source_normalized_hash,
    revision.synced_lyrics as source_synced_lyrics,
    revision.plain_lyrics as source_plain_lyrics,
    revision.is_instrumental as source_is_instrumental,
    revision.duration_ms as source_duration_ms,
    revision.language_code as source_language_code,
    revision.provenance as source_provenance,
    document.source_identity,
    binding.raw_metadata
  into v_row
  from public.apple_lyrics_reprojection_jobs as job
  join public.lyrics_source_artifacts as artifact
    on artifact.library_id = job.library_id
    and artifact.id = job.source_artifact_id
  join public.lyrics_revisions as revision
    on revision.id = artifact.revision_id
  join public.lyrics_documents as document
    on document.library_id = artifact.library_id
    and document.id = revision.document_id
  join public.lyrics_bindings as binding
    on binding.library_id = artifact.library_id
    and binding.document_id = document.id
    and binding.binding_kind = 'exact'
    and binding.key_version = artifact.key_version
    and binding.lookup_key = artifact.exact_key
  where job.id = p_job_id
  for update of job;

  if not found then
    raise exception 'Apple v3 timeline repair job or source artifact does not exist'
      using errcode = '22023';
  end if;

  if v_row.status <> 'processing'
    or v_row.lease_token is distinct from p_lease_token
    or v_row.lease_expires_at <= v_now then
    raise exception 'Apple v3 timeline repair lease is no longer valid'
      using errcode = '55000';
  end if;

  perform 1
  from public.lyrics_documents as document
  where document.library_id = v_row.library_id
    and document.id = v_row.source_document_id
  for update;

  if not found then
    raise exception 'Apple v3 repair source document no longer exists'
      using errcode = '55000';
  end if;

  perform binding.id
  from public.lyrics_bindings as binding
  where binding.library_id = v_row.library_id
    and binding.document_id = v_row.source_document_id
  order by binding.id
  for update;

  if v_row.target_projection_version <> 'apple-ttml-line-model-v3'
    or not private.is_apple_ttml_v2_timeline_repair_eligible(
      v_row.library_id,
      v_row.source_artifact_id
    ) then
    raise exception 'source artifact is not eligible for v3 timeline repair'
      using errcode = '55000';
  end if;

  v_source_anomaly := private.apple_synced_payload_timing_anomaly(
    v_row.source_synced_lyrics,
    v_row.source_duration_ms
  );
  if v_source_anomaly is null
    or v_source_anomaly not in (
      'timestamp-duration-overrun',
      'collapsed-timeline-coverage'
    )
    or v_source_anomaly is distinct from v_row.source_anomaly_code then
    raise exception 'source timing anomaly no longer matches the repair job'
      using errcode = '55000';
  end if;

  if p_provenance ->> 'timeline_validation_version'
      is distinct from 'apple-timeline-validation-v1'
    or p_provenance ->> 'timeline_validation_outcome'
      is distinct from 'repaired'
    or p_provenance ->> 'timeline_source_anomaly'
      is distinct from v_source_anomaly
    or p_provenance ->> 'timeline_repair_method'
      is distinct from v_repair_strategy then
    raise exception 'v3 repair timeline evidence does not match its source'
      using errcode = '23514';
  end if;

  v_repaired_plain := coalesce(
    v_payload ->> 'plain_lyrics',
    v_payload ->> 'plainLyrics'
  );
  if v_repaired_plain is not null
    and v_repaired_plain is distinct from
      btrim(v_repaired_plain, E' \t\n\r\f') then
    raise exception 'v3 repair plain lyrics must not have outer whitespace'
      using errcode = '23514';
  end if;

  v_repaired_is_instrumental := coalesce(
    nullif(
      coalesce(
        v_payload ->> 'is_instrumental',
        v_payload ->> 'instrumental'
      ),
      ''
    )::boolean,
    false
  );
  v_repaired_duration := nullif(
    coalesce(
      v_payload ->> 'duration_ms',
      v_payload ->> 'durationMs'
    ),
    ''
  )::integer;
  v_repaired_language := nullif(
    btrim(
      coalesce(
        v_payload ->> 'language_code',
        v_payload ->> 'languageCode'
      )
    ),
    ''
  );

  if v_repaired_plain is distinct from v_row.source_plain_lyrics
    or v_repaired_is_instrumental
      is distinct from v_row.source_is_instrumental
    or v_repaired_duration is distinct from v_row.source_duration_ms
    or v_repaired_language is distinct from v_row.source_language_code then
    raise exception 'v3 repair may change only synchronized timestamps'
      using errcode = '23514';
  end if;

  if private.apple_synced_payload_line_texts(v_repaired_synced)
    is distinct from private.apple_synced_payload_line_texts(
      v_row.source_synced_lyrics
    ) then
    raise exception 'v3 repair changed lyric text, order, or line count'
      using errcode = '23514';
  end if;

  if v_repaired_synced = v_row.source_synced_lyrics then
    raise exception 'v3 repair did not change the synchronized timeline'
      using errcode = '23514';
  end if;

  select binding.id
  into v_active_binding_before
  from public.lyrics_bindings as binding
  where binding.library_id = v_row.library_id
    and binding.binding_kind = 'exact'
    and binding.key_version = v_row.key_version
    and binding.lookup_key = v_row.exact_key
    and binding.status = 'active';

  v_source_idempotency := nullif(
    btrim(v_row.source_provenance ->> 'idempotency_key'),
    ''
  );
  if v_source_idempotency is null
    or v_row.source_identity <> 'custom:' || v_source_idempotency then
    raise exception 'source revision has no stable Apple document identity'
      using errcode = '23514';
  end if;

  -- Caller provenance supplies only the bounded strategy identifier and
  -- optional diagnostics. All trust, lineage, and anomaly fields are pinned
  -- to the leased immutable source.
  v_provenance := (
    v_provenance
      - 'provider_name'
      - 'providerName'
      - 'provider_track_id'
      - 'providerTrackId'
      - 'idempotency_key'
      - 'idempotencyKey'
      - 'selection_version'
      - 'selectionVersion'
      - 'artifact_sha256'
      - 'artifactSha256'
      - 'status_reason'
      - 'statusReason'
      - 'exact_identity_proof_version'
      - 'exactIdentityProofVersion'
      - 'exact_identity_evidence'
      - 'exactIdentityEvidence'
      - 'source_artifact_id'
      - 'sourceArtifactId'
      - 'source_revision_id'
      - 'sourceRevisionId'
      - 'timeline_repair_job_id'
      - 'timelineRepairJobId'
      - 'source_anomaly_code'
      - 'sourceAnomalyCode'
      - 'repair_algorithm_version'
      - 'repairAlgorithmVersion'
      - 'repair_strategy'
      - 'repairStrategy'
      - 'timeline_repair_method'
      - 'timelineRepairMethod'
      - 'timeline_source_anomaly'
      - 'timelineSourceAnomaly'
      - 'timeline_validation_version'
      - 'timelineValidationVersion'
      - 'timeline_validation_outcome'
      - 'timelineValidationOutcome'
      - 'projection_version'
      - 'projectionVersion'
      - 'body_format'
      - 'bodyFormat'
      - 'sourceFormat'
      - 'timingMode'
      - 'recordingVariant'
  ) || jsonb_build_object(
    'provider_name', 'apple',
    'provider_track_id', v_row.provider_track_id,
    'idempotency_key', v_source_idempotency,
    'source_format', 'ttml',
    'storefront', v_row.storefront,
    'locale', v_row.locale,
    'timing_mode', v_timing_mode,
    'recording_variant', v_row.recording_variant,
    'artifact_sha256', v_row.artifact_content_hash,
    'source_artifact_id', v_row.source_artifact_id,
    'source_revision_id', v_row.source_revision_id,
    'timeline_repair_job_id', v_row.job_id,
    'source_anomaly_code', v_source_anomaly,
    'repair_algorithm_version', 'apple-ttml-timeline-repair-v1',
    'repair_strategy', v_repair_strategy,
    'timeline_repair_method', v_repair_strategy,
    'timeline_source_anomaly', v_source_anomaly,
    'timeline_validation_version', 'apple-timeline-validation-v1',
    'timeline_validation_outcome', 'repaired',
    'projection_version', v_row.target_projection_version,
    'body_format', 'apple-ttml-line-projection-v3-ms',
    'exact_identity_proof_version',
      v_row.source_provenance -> 'exact_identity_proof_version',
    'exact_identity_evidence',
      v_row.source_provenance -> 'exact_identity_evidence',
    'status_reason', 'automatic-apple-exact-quarantine:timeline-repair-v3'
  );

  if octet_length(v_provenance::text) > 16384 then
    raise exception 'merged provenance must not exceed 16384 bytes'
      using errcode = '22023';
  end if;

  if private.apple_synced_payload_hard_anomaly(
    v_repaired_synced,
    v_repaired_plain,
    v_repaired_is_instrumental,
    v_provenance
  ) is not null then
    raise exception 'v3 repair failed the structural timing gate'
      using errcode = '23514';
  end if;

  if private.apple_synced_payload_timing_anomaly(
    v_repaired_synced,
    v_repaired_duration
  ) is not null then
    raise exception 'v3 repair still contains a hard timing anomaly'
      using errcode = '23514';
  end if;

  v_write_result := public.upsert_lyrics_document(
    v_row.library_id,
    v_row.exact_key,
    null,
    v_row.key_version,
    v_row.raw_metadata,
    v_payload,
    v_provenance,
    'provider'::public.lyrics_acquisition,
    'quarantine'::public.lyrics_status
  );

  v_document_id := nullif(v_write_result ->> 'document_id', '')::uuid;
  v_revision_id := nullif(v_write_result ->> 'revision_id', '')::uuid;
  v_normalized_hash := nullif(v_write_result ->> 'content_hash', '');

  -- upsert_lyrics_document acquires the shared Exact-key advisory lock. Check
  -- eligibility again while that lock is now held so a concurrently completed
  -- newer snapshot or second Apple document cannot be repaired after the
  -- earlier pre-write check.
  if not private.is_apple_ttml_v2_timeline_repair_eligible(
    v_row.library_id,
    v_row.source_artifact_id
  ) then
    raise exception 'source artifact lost v3 repair eligibility during completion'
      using errcode = '40001';
  end if;

  if v_document_id is distinct from v_row.source_document_id
    or v_revision_id is null
    or v_revision_id = v_row.source_revision_id
    or v_normalized_hash is null
    or v_normalized_hash !~ '^[0-9a-f]{64}$'
    or v_normalized_hash = v_row.source_normalized_hash then
    raise exception 'v3 repair did not produce a new Apple revision'
      using errcode = '55000';
  end if;

  select binding.status, binding.selection_method
  into v_binding_status, v_binding_method
  from public.lyrics_bindings as binding
  where binding.library_id = v_row.library_id
    and binding.document_id = v_document_id
    and binding.binding_kind = 'exact'
    and binding.key_version = v_row.key_version
    and binding.lookup_key = v_row.exact_key;

  if v_binding_status <> 'quarantine'
    or v_binding_method <> 'provider' then
    raise exception 'v3 Apple repair binding escaped quarantine'
      using errcode = '23514';
  end if;

  select binding.id
  into v_active_binding_after
  from public.lyrics_bindings as binding
  where binding.library_id = v_row.library_id
    and binding.binding_kind = 'exact'
    and binding.key_version = v_row.key_version
    and binding.lookup_key = v_row.exact_key
    and binding.status = 'active';

  if v_active_binding_after is distinct from v_active_binding_before then
    raise exception 'v3 repair changed the active serving binding'
      using errcode = '23514';
  end if;

  select exists (
    select 1
    from public.lyrics_bindings as binding
    where binding.library_id = v_row.library_id
      and binding.document_id = v_document_id
      and binding.status = 'active'
  )
  into v_document_has_active_binding;

  if v_document_has_active_binding then
    raise exception 'v3 repair document became actively served'
      using errcode = '23514';
  end if;

  v_artifact_identity := encode(
    extensions.digest(
      convert_to(
        jsonb_build_array(
          'ttml-artifact-v3-timeline-repair',
          'apple',
          v_row.source_artifact_id,
          v_row.target_projection_version,
          v_source_anomaly,
          v_repair_strategy,
          v_row.artifact_content_hash,
          v_normalized_hash,
          v_revision_id
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.lyrics_source_artifacts (
    library_id,
    revision_id,
    provider_name,
    provider_track_id,
    storefront,
    exact_key,
    key_version,
    locale,
    timing_mode,
    recording_variant,
    projection_version,
    raw_ttml,
    content_hash,
    byte_size,
    artifact_identity,
    fetched_at,
    derived_from_artifact_id
  )
  values (
    v_row.library_id,
    v_revision_id,
    'apple',
    v_row.provider_track_id,
    v_row.storefront,
    v_row.exact_key,
    v_row.key_version,
    v_row.locale,
    v_timing_mode,
    v_row.recording_variant,
    v_row.target_projection_version,
    v_row.raw_ttml,
    v_row.artifact_content_hash,
    v_row.artifact_byte_size,
    v_artifact_identity,
    v_row.artifact_fetched_at,
    v_row.source_artifact_id
  )
  on conflict (library_id, artifact_identity) do nothing
  returning id into v_artifact_id;

  if v_artifact_id is null then
    select artifact.id
    into v_artifact_id
    from public.lyrics_source_artifacts as artifact
    where artifact.library_id = v_row.library_id
      and artifact.artifact_identity = v_artifact_identity
      and artifact.revision_id = v_revision_id
      and artifact.derived_from_artifact_id = v_row.source_artifact_id
      and artifact.projection_version = v_row.target_projection_version;
  end if;

  if v_artifact_id is null then
    raise exception 'v3 Apple TTML artifact was not persisted'
      using errcode = '55000';
  end if;

  update public.apple_lyrics_reprojection_jobs as job
  set
    status = 'completed',
    lease_token = null,
    lease_owner = null,
    lease_expires_at = null,
    last_error_code = null,
    result_document_id = v_document_id,
    result_revision_id = v_revision_id,
    result_artifact_id = v_artifact_id,
    completed_at = v_now,
    updated_at = v_now
  where job.id = v_row.job_id
    and job.status = 'processing'
    and job.lease_token = p_lease_token
    and job.lease_expires_at > v_now;

  if not found then
    raise exception 'Apple v3 repair lease was lost before commit'
      using errcode = '40001';
  end if;

  insert into public.apple_lyrics_v2_completion_evidence (
    library_id,
    artifact_id,
    revision_id,
    completion_kind,
    completion_job_id,
    completed_at
  )
  values (
    v_row.library_id,
    v_artifact_id,
    v_revision_id,
    'timeline-repair',
    v_row.job_id,
    v_now
  )
  on conflict (library_id, artifact_id, revision_id) do nothing;

  perform private.refresh_apple_primary_route_for_key(
    v_row.library_id,
    v_row.exact_key,
    v_row.key_version
  );

  return jsonb_build_object(
    'job_id', v_row.job_id,
    'status', 'completed',
    'source_artifact_id', v_row.source_artifact_id,
    'document_id', v_document_id,
    'revision_id', v_revision_id,
    'artifact_id', v_artifact_id,
    'target_projection_version', v_row.target_projection_version,
    'normalized_content_hash', v_normalized_hash,
    'artifact_content_hash', v_row.artifact_content_hash,
    'artifact_bytes', v_row.artifact_byte_size,
    'effective_status', 'quarantine',
    'serving_binding_unchanged', true
  );
end;
$$;

-- Clone the deployed v2 direct completion under a private implementation
-- name. The public v3 wrapper below adds the v3 body-format contract without
-- changing the v2 signature or behavior during a rolling release.
do $migration$
declare
  v_function regprocedure :=
    'public.complete_apple_lyrics_backfill_v2(uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text,text,text)'::regprocedure;
  v_definition text;
  v_function_name_count integer;
  v_line_model_count integer;
  v_artifact_tag_count integer;
  v_status_reason_count integer;
begin
  select pg_get_functiondef(v_function)
  into v_definition;

  v_function_name_count := (
    char_length(v_definition)
    - char_length(
      replace(
        v_definition,
        'public.complete_apple_lyrics_backfill_v2(',
        ''
      )
    )
  ) / char_length('public.complete_apple_lyrics_backfill_v2(');
  v_line_model_count := (
    char_length(v_definition)
    - char_length(
      replace(v_definition, '''apple-ttml-line-model-v2''', '')
    )
  ) / char_length('''apple-ttml-line-model-v2''');
  v_artifact_tag_count := (
    char_length(v_definition)
    - char_length(replace(v_definition, '''ttml-artifact-v2''', ''))
  ) / char_length('''ttml-artifact-v2''');
  v_status_reason_count := (
    char_length(v_definition)
    - char_length(
      replace(
        v_definition,
        '''automatic-apple-exact-quarantine:v2''',
        ''
      )
    )
  ) / char_length('''automatic-apple-exact-quarantine:v2''');

  if v_function_name_count <> 1
    or v_line_model_count <> 2
    or v_artifact_tag_count <> 1
    or v_status_reason_count <> 1 then
    raise exception 'unexpected complete_apple_lyrics_backfill_v2 definition; refusing unsafe v3 clone'
      using errcode = '55000';
  end if;

  v_definition := replace(
    v_definition,
    'public.complete_apple_lyrics_backfill_v2(',
    'private.complete_apple_lyrics_backfill_v3_impl('
  );
  v_definition := replace(
    v_definition,
    '''apple-ttml-line-model-v2''',
    '''apple-ttml-line-model-v3'''
  );
  v_definition := replace(
    v_definition,
    '''ttml-artifact-v2''',
    '''ttml-artifact-v3'''
  );
  v_definition := replace(
    v_definition,
    '''automatic-apple-exact-quarantine:v2''',
    '''automatic-apple-exact-quarantine:v3'''
  );

  execute v_definition;
end;
$migration$;

create function public.complete_apple_lyrics_backfill_v3(
  p_job_id uuid,
  p_lease_token uuid,
  p_provider_track_id text,
  p_storefront text,
  p_raw_metadata jsonb,
  p_payload jsonb,
  p_provenance jsonb,
  p_raw_ttml text,
  p_locale text,
  p_timing_mode text,
  p_recording_variant text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected_body_format text;
  v_synced_lyrics text;
  v_plain_lyrics text;
  v_has_synced boolean;
  v_duration_ms integer;
  v_job_duration_ms numeric;
  v_validation_version text;
  v_validation_outcome text;
  v_source_anomaly text;
  v_repair_method text;
  v_normalized_provenance jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object'
      using errcode = '22023';
  end if;

  if p_provenance is null or jsonb_typeof(p_provenance) <> 'object' then
    raise exception 'provenance must be a JSON object'
      using errcode = '22023';
  end if;

  v_synced_lyrics := coalesce(
    p_payload ->> 'synced_lyrics',
    p_payload ->> 'syncedLyrics'
  );
  v_plain_lyrics := coalesce(
    p_payload ->> 'plain_lyrics',
    p_payload ->> 'plainLyrics'
  );
  if (
    v_synced_lyrics is not null
    and v_synced_lyrics is distinct from
      btrim(v_synced_lyrics, E' \t\n\r\f')
  )
  or (
    v_plain_lyrics is not null
    and v_plain_lyrics is distinct from
      btrim(v_plain_lyrics, E' \t\n\r\f')
  ) then
    raise exception 'v3 normalized lyrics must not have outer whitespace'
      using errcode = '22023';
  end if;

  v_has_synced := nullif(
    btrim(coalesce(v_synced_lyrics, ''), E' \t\n\r\f'),
    ''
  ) is not null;
  v_duration_ms := nullif(
    coalesce(
      p_payload ->> 'duration_ms',
      p_payload ->> 'durationMs'
    ),
    ''
  )::integer;
  v_expected_body_format := case
    when v_has_synced
      then 'apple-ttml-line-projection-v3-ms'
    else 'apple-ttml-static-projection-v3'
  end;

  if p_provenance ->> 'body_format'
    is distinct from v_expected_body_format then
    raise exception 'body_format does not match the v3 normalized payload'
      using errcode = '22023';
  end if;

  v_validation_version := p_provenance ->> 'timeline_validation_version';
  v_validation_outcome := p_provenance ->> 'timeline_validation_outcome';
  v_source_anomaly := p_provenance ->> 'timeline_source_anomaly';
  v_repair_method := p_provenance ->> 'timeline_repair_method';

  if v_validation_version is distinct from
    'apple-timeline-validation-v1' then
    raise exception 'v3 direct completion requires timeline validation v1'
      using errcode = '22023';
  end if;

  if v_has_synced then
    select (job.track_metadata ->> 'duration_ms')::numeric
    into v_job_duration_ms
    from public.apple_lyrics_backfill_jobs as job
    where job.id = p_job_id
      and job.status = 'processing'
      and job.lease_token = p_lease_token
      and job.lease_expires_at > transaction_timestamp()
    for update;

    if not found then
      raise exception 'Apple v3 direct completion lease is no longer valid'
        using errcode = '55000';
    end if;

    if v_duration_ms is null
      or v_duration_ms <= 0
      or v_duration_ms > 86400000
      or v_job_duration_ms <= 0
      or v_duration_ms::numeric is distinct from v_job_duration_ms then
      raise exception 'synced v3 payload duration must match its leased job'
        using errcode = '22023';
    end if;

    if private.apple_synced_payload_timing_anomaly(
      v_synced_lyrics,
      v_duration_ms
    ) is not null then
      raise exception 'synced v3 payload still contains a hard timing anomaly'
        using errcode = '22023';
    end if;

    if v_validation_outcome is null
      or v_validation_outcome not in ('valid', 'repaired') then
      raise exception 'synced v3 payload requires a valid or repaired timeline'
        using errcode = '22023';
    end if;

    if (
      v_validation_outcome = 'valid'
      and (
        v_source_anomaly is not null
        or v_repair_method is not null
      )
    )
    or (
      v_validation_outcome = 'repaired'
      and (
        v_source_anomaly is null
        or v_source_anomaly not in (
          'timestamp-duration-overrun',
          'collapsed-timeline-coverage'
        )
        or v_repair_method is distinct from 'word-span-line-start-v1'
      )
    ) then
      raise exception 'synced v3 timeline evidence is inconsistent'
        using errcode = '22023';
    end if;
  else
    if v_validation_outcome is null
      or v_validation_outcome not in (
        'rejected',
        'not-evaluated',
        'not-applicable'
      )
      or v_repair_method is not null
      or (
        v_validation_outcome in ('not-evaluated', 'not-applicable')
        and v_source_anomaly is not null
      )
      or (
        v_validation_outcome = 'rejected'
        and (
          v_source_anomaly is null
          or v_source_anomaly not in (
            'timestamp-duration-overrun',
            'collapsed-timeline-coverage',
            'unsupported-time-base'
          )
        )
      ) then
      raise exception 'static v3 timeline evidence is inconsistent'
        using errcode = '22023';
    end if;
  end if;

  -- Pin the validated timeline contract to one canonical key family before
  -- the v2-compatible implementation merges provider and artifact identity.
  -- Conflicting camelCase audit fields must not survive beside trusted keys.
  v_normalized_provenance := (
    p_provenance
      - 'body_format'
      - 'bodyFormat'
      - 'timeline_validation_version'
      - 'timelineValidationVersion'
      - 'timeline_validation_outcome'
      - 'timelineValidationOutcome'
      - 'timeline_source_anomaly'
      - 'timelineSourceAnomaly'
      - 'timeline_repair_method'
      - 'timelineRepairMethod'
  ) || jsonb_build_object(
    'body_format', v_expected_body_format,
    'timeline_validation_version', 'apple-timeline-validation-v1',
    'timeline_validation_outcome', v_validation_outcome,
    'timeline_source_anomaly', v_source_anomaly,
    'timeline_repair_method', v_repair_method
  );

  return private.complete_apple_lyrics_backfill_v3_impl(
    p_job_id,
    p_lease_token,
    p_provider_track_id,
    p_storefront,
    p_raw_metadata,
    p_payload,
    v_normalized_provenance,
    p_raw_ttml,
    p_locale,
    p_timing_mode,
    p_recording_variant
  );
end;
$$;

comment on function public.complete_apple_lyrics_backfill_v3(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  text,
  text,
  text,
  text
) is
  'Rolling-safe v3 direct Apple completion. Parameters and response match v2; normalized body formats and immutable artifacts are labelled v3.';

-- Direct v3 completions participate in the same immutable route evidence as
-- v2. Both constraint triggers already call these functions by stable name.
create or replace function private.refresh_apple_primary_from_artifact_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.provider_name = 'apple'
    and new.projection_version in (
      'apple-ttml-line-model-v2',
      'apple-ttml-line-model-v3'
    ) then
    perform private.refresh_apple_primary_route_for_key(
      new.library_id,
      new.exact_key,
      new.key_version
    );
  end if;
  return new;
end;
$$;

create or replace function
  private.refresh_apple_primary_from_backfill_job_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_artifact public.lyrics_source_artifacts%rowtype;
begin
  if new.status = 'completed'
    and new.artifact_id is not null then
    select artifact.*
    into v_artifact
    from public.lyrics_source_artifacts as artifact
    where artifact.library_id = new.library_id
      and artifact.id = new.artifact_id;

    if found
      and v_artifact.provider_name = 'apple'
      and v_artifact.projection_version in (
        'apple-ttml-line-model-v2',
        'apple-ttml-line-model-v3'
      )
      and v_artifact.revision_id = new.revision_id then
      insert into public.apple_lyrics_v2_completion_evidence (
        library_id,
        artifact_id,
        revision_id,
        completion_kind,
        completion_job_id,
        completed_at
      )
      values (
        new.library_id,
        v_artifact.id,
        v_artifact.revision_id,
        'backfill',
        new.id,
        coalesce(new.completed_at, new.updated_at)
      )
      on conflict (library_id, artifact_id, revision_id) do nothing;

      perform private.refresh_apple_primary_route_for_key(
        v_artifact.library_id,
        v_artifact.exact_key,
        v_artifact.key_version
      );
    end if;
  end if;
  return new;
end;
$$;

-- Evidence is written only after the provider/reprojection job completed in
-- the same transaction. Enqueueing here therefore never exposes a partially
-- persisted source artifact.
create function private.enqueue_apple_timeline_repair_from_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_anomaly text;
begin
  select private.apple_synced_payload_timing_anomaly(
    revision.synced_lyrics,
    revision.duration_ms
  )
  into v_anomaly
  from public.lyrics_source_artifacts as artifact
  join public.lyrics_revisions as revision
    on revision.id = artifact.revision_id
  where artifact.library_id = new.library_id
    and artifact.id = new.artifact_id
    and artifact.projection_version = 'apple-ttml-line-model-v2'
    and private.is_apple_ttml_v2_timeline_repair_eligible(
      artifact.library_id,
      artifact.id
    );

  if v_anomaly in (
    'timestamp-duration-overrun',
    'collapsed-timeline-coverage'
  ) then
    insert into public.apple_lyrics_reprojection_jobs (
      library_id,
      source_artifact_id,
      target_projection_version,
      source_anomaly_code
    )
    values (
      new.library_id,
      new.artifact_id,
      'apple-ttml-line-model-v3',
      v_anomaly
    )
    on conflict (
      library_id,
      source_artifact_id,
      target_projection_version
    ) do nothing;
  end if;

  return new;
end;
$$;

create trigger apple_v2_evidence_enqueue_timeline_repair
after insert on public.apple_lyrics_v2_completion_evidence
for each row
execute function private.enqueue_apple_timeline_repair_from_evidence();

-- Seed retained anomalies present before this migration. Production was
-- measured at 649 latest synchronized v2 artifacts with zero matching hard
-- anomalies, so this is expected to insert zero rows there; it remains
-- deterministic for other environments.
insert into public.apple_lyrics_reprojection_jobs (
  library_id,
  source_artifact_id,
  target_projection_version,
  source_anomaly_code
)
select
  artifact.library_id,
  artifact.id,
  'apple-ttml-line-model-v3',
  private.apple_synced_payload_timing_anomaly(
    revision.synced_lyrics,
    revision.duration_ms
  )
from public.lyrics_source_artifacts as artifact
join public.lyrics_revisions as revision
  on revision.id = artifact.revision_id
where private.is_apple_ttml_v2_timeline_repair_eligible(
  artifact.library_id,
  artifact.id
)
on conflict (
  library_id,
  source_artifact_id,
  target_projection_version
) do nothing;

revoke all on function public.enqueue_apple_lyrics_timeline_repair_v3(
  uuid,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.claim_apple_lyrics_timeline_repair_v3(
  uuid,
  text,
  integer,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.fail_apple_lyrics_timeline_repair_v3(
  uuid,
  uuid,
  text,
  boolean,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.complete_apple_lyrics_timeline_repair_v3(
  uuid,
  uuid,
  jsonb,
  jsonb,
  text
) from public, anon, authenticated, service_role;
revoke all on function public.complete_apple_lyrics_backfill_v3(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function private.complete_apple_lyrics_backfill_v3_impl(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function
  private.enqueue_apple_timeline_repair_from_evidence()
  from public, anon, authenticated, service_role;

grant execute on function public.enqueue_apple_lyrics_timeline_repair_v3(
  uuid,
  integer
) to service_role;
grant execute on function public.claim_apple_lyrics_timeline_repair_v3(
  uuid,
  text,
  integer,
  integer
) to service_role;
grant execute on function public.fail_apple_lyrics_timeline_repair_v3(
  uuid,
  uuid,
  text,
  boolean,
  integer
) to service_role;
grant execute on function public.complete_apple_lyrics_timeline_repair_v3(
  uuid,
  uuid,
  jsonb,
  jsonb,
  text
) to service_role;
grant execute on function public.complete_apple_lyrics_backfill_v3(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  text,
  text,
  text,
  text
) to service_role;
