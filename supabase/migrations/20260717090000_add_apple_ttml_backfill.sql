-- Queue rows are claimed in batches and parsed by a strict client schema. Keep
-- invalid metadata out of the queue so one malformed row cannot poison every
-- lease response in its batch.
create function private.is_valid_apple_lyrics_track_metadata(
  p_metadata jsonb
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p_metadata) = 'object'
    and jsonb_typeof(p_metadata -> 'title') = 'string'
    and char_length(btrim(p_metadata ->> 'title')) between 1 and 2048
    and jsonb_typeof(p_metadata -> 'artist') = 'string'
    and char_length(btrim(p_metadata ->> 'artist')) between 1 and 2048
    and case
      when jsonb_typeof(p_metadata -> 'duration_ms') = 'number'
        then (p_metadata ->> 'duration_ms')::numeric between 0 and 86400000
      else false
    end
    and (
      not (p_metadata ? 'album')
      or (
        jsonb_typeof(p_metadata -> 'album') = 'string'
        and char_length(p_metadata ->> 'album') <= 2048
      )
    )
    and (
      not (p_metadata ? 'source')
      or (
        jsonb_typeof(p_metadata -> 'source') = 'string'
        and char_length(p_metadata ->> 'source') <= 256
      )
    ),
    false
  );
$$;

revoke all on function private.is_valid_apple_lyrics_track_metadata(jsonb)
  from public, anon, authenticated, service_role;

-- Preserve source payloads outside the resolver's normalized read model.
-- This table is intentionally absent from resolve_lyrics and is reachable
-- only through the server-only RPCs defined below.
create table public.lyrics_source_artifacts (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null
    references public.lyrics_libraries(id) on delete cascade,
  revision_id uuid
    references public.lyrics_revisions(id) on delete set null,
  provider_name text not null,
  provider_track_id text not null,
  storefront text not null,
  exact_key text not null,
  key_version smallint not null,
  locale text not null,
  timing_mode text not null,
  recording_variant text not null,
  projection_version text not null,
  media_type text not null default 'application/ttml+xml',
  raw_ttml text not null,
  content_hash text not null,
  byte_size integer not null,
  artifact_identity text not null,
  fetched_at timestamptz not null default transaction_timestamp(),
  created_at timestamptz not null default transaction_timestamp(),
  constraint lyrics_source_artifacts_provider_name_format
    check (
      char_length(provider_name) between 1 and 120
      and provider_name = lower(btrim(provider_name))
      and provider_name ~ '^[a-z0-9][a-z0-9._-]*$'
    ),
  constraint lyrics_source_artifacts_provider_track_id_length
    check (char_length(provider_track_id) between 1 and 512),
  constraint lyrics_source_artifacts_storefront_format
    check (storefront ~ '^[a-z]{2}$'),
  constraint lyrics_source_artifacts_exact_key_length
    check (char_length(exact_key) between 1 and 512),
  constraint lyrics_source_artifacts_key_version_positive
    check (key_version > 0),
  constraint lyrics_source_artifacts_locale_format
    check (
      char_length(locale) between 1 and 35
      and locale ~ '^[A-Za-z0-9][A-Za-z0-9-]*$'
    ),
  constraint lyrics_source_artifacts_timing_mode
    check (
      timing_mode in (
        'none',
        'line',
        'word',
        'syllable',
        'missing',
        'unsupported',
        'unknown'
      )
    ),
  constraint lyrics_source_artifacts_recording_variant_format
    check (
      char_length(recording_variant) between 1 and 128
      and recording_variant = lower(btrim(recording_variant))
      and recording_variant ~ '^[a-z0-9][a-z0-9._:-]*$'
    ),
  constraint lyrics_source_artifacts_projection_version_format
    check (
      char_length(projection_version) between 1 and 128
      and projection_version = lower(btrim(projection_version))
      and projection_version ~ '^[a-z0-9][a-z0-9._:-]*$'
    ),
  constraint lyrics_source_artifacts_media_type
    check (media_type = 'application/ttml+xml'),
  constraint lyrics_source_artifacts_content_hash_format
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint lyrics_source_artifacts_content_hash_matches
    check (
      content_hash = encode(
        extensions.digest(convert_to(raw_ttml, 'UTF8'), 'sha256'),
        'hex'
      )
    ),
  constraint lyrics_source_artifacts_byte_size
    check (
      byte_size between 1 and 524288
      and byte_size = octet_length(raw_ttml)
    ),
  constraint lyrics_source_artifacts_identity_format
    check (artifact_identity ~ '^[0-9a-f]{64}$'),
  constraint lyrics_source_artifacts_identity_unique
    unique (library_id, artifact_identity)
);

comment on table public.lyrics_source_artifacts is
  'Private immutable source artifacts. Raw TTML is retained for audit/reprocessing and is never joined by resolve_lyrics.';

