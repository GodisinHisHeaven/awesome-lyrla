-- Reproject retained Apple TTML with the v2 parser without contacting Apple.
-- Parsing remains in the isolated TypeScript worker: PostgreSQL owns only the
-- durable lease, immutable input, quarantined write, and audit lineage.

alter table public.lyrics_source_artifacts
  add constraint lyrics_source_artifacts_library_id_id_unique
  unique (library_id, id);

alter table public.lyrics_source_artifacts
  add column derived_from_artifact_id uuid;

alter table public.lyrics_source_artifacts
  add constraint lyrics_source_artifacts_derived_from_fk
  foreign key (library_id, derived_from_artifact_id)
  references public.lyrics_source_artifacts (library_id, id)
  on delete cascade;

alter table public.lyrics_source_artifacts
  add constraint lyrics_source_artifacts_not_self_derived
  check (
    derived_from_artifact_id is null
    or derived_from_artifact_id <> id
  );

create index lyrics_source_artifacts_derived_from
  on public.lyrics_source_artifacts (library_id, derived_from_artifact_id)
  where derived_from_artifact_id is not null;

comment on column public.lyrics_source_artifacts.derived_from_artifact_id is
  'Immutable lineage to the retained source artifact used by an offline reprojection. Null for artifacts produced directly from a provider fetch.';

create table public.apple_lyrics_reprojection_jobs (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null
    references public.lyrics_libraries(id) on delete cascade,
  source_artifact_id uuid not null,
  target_projection_version text not null
    default 'apple-ttml-line-model-v2',
  status text not null default 'pending',
  attempt_count smallint not null default 0,
  max_attempts smallint not null default 5,
  next_attempt_at timestamptz not null default transaction_timestamp(),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  result_document_id uuid
    references public.lyrics_documents(id) on delete set null,
  result_revision_id uuid
    references public.lyrics_revisions(id) on delete set null,
  result_artifact_id uuid
    references public.lyrics_source_artifacts(id) on delete set null,
  completed_at timestamptz,
  redrive_count integer not null default 0,
  last_redriven_at timestamptz,
  last_redrive_reason text,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint apple_lyrics_reprojection_jobs_source_fk
    foreign key (library_id, source_artifact_id)
    references public.lyrics_source_artifacts (library_id, id)
    on delete cascade,
  constraint apple_lyrics_reprojection_jobs_identity_unique
    unique (library_id, source_artifact_id, target_projection_version),
  constraint apple_lyrics_reprojection_jobs_target_v2
    check (target_projection_version = 'apple-ttml-line-model-v2'),
  constraint apple_lyrics_reprojection_jobs_status
    check (
      status in (
        'pending',
        'processing',
        'retry_wait',
        'completed',
        'dead_letter',
        'cancelled'
      )
    ),
  constraint apple_lyrics_reprojection_jobs_attempts
    check (
      max_attempts between 1 and 20
      and attempt_count between 0 and max_attempts
    ),
  constraint apple_lyrics_reprojection_jobs_lease
    check (
      (
        status = 'processing'
        and lease_token is not null
        and lease_owner is not null
        and lease_expires_at is not null
      )
      or
      (
        status <> 'processing'
        and lease_token is null
        and lease_owner is null
        and lease_expires_at is null
      )
    ),
  constraint apple_lyrics_reprojection_jobs_lease_owner_length
    check (lease_owner is null or char_length(lease_owner) between 1 and 120),
  constraint apple_lyrics_reprojection_jobs_error_code
    check (
      last_error_code is null
      or (
        char_length(last_error_code) between 1 and 128
        and last_error_code ~ '^[a-z0-9][a-z0-9._:-]*$'
      )
    ),
  constraint apple_lyrics_reprojection_jobs_terminal
    check (
      (
        status in ('completed', 'dead_letter', 'cancelled')
        and completed_at is not null
      )
      or
      (
        status not in ('completed', 'dead_letter', 'cancelled')
        and completed_at is null
      )
    ),
  constraint apple_lyrics_reprojection_jobs_result
    check (
      not (
        status <> 'completed'
        and (
          result_document_id is not null
          or result_revision_id is not null
          or result_artifact_id is not null
        )
      )
    ),
  constraint apple_lyrics_reprojection_jobs_redrive
    check (
      (
        redrive_count = 0
        and last_redriven_at is null
        and last_redrive_reason is null
      )
      or
      (
        redrive_count > 0
        and last_redriven_at is not null
        and last_redrive_reason is not null
      )
    ),
  constraint apple_lyrics_reprojection_jobs_redrive_reason
    check (
      last_redrive_reason is null
      or (
        char_length(last_redrive_reason) between 1 and 128
        and last_redrive_reason ~ '^[a-z0-9][a-z0-9._:-]*$'
      )
    )
);