comment on column public.lyrics_source_artifacts.revision_id is
  'Optional normalized revision produced from this artifact. The artifact survives revision deletion with this link cleared.';

create index lyrics_source_artifacts_revision
  on public.lyrics_source_artifacts (revision_id)
  where revision_id is not null;

create index lyrics_source_artifacts_provider_lookup
  on public.lyrics_source_artifacts (
    library_id,
    provider_name,
    provider_track_id,
    storefront,
    fetched_at desc
  );

create index lyrics_source_artifacts_exact_lookup
  on public.lyrics_source_artifacts (
    library_id,
    key_version,
    exact_key,
    fetched_at desc
  );

-- A durable, metadata-only queue. Lyrics and TTML never live in the job row,
-- and credentials must remain in the isolated worker's secret store.
create table public.apple_lyrics_backfill_jobs (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null
    references public.lyrics_libraries(id) on delete cascade,
  job_key text not null,
  exact_key text not null,
  key_version smallint not null,
  storefront text not null,
  resolved_storefront text,
  locale text not null,
  provider_track_id text,
  isrc text,
  track_metadata jsonb not null default '{}'::jsonb,
  priority smallint not null default 0,
  status text not null default 'pending',
  attempt_count smallint not null default 0,
  max_attempts smallint not null default 5,
  next_attempt_at timestamptz not null default transaction_timestamp(),
  lease_token uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  document_id uuid references public.lyrics_documents(id) on delete set null,
  revision_id uuid references public.lyrics_revisions(id) on delete set null,
  artifact_id uuid references public.lyrics_source_artifacts(id) on delete set null,
  completed_at timestamptz,
  redrive_count integer not null default 0,
  last_redriven_at timestamptz,
  last_redrive_reason text,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint apple_lyrics_backfill_jobs_key_format
    check (job_key ~ '^[0-9a-f]{64}$'),
  constraint apple_lyrics_backfill_jobs_key_unique
    unique (library_id, job_key),
  constraint apple_lyrics_backfill_jobs_exact_key_length
    check (char_length(exact_key) between 1 and 512),
  constraint apple_lyrics_backfill_jobs_key_version_positive
    check (key_version > 0),
  constraint apple_lyrics_backfill_jobs_storefront_format
    check (storefront ~ '^[a-z]{2}$'),
  constraint apple_lyrics_backfill_jobs_resolved_storefront_format
    check (
      resolved_storefront is null
      or resolved_storefront ~ '^[a-z]{2}$'
    ),
  constraint apple_lyrics_backfill_jobs_locale_format
    check (
      char_length(locale) between 1 and 35
      and locale ~ '^[A-Za-z0-9][A-Za-z0-9-]*$'
    ),
  constraint apple_lyrics_backfill_jobs_provider_track_id_length
    check (
      provider_track_id is null
      or char_length(provider_track_id) between 1 and 512
    ),
  constraint apple_lyrics_backfill_jobs_isrc_format
    check (
      isrc is null
      or (
        char_length(isrc) between 1 and 32
        and isrc ~ '^[A-Z0-9-]+$'
      )
    ),
  constraint apple_lyrics_backfill_jobs_track_metadata
    check (
      private.is_valid_apple_lyrics_track_metadata(track_metadata)
      and octet_length(track_metadata::text) <= 16384
    ),
  constraint apple_lyrics_backfill_jobs_priority_range
    check (priority between -100 and 100),
  constraint apple_lyrics_backfill_jobs_status
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
  constraint apple_lyrics_backfill_jobs_attempts
    check (
      max_attempts between 1 and 20
      and attempt_count between 0 and max_attempts
    ),
  constraint apple_lyrics_backfill_jobs_redrive_count
    check (redrive_count >= 0),
  constraint apple_lyrics_backfill_jobs_redrive_reason_format
    check (
      last_redrive_reason is null
      or (
        char_length(last_redrive_reason) between 1 and 128
        and last_redrive_reason ~ '^[a-z0-9][a-z0-9._:-]*$'
      )
    ),
  constraint apple_lyrics_backfill_jobs_redrive_consistency
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
  constraint apple_lyrics_backfill_jobs_lease_consistency
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
  constraint apple_lyrics_backfill_jobs_lease_owner_length
    check (lease_owner is null or char_length(lease_owner) between 1 and 120),
  constraint apple_lyrics_backfill_jobs_error_code_format
    check (
      last_error_code is null
      or (
        char_length(last_error_code) between 1 and 128
        and last_error_code ~ '^[a-z0-9][a-z0-9._:-]*$'
      )
    ),
  constraint apple_lyrics_backfill_jobs_terminal_consistency
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
  constraint apple_lyrics_backfill_jobs_resolved_storefront_consistency
    check (
      (status = 'completed' and resolved_storefront is not null)
      or (status <> 'completed' and resolved_storefront is null)
    )
);

comment on table public.apple_lyrics_backfill_jobs is
  'Durable metadata-only Apple TTML backfill queue. Workers use leased server-only RPCs; the serving path never reads this table.';

create index apple_lyrics_backfill_jobs_due
  on public.apple_lyrics_backfill_jobs (
    library_id,
    priority desc,
    next_attempt_at,
    created_at
  )
  where status in ('pending', 'retry_wait');

create index apple_lyrics_backfill_jobs_expired_lease
  on public.apple_lyrics_backfill_jobs (library_id, lease_expires_at)
  where status = 'processing';

create index apple_lyrics_backfill_jobs_status_updated
  on public.apple_lyrics_backfill_jobs (library_id, status, updated_at desc);

-- Keep the existing exact auto-promotion implementation intact for LRCLIB,
-- then put a provider allowlist in front of it. All other automatic providers,
-- including Apple, go directly through the quarantine-safe writer.
alter function public.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) set schema private;

alter function private.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) rename to upsert_lyrics_document_auto_exact_v1;

revoke all on function private.upsert_lyrics_document_auto_exact_v1(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) from public, anon, authenticated, service_role;

comment on function private.upsert_lyrics_document_auto_exact_v1(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) is
  'Private v1 automatic exact promotion policy, retained exclusively for allowlisted LRCLIB writes.';

create function public.upsert_lyrics_document(
  p_library_id uuid,
  p_exact_key text,
  p_work_key text,
  p_key_version integer,
  p_raw_metadata jsonb,
  p_payload jsonb,
  p_provenance jsonb,
  p_acquisition public.lyrics_acquisition,
  p_requested_status public.lyrics_status default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_name text := lower(
    nullif(
      btrim(
        coalesce(
          coalesce(p_provenance, '{}'::jsonb) ->> 'provider_name',
          coalesce(p_provenance, '{}'::jsonb) ->> 'providerName'
        )
      ),
      ''
    )
  );
  v_result jsonb;
begin
  if p_acquisition = 'provider'
    and v_provider_name = 'lrclib' then
    return private.upsert_lyrics_document_auto_exact_v1(
      p_library_id,
      p_exact_key,
      p_work_key,
      p_key_version,
      p_raw_metadata,
      p_payload,
      p_provenance,
      p_acquisition,
      p_requested_status
    );
  end if;

  v_result := private.upsert_lyrics_document_quarantine_v1(
    p_library_id,
    p_exact_key,
    p_work_key,
    p_key_version,
    p_raw_metadata,
    p_payload,
    p_provenance,
    p_acquisition,
    p_requested_status
  );

  if p_acquisition = 'provider'
    and nullif(btrim(p_exact_key), '') is not null
    and nullif(btrim(p_work_key), '') is null then
    return v_result || jsonb_build_object(
      'promotion_blocked', true,
      'promotion_block_reason', 'provider-not-allowlisted-for-auto-promotion'
    );
  end if;

  return v_result;
end;
$$;

comment on function public.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) is
  'Provider-aware server-only write. LRCLIB exact-only provider results retain automatic active v0 promotion; Apple and unknown providers remain quarantined and cannot replace an active binding.';

-- The preceding provider-exact migration promoted every provider because no
-- allowlist existed at that point. Apply the new policy to already-active data
-- as well as future writes; otherwise resolve_lyrics would keep serving an old
-- Apple/unknown v0 binding even after this wrapper quarantines new revisions.
update public.lyrics_bindings as binding
set
  status = 'quarantine',
  selection_version = null,
  status_reason = 'automatic-provider-exact-demoted:not-allowlisted:v1',
  updated_at = transaction_timestamp(),
  superseded_at = null,
  superseded_by_binding_id = null
where binding.binding_kind = 'exact'
  and binding.status = 'active'
  and binding.selection_method = 'provider'
  and binding.selection_version = 0
  and exists (
    select 1
    from public.lyrics_revisions as revision
    where revision.document_id = binding.document_id
      and revision.is_current
      and lower(btrim(coalesce(revision.provider_name, ''))) <> 'lrclib'
  );