comment on table public.apple_lyrics_reprojection_jobs is
  'Durable server-only queue for offline Apple TTML reprojection. Inputs come exclusively from retained immutable artifacts; no provider request occurs.';

comment on constraint apple_lyrics_reprojection_jobs_identity_unique
  on public.apple_lyrics_reprojection_jobs is
  'Idempotency is per immutable source artifact and target parser generation, not per Apple track. Distinct retained v1 snapshots are all audited and reprojected.';

create index apple_lyrics_reprojection_jobs_due
  on public.apple_lyrics_reprojection_jobs (
    library_id,
    next_attempt_at,
    created_at
  )
  where status in ('pending', 'retry_wait');

create index apple_lyrics_reprojection_jobs_expired_lease
  on public.apple_lyrics_reprojection_jobs (library_id, lease_expires_at)
  where status = 'processing';

create index apple_lyrics_reprojection_jobs_status_updated
  on public.apple_lyrics_reprojection_jobs (
    library_id,
    status,
    updated_at desc
  );

create trigger apple_lyrics_reprojection_jobs_set_updated_at
before update on public.apple_lyrics_reprojection_jobs
for each row execute function private.set_updated_at();

-- Reprojection is allowed only for artifacts that can still be proven to be
-- the output of the verified Apple Exact ingestion path. Rejected, active,
-- manually selected, detached, or malformed source rows are never rewritten.
create function private.is_apple_ttml_v1_reprojection_eligible(
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
      and binding.status = 'quarantine'
      and binding.selection_method = 'provider'
    join public.apple_lyrics_backfill_jobs as source_job
      on source_job.library_id = artifact.library_id
      and source_job.artifact_id = artifact.id
      and source_job.status = 'completed'
      and source_job.exact_key = artifact.exact_key
      and source_job.key_version = artifact.key_version
      and source_job.provider_track_id = artifact.provider_track_id
    where artifact.library_id = p_library_id
      and artifact.id = p_artifact_id
      and artifact.provider_name = 'apple'
      and artifact.projection_version = 'apple-ttml-line-model-v1'
      and revision.provider_name = 'apple'
      and revision.provider_track_id = artifact.provider_track_id
      and revision.provenance ->> 'exact_identity_proof_version' = '1'
      and jsonb_typeof(
        revision.provenance -> 'exact_identity_evidence'
      ) = 'array'
      and nullif(
        btrim(revision.provenance ->> 'idempotency_key'),
        ''
      ) is not null
      and document.source_identity =
        'custom:' || (revision.provenance ->> 'idempotency_key')
      and private.is_valid_apple_lyrics_track_metadata(binding.raw_metadata)
      and octet_length(binding.raw_metadata::text) <= 16384
      and not exists (
        select 1
        from public.lyrics_bindings as serving_binding
        where serving_binding.library_id = artifact.library_id
          and serving_binding.document_id = document.id
          and serving_binding.status = 'active'
      )
  );
$$;

revoke all on function private.is_apple_ttml_v1_reprojection_eligible(
  uuid,
  uuid
) from public, anon, authenticated, service_role;

create function public.enqueue_apple_lyrics_reprojection_v2(
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
    target_projection_version
  )
  select
    artifact.library_id,
    artifact.id,
    'apple-ttml-line-model-v2'
  from public.lyrics_source_artifacts as artifact
  where artifact.library_id = p_library_id
    and private.is_apple_ttml_v1_reprojection_eligible(
      artifact.library_id,
      artifact.id
    )
    and not exists (
      select 1
      from public.apple_lyrics_reprojection_jobs as existing
      where existing.library_id = artifact.library_id
        and existing.source_artifact_id = artifact.id
        and existing.target_projection_version =
          'apple-ttml-line-model-v2'
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
    and private.is_apple_ttml_v1_reprojection_eligible(
      artifact.library_id,
      artifact.id
    )
    and not exists (
      select 1
      from public.apple_lyrics_reprojection_jobs as existing
      where existing.library_id = artifact.library_id
        and existing.source_artifact_id = artifact.id
        and existing.target_projection_version =
          'apple-ttml-line-model-v2'
    );

  return jsonb_build_object(
    'target_projection_version', 'apple-ttml-line-model-v2',
    'enqueued', v_inserted,
    'remaining', v_remaining
  );
end;
$$;

comment on function public.enqueue_apple_lyrics_reprojection_v2(
  uuid,
  integer
) is
  'Idempotently enqueue eligible retained Apple v1 TTML artifacts for local v2 reprojection. Repeated calls never reset or duplicate jobs.';

create function public.claim_apple_lyrics_reprojection_v2(
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
    and (
      job.status in ('pending', 'retry_wait')
      or (
        job.status = 'processing'
        and job.lease_expires_at <= v_now
      )
    )
    and not private.is_apple_ttml_v1_reprojection_eligible(
      job.library_id,
      job.source_artifact_id
    );

  with candidates as (
    select job.id
    from public.apple_lyrics_reprojection_jobs as job
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = job.library_id
      and artifact.id = job.source_artifact_id
    join public.lyrics_revisions as revision
      on revision.id = artifact.revision_id
    where job.library_id = p_library_id
      and job.target_projection_version = 'apple-ttml-line-model-v2'
      and job.attempt_count < job.max_attempts
      and private.is_apple_ttml_v1_reprojection_eligible(
        job.library_id,
        job.source_artifact_id
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
      -- Multiple retained snapshots can share one stable Apple document.
      -- Process that document oldest-to-newest even when several workers
      -- claim in parallel, so its final current quarantine revision always
      -- comes from the newest retained TTML rather than lease completion order.
      and not exists (
        select 1
        from public.apple_lyrics_reprojection_jobs as earlier_job
        join public.lyrics_source_artifacts as earlier_artifact
          on earlier_artifact.library_id = earlier_job.library_id
          and earlier_artifact.id = earlier_job.source_artifact_id
        join public.lyrics_revisions as earlier_revision
          on earlier_revision.id = earlier_artifact.revision_id
        where earlier_job.library_id = job.library_id
          and earlier_job.id <> job.id
          and earlier_job.target_projection_version =
            job.target_projection_version
          and earlier_job.status in ('pending', 'retry_wait', 'processing')
          and earlier_revision.document_id = revision.document_id
          and (
            earlier_artifact.fetched_at,
            earlier_artifact.created_at,
            earlier_artifact.id
          ) < (
            artifact.fetched_at,
            artifact.created_at,
            artifact.id
          )
      )
    order by
      artifact.fetched_at,
      artifact.created_at,
      artifact.id,
      job.next_attempt_at,
      job.created_at,
      job.id
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

comment on function public.claim_apple_lyrics_reprojection_v2(
  uuid,
  text,
  integer,
  integer
) is
  'Lease verified retained TTML for an offline v2 projection. The response contains immutable raw TTML and bounded proof/track metadata, never provider credentials.';

create function public.fail_apple_lyrics_reprojection_v2(
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
declare
  v_now timestamptz := transaction_timestamp();
  v_error_code text := lower(nullif(btrim(p_error_code), ''));
  v_next_status text;
  v_job public.apple_lyrics_reprojection_jobs%rowtype;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job_id and lease_token are required'
      using errcode = '22023';
  end if;

  if v_error_code is null
    or char_length(v_error_code) > 128
    or v_error_code !~ '^[a-z0-9][a-z0-9._:-]*$' then
    raise exception 'error_code must be a safe 1-128 character identifier'
      using errcode = '22023';
  end if;

  if p_retryable is null then
    raise exception 'retryable is required'
      using errcode = '22023';
  end if;

  if p_retry_after_seconds is null
    or p_retry_after_seconds < 1
    or p_retry_after_seconds > 86400 then
    raise exception 'retry_after_seconds must be between 1 and 86400'
      using errcode = '22023';
  end if;

  select job.*
  into v_job
  from public.apple_lyrics_reprojection_jobs as job
  where job.id = p_job_id
  for update;

  if not found then
    raise exception 'Apple reprojection job does not exist'
      using errcode = '22023';
  end if;

  if v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= v_now then
    raise exception 'Apple reprojection lease is no longer valid'
      using errcode = '55000';
  end if;

  v_next_status := case
    when p_retryable and v_job.attempt_count < v_job.max_attempts
      then 'retry_wait'
    else 'dead_letter'
  end;

  update public.apple_lyrics_reprojection_jobs as job
  set
    status = v_next_status,
    next_attempt_at = case
      when v_next_status = 'retry_wait'
        then v_now + make_interval(secs => p_retry_after_seconds)
      else job.next_attempt_at
    end,
    lease_token = null,
    lease_owner = null,
    lease_expires_at = null,
    last_error_code = v_error_code,
    completed_at = case
      when v_next_status = 'dead_letter' then v_now
      else null
    end,
    updated_at = v_now
  where job.id = v_job.id
  returning job.* into v_job;

  return jsonb_build_object(
    'job_id', v_job.id,
    'status', v_job.status,
    'attempt_count', v_job.attempt_count,
    'max_attempts', v_job.max_attempts,
    'next_attempt_at', v_job.next_attempt_at,
    'last_error_code', v_job.last_error_code,
    'completed_at', v_job.completed_at
  );
end;
$$;

create function public.requeue_apple_lyrics_reprojection_v2(
  p_library_id uuid,
  p_job_id uuid,
  p_reason text,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_reason text := lower(nullif(btrim(p_reason), ''));
  v_job public.apple_lyrics_reprojection_jobs%rowtype;
begin
  if v_reason is null
    or char_length(v_reason) > 128
    or v_reason !~ '^[a-z0-9][a-z0-9._:-]*$' then
    raise exception 'reason must be a safe 1-128 character identifier'
      using errcode = '22023';
  end if;

  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'max_attempts must be between 1 and 20'
      using errcode = '22023';
  end if;

  select job.*
  into v_job
  from public.apple_lyrics_reprojection_jobs as job
  where job.library_id = p_library_id
    and job.id = p_job_id
  for update;

  if not found then
    raise exception 'Apple reprojection job does not exist'
      using errcode = '22023';
  end if;

  if v_job.status not in ('dead_letter', 'cancelled') then
    raise exception 'only dead-letter or cancelled reprojection jobs can be redriven'
      using errcode = '55000';
  end if;

  if not private.is_apple_ttml_v1_reprojection_eligible(
    v_job.library_id,
    v_job.source_artifact_id
  ) then
    raise exception 'source artifact is not eligible for v2 reprojection'
      using errcode = '55000';
  end if;

  update public.apple_lyrics_reprojection_jobs as job
  set
    status = 'pending',
    attempt_count = 0,
    max_attempts = p_max_attempts,
    next_attempt_at = v_now,
    lease_token = null,
    lease_owner = null,
    lease_expires_at = null,
    last_error_code = null,
    completed_at = null,
    redrive_count = job.redrive_count + 1,
    last_redriven_at = v_now,
    last_redrive_reason = v_reason,
    updated_at = v_now
  where job.id = v_job.id
  returning job.* into v_job;

  return jsonb_build_object(
    'job_id', v_job.id,
    'status', v_job.status,
    'attempt_count', v_job.attempt_count,
    'max_attempts', v_job.max_attempts,
    'redrive_count', v_job.redrive_count,
    'last_redriven_at', v_job.last_redriven_at,
    'last_redrive_reason', v_job.last_redrive_reason
  );
end;
$$;

create function public.complete_apple_lyrics_reprojection_v2(
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
  v_expected_body_format text;
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

  if v_timing_mode not in (
    'none',
    'line',
    'word',
    'syllable',
    'missing',
    'unsupported',
    'unknown'
  ) then
    raise exception 'timing_mode is not supported'
      using errcode = '22023';
  end if;

  v_expected_body_format := case
    when nullif(
      btrim(
        coalesce(
          v_payload ->> 'synced_lyrics',
          v_payload ->> 'syncedLyrics'
        )
      ),
      ''
    ) is not null
      then 'apple-ttml-line-projection-v2-ms'
    else 'apple-ttml-static-projection-v2'
  end;

  if v_provenance ->> 'body_format' is distinct from v_expected_body_format then
    raise exception 'body_format does not match the v2 normalized payload'
      using errcode = '22023';
  end if;

  select
    job.id as job_id,
    job.library_id,
    job.status,
    job.lease_token,
    job.lease_expires_at,
    job.target_projection_version,
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
    raise exception 'Apple reprojection job or source artifact does not exist'
      using errcode = '22023';
  end if;

  if v_row.status <> 'processing'
    or v_row.lease_token is distinct from p_lease_token
    or v_row.lease_expires_at <= v_now then
    raise exception 'Apple reprojection lease is no longer valid'
      using errcode = '55000';
  end if;

  -- Updating a document's current revision changes every binding that points
  -- at that document, not only this artifact's source Exact key. Lock the
  -- stable document first, then all existing aliases in deterministic order.
  -- The document FOR UPDATE lock also conflicts with the FK key-share lock
  -- required by a concurrent binding insert. Existing binding promotions
  -- block on the row locks below. Rechecking eligibility after both lock sets
  -- closes the future-state serving race.
  perform 1
  from public.lyrics_documents as document
  where document.library_id = v_row.library_id
    and document.id = v_row.source_document_id
  for update;

  if not found then
    raise exception 'Apple reprojection source document no longer exists'
      using errcode = '55000';
  end if;

  perform binding.id
  from public.lyrics_bindings as binding
  where binding.library_id = v_row.library_id
    and binding.document_id = v_row.source_document_id
  order by binding.id
  for update;

  if v_row.target_projection_version <> 'apple-ttml-line-model-v2'
    or not private.is_apple_ttml_v1_reprojection_eligible(
      v_row.library_id,
      v_row.source_artifact_id
    ) then
    raise exception 'source artifact is not eligible for v2 reprojection'
      using errcode = '55000';
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

  -- The source document identity is deliberately retained so changed output
  -- creates its next immutable revision. Caller provenance cannot change
  -- provider, exact binding, trust status, or artifact lineage.
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
    'reprojection_job_id', v_row.job_id,
    'projection_version', v_row.target_projection_version,
    'body_format', v_expected_body_format,
    'exact_identity_proof_version',
      v_row.source_provenance -> 'exact_identity_proof_version',
    'exact_identity_evidence',
      v_row.source_provenance -> 'exact_identity_evidence',
    'status_reason', 'automatic-apple-exact-quarantine:reprojection-v2'
  );

  if octet_length(v_provenance::text) > 16384 then
    raise exception 'merged provenance must not exceed 16384 bytes'
      using errcode = '22023';
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

  if v_document_id is distinct from v_row.source_document_id
    or v_revision_id is null
    or v_normalized_hash is null
    or v_normalized_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'v2 projection did not produce the expected Apple revision'
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
    raise exception 'v2 Apple binding escaped quarantine'
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
    raise exception 'v2 reprojection changed the active serving binding'
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
    raise exception 'v2 reprojection document became actively served'
      using errcode = '23514';
  end if;

  v_artifact_identity := encode(
    extensions.digest(
      convert_to(
        jsonb_build_array(
          'ttml-artifact-v2',
          'apple',
          v_row.source_artifact_id,
          v_row.target_projection_version,
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
    raise exception 'v2 Apple TTML artifact was not persisted'
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
    raise exception 'Apple reprojection lease was lost before commit'
      using errcode = '40001';
  end if;

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

comment on function public.complete_apple_lyrics_reprojection_v2(
  uuid,
  uuid,
  jsonb,
  jsonb,
  text
) is
  'Atomically write a quarantined v2 normalized revision and a new immutable artifact derived from retained v1 TTML. The active serving binding is asserted unchanged.';

-- Keep the deployed v1 RPC byte-for-byte compatible during the rolling
-- release. Clone it under a new name and version only the artifact/projection
-- constants. Old instances keep producing correctly labelled v1 artifacts;
-- the new application explicitly opts into this v2 RPC.
do $migration$
declare
  v_function regprocedure :=
    'public.complete_apple_lyrics_backfill(uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text,text,text)'::regprocedure;
  v_definition text;
  v_line_model_count integer;
  v_function_name_count integer;
begin
  select pg_get_functiondef(v_function)
  into v_definition;

  v_function_name_count := (
    char_length(v_definition)
    - char_length(
      replace(
        v_definition,
        'public.complete_apple_lyrics_backfill(',
        ''
      )
    )
  ) / char_length('public.complete_apple_lyrics_backfill(');

  v_line_model_count := (
    char_length(v_definition)
    - char_length(
      replace(v_definition, '''apple-ttml-line-model-v1''', '')
    )
  ) / char_length('''apple-ttml-line-model-v1''');

  if v_function_name_count <> 1
    or v_line_model_count <> 2
    or position('''ttml-artifact-v1''' in v_definition) = 0
    or position(
      '''automatic-apple-exact-quarantine:v1'''
      in v_definition
    ) = 0 then
    raise exception 'unexpected complete_apple_lyrics_backfill definition; refusing unsafe v2 clone'
      using errcode = '55000';
  end if;

  v_definition := replace(
    v_definition,
    'public.complete_apple_lyrics_backfill(',
    'public.complete_apple_lyrics_backfill_v2('
  );
  v_definition := replace(
    v_definition,
    '''apple-ttml-line-model-v1''',
    '''apple-ttml-line-model-v2'''
  );
  v_definition := replace(
    v_definition,
    '''ttml-artifact-v1''',
    '''ttml-artifact-v2'''
  );
  v_definition := replace(
    v_definition,
    '''automatic-apple-exact-quarantine:v1''',
    '''automatic-apple-exact-quarantine:v2'''
  );

  execute v_definition;
end;
$migration$;

comment on function public.complete_apple_lyrics_backfill_v2(
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
  'V2 counterpart to complete_apple_lyrics_backfill. Atomically writes a normalized quarantined Apple v2 revision, immutable v2 TTML artifact, and leased job acknowledgement without changing the rolling-deploy-safe v1 RPC.';

-- A migration seed is only a point-in-time snapshot. An old application
-- instance can finish a leased v1 job after the migration commits but before
-- the v2 Fly release starts. Queue every subsequently inserted Apple v1
-- artifact transactionally; claim-time eligibility remains fail-closed until
-- the enclosing v1 completion also marks its source backfill job completed.
create function private.enqueue_apple_ttml_v1_reprojection_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.provider_name = 'apple'
    and new.projection_version = 'apple-ttml-line-model-v1'
    and new.derived_from_artifact_id is null then
    insert into public.apple_lyrics_reprojection_jobs (
      library_id,
      source_artifact_id,
      target_projection_version
    )
    values (
      new.library_id,
      new.id,
      'apple-ttml-line-model-v2'
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

revoke all on function private.enqueue_apple_ttml_v1_reprojection_on_insert()
  from public, anon, authenticated, service_role;

create trigger lyrics_source_artifacts_enqueue_v1_reprojection
after insert on public.lyrics_source_artifacts
for each row
execute function private.enqueue_apple_ttml_v1_reprojection_on_insert();

-- Seed every eligible artifact already present when this migration commits.
-- A distinct job is retained for each immutable v1 artifact, including
-- multiple historical snapshots of one provider document. Claim ordering
-- serializes those snapshots oldest-to-newest per document. The enqueue RPC
-- handles artifacts that arrive concurrently or later and reports the number
-- inserted plus the number still eligible but not yet represented by a job.
insert into public.apple_lyrics_reprojection_jobs (
  library_id,
  source_artifact_id,
  target_projection_version
)
select
  artifact.library_id,
  artifact.id,
  'apple-ttml-line-model-v2'
from public.lyrics_source_artifacts as artifact
where private.is_apple_ttml_v1_reprojection_eligible(
  artifact.library_id,
  artifact.id
)
on conflict (
  library_id,
  source_artifact_id,
  target_projection_version
) do nothing;

alter table public.apple_lyrics_reprojection_jobs enable row level security;

revoke all on table public.apple_lyrics_reprojection_jobs
  from public, anon, authenticated, service_role;

revoke all on function public.complete_apple_lyrics_backfill_v2(
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
revoke all on function public.enqueue_apple_lyrics_reprojection_v2(
  uuid,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.claim_apple_lyrics_reprojection_v2(
  uuid,
  text,
  integer,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.fail_apple_lyrics_reprojection_v2(
  uuid,
  uuid,
  text,
  boolean,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.requeue_apple_lyrics_reprojection_v2(
  uuid,
  uuid,
  text,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.complete_apple_lyrics_reprojection_v2(
  uuid,
  uuid,
  jsonb,
  jsonb,
  text
) from public, anon, authenticated, service_role;

grant execute on function public.enqueue_apple_lyrics_reprojection_v2(
  uuid,
  integer
) to service_role;
grant execute on function public.complete_apple_lyrics_backfill_v2(
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
grant execute on function public.claim_apple_lyrics_reprojection_v2(
  uuid,
  text,
  integer,
  integer
) to service_role;
grant execute on function public.fail_apple_lyrics_reprojection_v2(
  uuid,
  uuid,
  text,
  boolean,
  integer
) to service_role;
grant execute on function public.requeue_apple_lyrics_reprojection_v2(
  uuid,
  uuid,
  text,
  integer
) to service_role;
grant execute on function public.complete_apple_lyrics_reprojection_v2(
  uuid,
  uuid,
  jsonb,
  jsonb,
  text
) to service_role;