-- The old all-provider policy may have superseded an earlier trusted LRCLIB
-- exact row. Restore the newest such row for each just-demoted key so applying
-- this migration does not create a temporary library miss.
with restorable_lrclib as (
  select distinct on (
    binding.library_id,
    binding.key_version,
    binding.lookup_key
  )
    binding.id
  from public.lyrics_bindings as binding
  join public.lyrics_revisions as revision
    on revision.document_id = binding.document_id
    and revision.is_current
  where binding.binding_kind = 'exact'
    and binding.status = 'superseded'
    and binding.selection_method = 'provider'
    and binding.selection_version = 0
    and lower(btrim(coalesce(revision.provider_name, ''))) = 'lrclib'
    and exists (
      select 1
      from public.lyrics_bindings as demoted
      where demoted.library_id = binding.library_id
        and demoted.binding_kind = binding.binding_kind
        and demoted.key_version = binding.key_version
        and demoted.lookup_key = binding.lookup_key
        and demoted.status = 'quarantine'
        and demoted.status_reason =
          'automatic-provider-exact-demoted:not-allowlisted:v1'
    )
    and not exists (
      select 1
      from public.lyrics_bindings as active_binding
      where active_binding.library_id = binding.library_id
        and active_binding.binding_kind = binding.binding_kind
        and active_binding.key_version = binding.key_version
        and active_binding.lookup_key = binding.lookup_key
        and active_binding.status = 'active'
    )
    and not exists (
      select 1
      from public.lyrics_bindings as rejected_binding
      where rejected_binding.library_id = binding.library_id
        and rejected_binding.binding_kind = binding.binding_kind
        and rejected_binding.key_version = binding.key_version
        and rejected_binding.lookup_key = binding.lookup_key
        and rejected_binding.status = 'rejected'
    )
  order by
    binding.library_id,
    binding.key_version,
    binding.lookup_key,
    binding.updated_at desc,
    binding.created_at desc,
    binding.id
)
update public.lyrics_bindings as binding
set
  status = 'active',
  selection_version = 0,
  status_reason = 'automatic-lrclib-exact-restored:provider-allowlist-v1',
  updated_at = transaction_timestamp(),
  superseded_at = null,
  superseded_by_binding_id = null
from restorable_lrclib
where binding.id = restorable_lrclib.id;

create function public.enqueue_apple_lyrics_backfill(
  p_library_id uuid,
  p_exact_key text,
  p_key_version integer,
  p_storefront text,
  p_locale text,
  p_track_metadata jsonb,
  p_provider_track_id text default null,
  p_isrc text default null,
  p_priority integer default 0,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_exact_key text := nullif(btrim(p_exact_key), '');
  v_storefront text := lower(nullif(btrim(p_storefront), ''));
  v_locale text := coalesce(nullif(btrim(p_locale), ''), 'und');
  v_provider_track_id text := nullif(btrim(p_provider_track_id), '');
  v_isrc text := upper(nullif(btrim(p_isrc), ''));
  v_track_metadata jsonb := coalesce(p_track_metadata, '{}'::jsonb);
  v_job_key text;
  v_job public.apple_lyrics_backfill_jobs%rowtype;
begin
  if not exists (
    select 1
    from public.lyrics_libraries as library
    where library.id = p_library_id
  ) then
    raise exception 'lyrics library does not exist'
      using errcode = '23503';
  end if;

  if v_exact_key is null or char_length(v_exact_key) > 512 then
    raise exception 'exact_key must contain between 1 and 512 characters'
      using errcode = '22023';
  end if;

  if p_key_version is null or p_key_version < 1 or p_key_version > 32767 then
    raise exception 'key_version must be between 1 and 32767'
      using errcode = '22023';
  end if;

  if v_storefront is null or v_storefront !~ '^[a-z]{2}$' then
    raise exception 'storefront must be a two-letter lowercase country code'
      using errcode = '22023';
  end if;

  if char_length(v_locale) > 35
    or v_locale !~ '^[A-Za-z0-9][A-Za-z0-9-]*$' then
    raise exception 'locale must be a valid 1-35 character language tag'
      using errcode = '22023';
  end if;

  if v_provider_track_id is not null
    and char_length(v_provider_track_id) > 512 then
    raise exception 'provider_track_id must not exceed 512 characters'
      using errcode = '22023';
  end if;

  if v_isrc is not null
    and (
      char_length(v_isrc) > 32
      or v_isrc !~ '^[A-Z0-9-]+$'
    ) then
    raise exception 'isrc must contain only uppercase letters, digits, or hyphens'
      using errcode = '22023';
  end if;

  if not private.is_valid_apple_lyrics_track_metadata(v_track_metadata)
    or octet_length(v_track_metadata::text) > 16384 then
    raise exception 'track_metadata must contain valid title, artist, duration_ms, album, and source fields within 16384 bytes'
      using errcode = '22023';
  end if;

  if p_priority is null or p_priority < -100 or p_priority > 100 then
    raise exception 'priority must be between -100 and 100'
      using errcode = '22023';
  end if;

  if p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 20 then
    raise exception 'max_attempts must be between 1 and 20'
      using errcode = '22023';
  end if;

  v_job_key := encode(
    extensions.digest(
      convert_to(
        jsonb_build_array(
          p_key_version,
          v_exact_key,
          v_storefront,
          lower(v_locale)
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'apple-backfill-job:' || p_library_id::text || ':' || v_job_key,
      0
    )
  );

  select job.*
  into v_job
  from public.apple_lyrics_backfill_jobs as job
  where job.library_id = p_library_id
    and job.job_key = v_job_key
  for update;

  if found then
    if v_job.provider_track_id is not null
      and v_provider_track_id is not null
      and v_job.provider_track_id <> v_provider_track_id then
      raise exception 'existing job is bound to a different Apple track id'
        using errcode = '23505';
    end if;

    if v_job.isrc is not null
      and v_isrc is not null
      and v_job.isrc <> v_isrc then
      raise exception 'existing job is bound to a different ISRC'
        using errcode = '23505';
    end if;

    update public.apple_lyrics_backfill_jobs as job
    set
      provider_track_id = case
        when job.status in ('pending', 'retry_wait')
          then coalesce(job.provider_track_id, v_provider_track_id)
        else job.provider_track_id
      end,
      isrc = case
        when job.status in ('pending', 'retry_wait')
          then coalesce(job.isrc, v_isrc)
        else job.isrc
      end,
      track_metadata = case
        when job.status in ('pending', 'retry_wait')
          then v_track_metadata
        else job.track_metadata
      end,
      priority = greatest(job.priority, p_priority),
      max_attempts = greatest(job.max_attempts, p_max_attempts),
      updated_at = v_now
    where job.id = v_job.id
    returning job.* into v_job;
  else
    insert into public.apple_lyrics_backfill_jobs (
      library_id,
      job_key,
      exact_key,
      key_version,
      storefront,
      locale,
      provider_track_id,
      isrc,
      track_metadata,
      priority,
      max_attempts
    )
    values (
      p_library_id,
      v_job_key,
      v_exact_key,
      p_key_version,
      v_storefront,
      v_locale,
      v_provider_track_id,
      v_isrc,
      v_track_metadata,
      p_priority,
      p_max_attempts
    )
    returning * into v_job;
  end if;

  return jsonb_build_object(
    'job_id', v_job.id,
    'status', v_job.status,
    'attempt_count', v_job.attempt_count,
    'max_attempts', v_job.max_attempts,
    'next_attempt_at', v_job.next_attempt_at,
    'created_at', v_job.created_at,
    'updated_at', v_job.updated_at
  );
end;
$$;

comment on function public.enqueue_apple_lyrics_backfill(
  uuid,
  text,
  integer,
  text,
  text,
  jsonb,
  text,
  text,
  integer,
  integer
) is
  'Idempotently enqueue metadata for isolated Apple TTML backfill. Repeated observations do not reset backoff or revive terminal jobs.';

-- Terminal rows remain idempotent during normal enqueue. Operators get a
-- separate, explicit redrive path for newly available lyrics, credential
-- repairs, or a parser/projection upgrade.
create function public.requeue_apple_lyrics_backfill(
  p_library_id uuid,
  p_job_id uuid,
  p_reason text default 'operator',
  p_max_attempts integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_reason text := lower(nullif(btrim(p_reason), ''));
  v_job public.apple_lyrics_backfill_jobs%rowtype;
begin
  if p_library_id is null or p_job_id is null then
    raise exception 'library_id and job_id are required'
      using errcode = '22023';
  end if;

  if v_reason is null
    or char_length(v_reason) > 128
    or v_reason !~ '^[a-z0-9][a-z0-9._:-]*$' then
    raise exception 'reason must be a safe 1-128 character identifier'
      using errcode = '22023';
  end if;

  if p_max_attempts is not null
    and (p_max_attempts < 1 or p_max_attempts > 20) then
    raise exception 'max_attempts must be between 1 and 20'
      using errcode = '22023';
  end if;

  select job.*
  into v_job
  from public.apple_lyrics_backfill_jobs as job
  where job.library_id = p_library_id
    and job.id = p_job_id
  for update;

  if not found then
    raise exception 'Apple backfill job does not exist'
      using errcode = '22023';
  end if;

  if v_job.status not in ('completed', 'dead_letter', 'cancelled') then
    raise exception 'only terminal Apple backfill jobs can be redriven'
      using errcode = '55000';
  end if;

  update public.apple_lyrics_backfill_jobs as job
  set
    status = 'pending',
    attempt_count = 0,
    max_attempts = coalesce(p_max_attempts, job.max_attempts),
    next_attempt_at = v_now,
    lease_token = null,
    lease_owner = null,
    lease_expires_at = null,
    last_error_code = null,
    resolved_storefront = null,
    document_id = null,
    revision_id = null,
    artifact_id = null,
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
    'next_attempt_at', v_job.next_attempt_at,
    'redrive_count', v_job.redrive_count,
    'last_redriven_at', v_job.last_redriven_at,
    'last_redrive_reason', v_job.last_redrive_reason
  );
end;
$$;

comment on function public.requeue_apple_lyrics_backfill(
  uuid,
  uuid,
  text,
  integer
) is
  'Explicitly redrive one terminal Apple backfill job while retaining a reason, timestamp, and cumulative redrive count.';

create function public.claim_apple_lyrics_backfill(
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

  -- A worker that dies on its last allowed attempt cannot leave a job in an
  -- unclaimable processing state forever.
  update public.apple_lyrics_backfill_jobs as job
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

  with candidates as (
    select job.id
    from public.apple_lyrics_backfill_jobs as job
    where job.library_id = p_library_id
      and job.attempt_count < job.max_attempts
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
    order by
      job.priority desc,
      job.next_attempt_at,
      job.created_at
    limit p_limit
    for update skip locked
  ),
  claimed as (
    update public.apple_lyrics_backfill_jobs as job
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
        'exact_key', claimed.exact_key,
        'key_version', claimed.key_version,
        'storefront', claimed.storefront,
        'locale', claimed.locale,
        'provider_track_id', claimed.provider_track_id,
        'isrc', claimed.isrc,
        'track_metadata', claimed.track_metadata
      )
      order by claimed.priority desc, claimed.next_attempt_at, claimed.created_at
    ),
    '[]'::jsonb
  )
  into v_jobs
  from claimed;

  return v_jobs;
end;
$$;

comment on function public.claim_apple_lyrics_backfill(
  uuid,
  text,
  integer,
  integer
) is
  'Atomically lease due Apple backfill jobs with SKIP LOCKED. Expired leases are reclaimable and the opaque lease token gates completion.';

create function public.fail_apple_lyrics_backfill(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_retryable boolean,
  p_retry_after_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_error_code text := lower(nullif(btrim(p_error_code), ''));
  v_job public.apple_lyrics_backfill_jobs%rowtype;
  v_next_status text;
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
  from public.apple_lyrics_backfill_jobs as job
  where job.id = p_job_id
  for update;

  if not found then
    raise exception 'Apple backfill job does not exist'
      using errcode = '22023';
  end if;

  if v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= v_now then
    raise exception 'Apple backfill lease is no longer valid'
      using errcode = '55000';
  end if;

  v_next_status := case
    when p_retryable and v_job.attempt_count < v_job.max_attempts
      then 'retry_wait'
    else 'dead_letter'
  end;

  update public.apple_lyrics_backfill_jobs as job
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

comment on function public.fail_apple_lyrics_backfill(
  uuid,
  uuid,
  text,
  boolean,
  integer
) is
  'Release a valid Apple backfill lease into bounded retry backoff or dead-letter. Error codes are identifiers only and must not contain credentials.';

-- Completing a job is also the only public path that writes Apple artifacts.
-- The normalized quarantine revision, immutable TTML artifact, and job
-- acknowledgement commit or roll back as one transaction.
create function public.complete_apple_lyrics_backfill(
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
  v_now timestamptz := transaction_timestamp();
  v_job public.apple_lyrics_backfill_jobs%rowtype;
  v_provider_track_id text := nullif(btrim(p_provider_track_id), '');
  v_storefront text := lower(nullif(btrim(p_storefront), ''));
  v_raw_metadata jsonb := coalesce(p_raw_metadata, '{}'::jsonb);
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_provenance jsonb := coalesce(p_provenance, '{}'::jsonb);
  v_locale text := nullif(btrim(p_locale), '');
  v_timing_mode text := lower(
    coalesce(nullif(btrim(p_timing_mode), ''), 'unknown')
  );
  v_recording_variant text := lower(
    coalesce(nullif(btrim(p_recording_variant), ''), 'unknown')
  );
  v_ttml_hash text;
  v_ttml_bytes integer;
  v_normalized_hash text;
  v_artifact_identity text;
  v_source_idempotency text;
  v_write_result jsonb;
  v_document_id uuid;
  v_revision_id uuid;
  v_artifact_id uuid;
begin
  if p_job_id is null or p_lease_token is null then
    raise exception 'job_id and lease_token are required'
      using errcode = '22023';
  end if;

  select job.*
  into v_job
  from public.apple_lyrics_backfill_jobs as job
  where job.id = p_job_id
  for update;

  if not found then
    raise exception 'Apple backfill job does not exist'
      using errcode = '22023';
  end if;

  if v_job.status <> 'processing'
    or v_job.lease_token is distinct from p_lease_token
    or v_job.lease_expires_at <= v_now then
    raise exception 'Apple backfill lease is no longer valid'
      using errcode = '55000';
  end if;

  v_locale := coalesce(v_locale, v_job.locale, 'und');

  if v_provider_track_id is null
    or char_length(v_provider_track_id) > 512 then
    raise exception 'provider_track_id must contain between 1 and 512 characters'
      using errcode = '22023';
  end if;

  if v_job.provider_track_id is not null
    and v_job.provider_track_id <> v_provider_track_id then
    raise exception 'provider_track_id does not match the claimed job'
      using errcode = '22023';
  end if;

  if v_storefront is null or v_storefront !~ '^[a-z]{2}$' then
    raise exception 'storefront must be a lowercase two-letter code'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_raw_metadata) <> 'object'
    or octet_length(v_raw_metadata::text) > 16384 then
    raise exception 'raw_metadata must be a JSON object no larger than 16384 bytes'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_payload) <> 'object'
    or octet_length(v_payload::text) > 1048576 then
    raise exception 'payload must be a JSON object no larger than 1048576 bytes'
      using errcode = '22023';
  end if;

  if v_payload ?| array['ttml', 'raw_ttml', 'rawTtml'] then
    raise exception 'raw TTML must be stored only in lyrics_source_artifacts'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_provenance) <> 'object'
    or octet_length(v_provenance::text) > 16384 then
    raise exception 'provenance must be a JSON object no larger than 16384 bytes'
      using errcode = '22023';
  end if;

  if char_length(v_locale) > 35
    or v_locale !~ '^[A-Za-z0-9][A-Za-z0-9-]*$' then
    raise exception 'locale must be a valid 1-35 character language tag'
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

  if char_length(v_recording_variant) > 128
    or v_recording_variant !~ '^[a-z0-9][a-z0-9._:-]*$' then
    raise exception 'recording_variant must be a safe 1-128 character identifier'
      using errcode = '22023';
  end if;

  if p_raw_ttml is null then
    raise exception 'raw_ttml is required'
      using errcode = '22023';
  end if;

  v_ttml_bytes := octet_length(p_raw_ttml);
  if v_ttml_bytes < 1 or v_ttml_bytes > 524288 then
    raise exception 'raw_ttml must contain between 1 and 524288 bytes'
      using errcode = '22023';
  end if;

  v_ttml_hash := encode(
    extensions.digest(convert_to(p_raw_ttml, 'UTF8'), 'sha256'),
    'hex'
  );

  v_source_idempotency := 'apple-ttml:v1:' || encode(
    extensions.digest(
      convert_to(
        jsonb_build_array(
          v_storefront,
          v_provider_track_id,
          lower(v_locale),
          v_timing_mode,
          v_recording_variant
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- Caller-supplied provenance cannot spoof the provider identity or switch
  -- this ingestion path into another document identity.
  v_provenance := (
    v_provenance
      - 'selection_version'
      - 'selectionVersion'
      - 'artifact_sha256'
      - 'artifactSha256'
  ) || jsonb_build_object(
    'provider_name', 'apple',
    'provider_track_id', v_provider_track_id,
    'idempotency_key', v_source_idempotency,
    'source_format', 'ttml',
    'storefront', v_storefront,
    'requested_storefront', v_job.storefront,
    'locale', v_locale,
    'timing_mode', v_timing_mode,
    'recording_variant', v_recording_variant,
    'artifact_sha256', v_ttml_hash,
    'backfill_job_id', v_job.id,
    'status_reason', 'automatic-apple-exact-quarantine:v1'
  );

  if octet_length(v_provenance::text) > 16384 then
    raise exception 'merged provenance must not exceed 16384 bytes'
      using errcode = '22023';
  end if;

  v_write_result := public.upsert_lyrics_document(
    v_job.library_id,
    v_job.exact_key,
    null,
    v_job.key_version,
    v_raw_metadata,
    v_payload,
    v_provenance,
    'provider'::public.lyrics_acquisition,
    'quarantine'::public.lyrics_status
  );

  v_document_id := nullif(v_write_result ->> 'document_id', '')::uuid;
  v_revision_id := nullif(v_write_result ->> 'revision_id', '')::uuid;
  v_normalized_hash := nullif(v_write_result ->> 'content_hash', '');
  if v_document_id is null or v_revision_id is null then
    raise exception 'normalized Apple lyrics write did not produce a revision'
      using errcode = '55000';
  end if;

  if not exists (
    select 1
    from public.lyrics_revisions as revision
    join public.lyrics_documents as document
      on document.id = revision.document_id
    where revision.id = v_revision_id
      and document.id = v_document_id
      and document.library_id = v_job.library_id
  ) then
    raise exception 'normalized Apple revision does not belong to the job library'
      using errcode = '23514';
  end if;

  if v_normalized_hash is null
    or v_normalized_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'normalized Apple lyrics write did not produce a content hash'
      using errcode = '55000';
  end if;

  -- An artifact snapshot belongs to one storefront and one normalized
  -- projection. Including the normalized hash keeps reprocessing with a newer
  -- parser from reusing an artifact linked to an older revision.
  v_artifact_identity := encode(
    extensions.digest(
      convert_to(
        jsonb_build_array(
          'ttml-artifact-v1',
          'apple',
          v_storefront,
          v_provider_track_id,
          v_job.key_version,
          v_job.exact_key,
          lower(v_locale),
          v_timing_mode,
          v_recording_variant,
          'apple-ttml-line-model-v1',
          v_ttml_hash,
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
    fetched_at
  )
  values (
    v_job.library_id,
    v_revision_id,
    'apple',
    v_provider_track_id,
    v_storefront,
    v_job.exact_key,
    v_job.key_version,
    v_locale,
    v_timing_mode,
    v_recording_variant,
    'apple-ttml-line-model-v1',
    p_raw_ttml,
    v_ttml_hash,
    v_ttml_bytes,
    v_artifact_identity,
    v_now
  )
  on conflict (library_id, artifact_identity) do nothing
  returning id into v_artifact_id;

  if v_artifact_id is null then
    select artifact.id
    into v_artifact_id
    from public.lyrics_source_artifacts as artifact
    where artifact.library_id = v_job.library_id
      and artifact.artifact_identity = v_artifact_identity
      and artifact.revision_id = v_revision_id;
  end if;

  if v_artifact_id is null then
    raise exception 'Apple TTML artifact was not persisted'
      using errcode = '55000';
  end if;

  update public.apple_lyrics_backfill_jobs as job
  set
    status = 'completed',
    provider_track_id = v_provider_track_id,
    resolved_storefront = v_storefront,
    lease_token = null,
    lease_owner = null,
    lease_expires_at = null,
    last_error_code = null,
    document_id = v_document_id,
    revision_id = v_revision_id,
    artifact_id = v_artifact_id,
    completed_at = v_now,
    updated_at = v_now
  where job.id = v_job.id
    and job.status = 'processing'
    and job.lease_token = p_lease_token
    and job.lease_expires_at > v_now;

  if not found then
    raise exception 'Apple backfill lease was lost before commit'
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'job_id', v_job.id,
    'status', 'completed',
    'document_id', v_document_id,
    'revision_id', v_revision_id,
    'artifact_id', v_artifact_id,
    'normalized_content_hash', v_write_result ->> 'content_hash',
    'artifact_content_hash', v_ttml_hash,
    'artifact_bytes', v_ttml_bytes,
    'storefront', v_storefront,
    'effective_status', v_write_result ->> 'effective_status',
    'promotion_blocked', coalesce(
      (v_write_result ->> 'promotion_blocked')::boolean,
      false
    ),
    'promotion_block_reason', v_write_result ->> 'promotion_block_reason'
  );
end;
$$;

comment on function public.complete_apple_lyrics_backfill(
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
  'Atomically write a normalized quarantined Apple revision, its immutable raw TTML artifact, and the leased job acknowledgement. Returns identifiers and hashes only.';

alter table public.lyrics_source_artifacts enable row level security;
alter table public.apple_lyrics_backfill_jobs enable row level security;

revoke all on table public.lyrics_source_artifacts
  from public, anon, authenticated, service_role;
revoke all on table public.apple_lyrics_backfill_jobs
  from public, anon, authenticated, service_role;

revoke all on function public.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) from public, anon, authenticated, service_role;
revoke all on function public.enqueue_apple_lyrics_backfill(
  uuid,
  text,
  integer,
  text,
  text,
  jsonb,
  text,
  text,
  integer,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.requeue_apple_lyrics_backfill(
  uuid,
  uuid,
  text,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.claim_apple_lyrics_backfill(
  uuid,
  text,
  integer,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.fail_apple_lyrics_backfill(
  uuid,
  uuid,
  text,
  boolean,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.complete_apple_lyrics_backfill(
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

grant execute on function public.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) to service_role;
grant execute on function public.enqueue_apple_lyrics_backfill(
  uuid,
  text,
  integer,
  text,
  text,
  jsonb,
  text,
  text,
  integer,
  integer
) to service_role;
grant execute on function public.requeue_apple_lyrics_backfill(
  uuid,
  uuid,
  text,
  integer
) to service_role;
grant execute on function public.claim_apple_lyrics_backfill(
  uuid,
  text,
  integer,
  integer
) to service_role;
grant execute on function public.fail_apple_lyrics_backfill(
  uuid,
  uuid,
  text,
  boolean,
  integer
) to service_role;
grant execute on function public.complete_apple_lyrics_backfill(
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

comment on table public.lyrics_bindings is
  'Versioned exact/work lookup aliases. LRCLIB exact provider results may auto-promote at selection_version 0; Apple and unknown providers remain quarantined; manual/candidate selections and rejection remain protected.';
