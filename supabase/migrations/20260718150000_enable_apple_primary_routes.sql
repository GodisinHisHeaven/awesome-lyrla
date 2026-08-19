-- Apple-primary is a reversible routing policy, not a binding-state rewrite.
-- LRCLIB remains the active Exact binding and therefore the durable fallback.
-- An Apple route pins one immutable normalized revision and its completed v2
-- source artifact; it never follows lyrics_documents.is_current implicitly.

create table public.lyrics_provider_routing_config (
  library_id uuid primary key
    references public.lyrics_libraries(id) on delete cascade,
  apple_primary_enabled boolean not null default false,
  policy_version text not null default 'apple-primary-v1',
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint lyrics_provider_routing_config_policy
    check (policy_version = 'apple-primary-v1')
);

comment on table public.lyrics_provider_routing_config is
  'Per-library provider-routing kill switch. Disabling Apple primary changes no document, revision, binding, or artifact state.';

create trigger lyrics_provider_routing_config_set_updated_at
before update on public.lyrics_provider_routing_config
for each row execute function private.set_updated_at();

create table public.apple_lyrics_primary_blocks (
  library_id uuid not null
    references public.lyrics_libraries(id) on delete cascade,
  key_version smallint not null,
  exact_key text not null,
  is_active boolean not null default true,
  anomaly_code text not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (library_id, key_version, exact_key),
  constraint apple_lyrics_primary_blocks_key_version
    check (key_version > 0),
  constraint apple_lyrics_primary_blocks_exact_key
    check (char_length(exact_key) between 1 and 512),
  constraint apple_lyrics_primary_blocks_anomaly_code
    check (
      char_length(anomaly_code) between 1 and 128
      and anomaly_code = lower(btrim(anomaly_code))
      and anomaly_code ~ '^[a-z0-9][a-z0-9._:-]*$'
    )
);

comment on table public.apple_lyrics_primary_blocks is
  'Persistent operator-reviewed hard-anomaly blocks. An active block prevents Apple routing for the Exact key without deleting any lyrics.';

create trigger apple_lyrics_primary_blocks_set_updated_at
before update on public.apple_lyrics_primary_blocks
for each row execute function private.set_updated_at();

create table public.apple_lyrics_primary_routes (
  library_id uuid not null
    references public.lyrics_libraries(id) on delete cascade,
  key_version smallint not null,
  exact_key text not null,
  binding_id uuid not null,
  document_id uuid not null,
  revision_id uuid not null
    references public.lyrics_revisions(id) on delete cascade,
  artifact_id uuid not null,
  revision_content_hash text not null,
  source_snapshot_at timestamptz not null,
  source_snapshot_id uuid not null,
  artifact_fetched_at timestamptz not null,
  enabled boolean not null default true,
  disabled_reason text,
  policy_version text not null default 'apple-primary-v1',
  route_version bigint not null default 1,
  promoted_at timestamptz not null default transaction_timestamp(),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (library_id, key_version, exact_key),
  constraint apple_lyrics_primary_routes_binding_fk
    foreign key (library_id, binding_id)
    references public.lyrics_bindings(library_id, id)
    on delete cascade,
  constraint apple_lyrics_primary_routes_document_fk
    foreign key (library_id, document_id)
    references public.lyrics_documents(library_id, id)
    on delete cascade,
  constraint apple_lyrics_primary_routes_artifact_fk
    foreign key (library_id, artifact_id)
    references public.lyrics_source_artifacts(library_id, id)
    on delete cascade,
  constraint apple_lyrics_primary_routes_key_version
    check (key_version > 0),
  constraint apple_lyrics_primary_routes_exact_key
    check (char_length(exact_key) between 1 and 512),
  constraint apple_lyrics_primary_routes_content_hash
    check (revision_content_hash ~ '^[0-9a-f]{64}$'),
  constraint apple_lyrics_primary_routes_policy
    check (policy_version = 'apple-primary-v1'),
  constraint apple_lyrics_primary_routes_version
    check (route_version > 0),
  constraint apple_lyrics_primary_routes_disabled_reason
    check (
      (
        enabled
        and disabled_reason is null
      )
      or
      (
        not enabled
        and disabled_reason is not null
        and char_length(disabled_reason) between 1 and 128
        and disabled_reason ~ '^[a-z0-9][a-z0-9._:-]*$'
      )
    )
);

comment on table public.apple_lyrics_primary_routes is
  'Reversible Apple-primary pins. Each enabled row fixes an immutable Apple revision plus completed v2 artifact; LRCLIB bindings remain untouched as fallback.';

create index apple_lyrics_primary_routes_document
  on public.apple_lyrics_primary_routes (library_id, document_id);

create index apple_lyrics_primary_routes_artifact
  on public.apple_lyrics_primary_routes (library_id, artifact_id);

create index apple_lyrics_primary_routes_revision
  on public.apple_lyrics_primary_routes (revision_id);

-- Backfill jobs can be intentionally redriven and then point at a newer
-- artifact. Preserve the fact that an immutable v2 artifact once completed so
-- a later v1 rolling-deploy write cannot erase the evidence behind an existing
-- route pin.
create table public.apple_lyrics_v2_completion_evidence (
  library_id uuid not null
    references public.lyrics_libraries(id) on delete cascade,
  artifact_id uuid not null,
  revision_id uuid not null
    references public.lyrics_revisions(id) on delete cascade,
  completion_kind text not null,
  completion_job_id uuid not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (library_id, artifact_id, revision_id),
  constraint apple_lyrics_v2_completion_evidence_artifact_fk
    foreign key (library_id, artifact_id)
    references public.lyrics_source_artifacts(library_id, id)
    on delete cascade,
  constraint apple_lyrics_v2_completion_evidence_kind
    check (completion_kind in ('backfill', 'reprojection'))
);

comment on table public.apple_lyrics_v2_completion_evidence is
  'Append-only proof that an immutable Apple v2 artifact completed through a leased backfill or retained-TTML reprojection RPC, even if its mutable job is later redriven.';

create index apple_lyrics_v2_completion_evidence_revision
  on public.apple_lyrics_v2_completion_evidence (
    revision_id,
    library_id,
    artifact_id
  );

create index apple_lyrics_backfill_jobs_completed_artifact
  on public.apple_lyrics_backfill_jobs (
    library_id,
    artifact_id,
    revision_id
  )
  where status = 'completed' and artifact_id is not null;

create index apple_lyrics_reprojection_jobs_completed_artifact
  on public.apple_lyrics_reprojection_jobs (
    library_id,
    result_artifact_id,
    result_revision_id
  )
  where status = 'completed' and result_artifact_id is not null;

insert into public.apple_lyrics_v2_completion_evidence (
  library_id,
  artifact_id,
  revision_id,
  completion_kind,
  completion_job_id,
  completed_at
)
select
  job.library_id,
  job.artifact_id,
  job.revision_id,
  'backfill',
  job.id,
  coalesce(job.completed_at, job.updated_at)
from public.apple_lyrics_backfill_jobs as job
join public.lyrics_source_artifacts as artifact
  on artifact.library_id = job.library_id
  and artifact.id = job.artifact_id
  and artifact.revision_id = job.revision_id
where job.status = 'completed'
  and artifact.provider_name = 'apple'
  and artifact.projection_version = 'apple-ttml-line-model-v2'
on conflict (library_id, artifact_id, revision_id) do nothing;

insert into public.apple_lyrics_v2_completion_evidence (
  library_id,
  artifact_id,
  revision_id,
  completion_kind,
  completion_job_id,
  completed_at
)
select
  job.library_id,
  job.result_artifact_id,
  job.result_revision_id,
  'reprojection',
  job.id,
  coalesce(job.completed_at, job.updated_at)
from public.apple_lyrics_reprojection_jobs as job
join public.lyrics_source_artifacts as artifact
  on artifact.library_id = job.library_id
  and artifact.id = job.result_artifact_id
  and artifact.revision_id = job.result_revision_id
where job.status = 'completed'
  and artifact.provider_name = 'apple'
  and artifact.projection_version = 'apple-ttml-line-model-v2'
on conflict (library_id, artifact_id, revision_id) do nothing;

create trigger apple_lyrics_primary_routes_set_updated_at
before update on public.apple_lyrics_primary_routes
for each row execute function private.set_updated_at();

-- Return a fixed, non-sensitive anomaly identifier for normalized line LRC.
-- A null result means the payload passes the hard structural gate. This is
-- intentionally stricter than the browser parser and is never a fuzzy
-- quality score.
create function private.apple_synced_payload_hard_anomaly(
  p_synced_lyrics text,
  p_plain_lyrics text,
  p_is_instrumental boolean,
  p_provenance jsonb
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
  v_previous_ms bigint := -1;
  v_nonempty_lines integer := 0;
begin
  if coalesce(p_is_instrumental, false) then
    return 'instrumental-payload';
  end if;

  if p_synced_lyrics is null or btrim(p_synced_lyrics) = '' then
    return 'missing-synced-lyrics';
  end if;

  if octet_length(p_synced_lyrics) > 524288 then
    return 'synced-lyrics-too-large';
  end if;

  if p_plain_lyrics is null or btrim(p_plain_lyrics) = '' then
    return 'missing-plain-lyrics';
  end if;

  if octet_length(p_plain_lyrics) > 524288 then
    return 'plain-lyrics-too-large';
  end if;

  if coalesce(p_provenance ->> 'exact_identity_proof_version', '') <> '1' then
    return 'missing-exact-proof';
  end if;

  if coalesce(
    jsonb_typeof(p_provenance -> 'exact_identity_evidence'),
    ''
  ) <> 'array' then
    return 'missing-exact-proof';
  end if;

  if jsonb_array_length(p_provenance -> 'exact_identity_evidence') < 1 then
    return 'missing-exact-proof';
  end if;

  v_lines := regexp_split_to_array(
    replace(p_synced_lyrics, E'\r\n', E'\n'),
    E'\n'
  );

  if cardinality(v_lines) < 1 or cardinality(v_lines) > 5000 then
    return 'invalid-line-count';
  end if;

  foreach v_line in array v_lines
  loop
    v_match := regexp_match(
      v_line,
      '^\[([0-9]{2,4}):([0-5][0-9])\.([0-9]{3})\](.*)$'
    );
    if v_match is null then
      return 'invalid-lrc-line';
    end if;

    v_start_ms :=
      v_match[1]::bigint * 60000
      + v_match[2]::bigint * 1000
      + v_match[3]::bigint;

    if v_start_ms < v_previous_ms then
      return 'nonmonotonic-timestamps';
    end if;

    if v_start_ms > 86400000 then
      return 'timestamp-absolute-limit';
    end if;

    if btrim(v_match[4]) <> '' then
      v_nonempty_lines := v_nonempty_lines + 1;
    end if;

    v_previous_ms := v_start_ms;
  end loop;

  if v_nonempty_lines < 1 then
    return 'empty-synced-lines';
  end if;

  return null;
end;
$$;

revoke all on function private.apple_synced_payload_hard_anomaly(
  text,
  text,
  boolean,
  jsonb
) from public, anon, authenticated, service_role;

-- This is the minimal immutable evidence boundary. Static artifacts are
-- included here so a newer static v2 snapshot can invalidate an older synced
-- route. Payload quality is checked only after the newest snapshot is chosen.
create function private.is_completed_apple_v2_artifact(
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
      and artifact.projection_version = 'apple-ttml-line-model-v2'
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
        or
        exists (
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

revoke all on function private.is_completed_apple_v2_artifact(
  uuid,
  uuid,
  uuid,
  uuid
) from public, anon, authenticated, service_role;

create function private.apple_primary_candidate_rejection_code(
  p_library_id uuid,
  p_binding_id uuid,
  p_revision_id uuid,
  p_artifact_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_anomaly text;
begin
  select
    binding.id as binding_id,
    binding.binding_kind,
    binding.key_version,
    binding.lookup_key,
    binding.status,
    binding.selection_method,
    binding.selection_version,
    document.id as document_id,
    revision.id as revision_id,
    revision.content_hash,
    revision.synced_lyrics,
    revision.plain_lyrics,
    revision.is_instrumental,
    revision.duration_ms,
    revision.provenance,
    artifact.id as artifact_id,
    artifact.timing_mode,
    artifact.provider_track_id
  into v_row
  from public.lyrics_bindings as binding
  join public.lyrics_documents as document
    on document.library_id = binding.library_id
    and document.id = binding.document_id
  join public.lyrics_revisions as revision
    on revision.document_id = document.id
    and revision.id = p_revision_id
  join public.lyrics_source_artifacts as artifact
    on artifact.library_id = binding.library_id
    and artifact.revision_id = revision.id
    and artifact.id = p_artifact_id
  where binding.library_id = p_library_id
    and binding.id = p_binding_id;

  if not found then
    return 'invalid-artifact-linkage';
  end if;

  if not private.is_completed_apple_v2_artifact(
    p_library_id,
    p_binding_id,
    p_revision_id,
    p_artifact_id
  ) then
    return 'uncompleted-v2-artifact';
  end if;

  if v_row.binding_kind <> 'exact'
    or v_row.status <> 'quarantine'
    or v_row.selection_method <> 'provider'
    or v_row.selection_version is not null then
    return 'binding-not-automatic-quarantine';
  end if;

  if v_row.timing_mode not in ('line', 'word', 'syllable') then
    return 'static-or-unsupported-timing';
  end if;

  v_anomaly := private.apple_synced_payload_hard_anomaly(
    v_row.synced_lyrics,
    v_row.plain_lyrics,
    v_row.is_instrumental,
    v_row.provenance
  );
  if v_anomaly is not null then
    return v_anomaly;
  end if;

  if exists (
    select 1
    from public.apple_lyrics_primary_blocks as block
    where block.library_id = p_library_id
      and block.key_version = v_row.key_version
      and block.exact_key = v_row.lookup_key
      and block.is_active
  ) then
    return 'operator-hard-anomaly';
  end if;

  -- Rejection is a key-level human protection, matching the pre-existing
  -- automatic provider promotion policy.
  if exists (
    select 1
    from public.lyrics_bindings as rejected
    where rejected.library_id = p_library_id
      and rejected.binding_kind = 'exact'
      and rejected.key_version = v_row.key_version
      and rejected.lookup_key = v_row.lookup_key
      and rejected.status = 'rejected'
  ) then
    return 'exact-key-rejected';
  end if;

  -- A route reads a pinned revision directly. Do not create one for a source
  -- document that is already reachable through any active alias.
  if exists (
    select 1
    from public.lyrics_bindings as active_alias
    where active_alias.library_id = p_library_id
      and active_alias.document_id = v_row.document_id
      and active_alias.status = 'active'
  ) then
    return 'apple-document-already-active';
  end if;

  return null;
end;
$$;

revoke all on function private.apple_primary_candidate_rejection_code(
  uuid,
  uuid,
  uuid,
  uuid
) from public, anon, authenticated, service_role;

create function private.apple_primary_completed_document_count(
  p_library_id uuid,
  p_exact_key text,
  p_key_version integer
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct revision.document_id)::integer
  from public.lyrics_source_artifacts as artifact
  join public.lyrics_revisions as revision
    on revision.id = artifact.revision_id
  join public.lyrics_bindings as binding
    on binding.library_id = artifact.library_id
    and binding.document_id = revision.document_id
    and binding.binding_kind = 'exact'
    and binding.key_version = artifact.key_version
    and binding.lookup_key = artifact.exact_key
  where artifact.library_id = p_library_id
    and artifact.exact_key = p_exact_key
    and artifact.key_version = p_key_version
    and private.is_completed_apple_v2_artifact(
      artifact.library_id,
      binding.id,
      revision.id,
      artifact.id
    );
$$;

revoke all on function private.apple_primary_completed_document_count(
  uuid,
  text,
  integer
) from public, anon, authenticated, service_role;

create function private.is_apple_primary_route_valid(
  p_library_id uuid,
  p_exact_key text,
  p_key_version integer,
  p_binding_id uuid,
  p_document_id uuid,
  p_revision_id uuid,
  p_artifact_id uuid,
  p_revision_content_hash text,
  p_source_snapshot_at timestamptz,
  p_source_snapshot_id uuid,
  p_artifact_fetched_at timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_linked boolean;
  v_pinned_revision_number bigint;
begin
  if private.apple_primary_completed_document_count(
    p_library_id,
    p_exact_key,
    p_key_version
  ) <> 1 then
    return false;
  end if;

  select exists (
    select 1
    from public.lyrics_bindings as binding
    join public.lyrics_revisions as revision
      on revision.document_id = binding.document_id
      and revision.id = p_revision_id
    join public.lyrics_source_artifacts as artifact
      on artifact.library_id = binding.library_id
      and artifact.revision_id = revision.id
      and artifact.id = p_artifact_id
    left join public.lyrics_source_artifacts as source_artifact
      on source_artifact.library_id = artifact.library_id
      and source_artifact.id = artifact.derived_from_artifact_id
    where binding.library_id = p_library_id
      and binding.id = p_binding_id
      and binding.document_id = p_document_id
      and binding.binding_kind = 'exact'
      and binding.key_version = p_key_version
      and binding.lookup_key = p_exact_key
      and revision.content_hash = p_revision_content_hash
      and coalesce(source_artifact.fetched_at, artifact.fetched_at)
        = p_source_snapshot_at
      and coalesce(source_artifact.id, artifact.id)
        = p_source_snapshot_id
      and artifact.fetched_at = p_artifact_fetched_at
      and private.apple_primary_candidate_rejection_code(
        p_library_id,
        p_binding_id,
        p_revision_id,
        p_artifact_id
      ) is null
  )
  into v_linked;

  if not v_linked then
    return false;
  end if;

  select revision.revision_number
  into v_pinned_revision_number
  from public.lyrics_revisions as revision
  where revision.id = p_revision_id
    and revision.document_id = p_document_id;

  if not found then
    return false;
  end if;

  -- The pin must be the newest completed v2 source snapshot for its one
  -- unambiguous Apple document. Newest is chosen before synced eligibility,
  -- so a newer static/bad snapshot invalidates an older synced route.
  return not exists (
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
    where newer.library_id = p_library_id
      and newer.exact_key = p_exact_key
      and newer.key_version = p_key_version
      and newer_revision.document_id = p_document_id
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
        p_source_snapshot_at,
        v_pinned_revision_number,
        p_source_snapshot_id,
        p_artifact_fetched_at,
        p_artifact_id
      )
  );
end;
$$;

revoke all on function private.is_apple_primary_route_valid(
  uuid,
  text,
  integer,
  uuid,
  uuid,
  uuid,
  uuid,
  text,
  timestamptz,
  uuid,
  timestamptz
) from public, anon, authenticated, service_role;

create function private.refresh_apple_primary_route_for_key(
  p_library_id uuid,
  p_exact_key text,
  p_key_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exact_key text := nullif(btrim(p_exact_key), '');
  v_document_count integer;
  v_candidate record;
  v_rejection_code text;
  v_route_unchanged boolean := false;
  v_route public.apple_lyrics_primary_routes%rowtype;
begin
  if v_exact_key is null or char_length(v_exact_key) > 512 then
    raise exception 'exact_key must contain between 1 and 512 characters'
      using errcode = '22023';
  end if;

  if p_key_version is null or p_key_version < 1 or p_key_version > 32767 then
    raise exception 'key_version must be between 1 and 32767'
      using errcode = '22023';
  end if;

  -- This is deliberately the only concurrency lock acquired by refresh. Every
  -- legal Exact write uses the same advisory lock before its CAS. Taking a
  -- document/binding row lock here would form a cycle because direct backfill
  -- and retained-TTML reprojection reach those locks in different orders.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_library_id::text || ':exact:' || p_key_version::text || ':'
      || v_exact_key,
      0
    )
  );

  -- Recompute the complete candidate set only after serialization. Route state
  -- below is therefore a CAS over a stable Exact-key snapshot.

  v_document_count := private.apple_primary_completed_document_count(
    p_library_id,
    v_exact_key,
    p_key_version
  );

  if v_document_count <> 1 then
    update public.apple_lyrics_primary_routes as route
    set
      enabled = false,
      disabled_reason = case
        when v_document_count = 0 then 'no-completed-apple-v2'
        else 'ambiguous-apple-documents'
      end,
      route_version = route.route_version + 1,
      updated_at = transaction_timestamp()
    where route.library_id = p_library_id
      and route.key_version = p_key_version
      and route.exact_key = v_exact_key
      and (
        route.enabled
        or route.disabled_reason is distinct from case
          when v_document_count = 0 then 'no-completed-apple-v2'
          else 'ambiguous-apple-documents'
        end
      )
    returning route.* into v_route;

    return jsonb_build_object(
      'state', 'fallback',
      'reason', case
        when v_document_count = 0 then 'no-completed-apple-v2'
        else 'ambiguous-apple-documents'
      end,
      'eligible_document_count', v_document_count,
      'changed', found
    );
  end if;

  -- Select the newest completed source snapshot before evaluating whether its
  -- normalized payload is synced. Never fall back to an older Apple snapshot:
  -- a newest static/invalid snapshot must return this key to LRCLIB.
  select
    binding.id as binding_id,
    binding.document_id,
    revision.id as revision_id,
    revision.content_hash as revision_content_hash,
    artifact.id as artifact_id,
    coalesce(source_artifact.fetched_at, artifact.fetched_at)
      as source_snapshot_at,
    coalesce(source_artifact.id, artifact.id) as source_snapshot_id,
    artifact.fetched_at as artifact_fetched_at
  into v_candidate
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
  where artifact.library_id = p_library_id
    and artifact.exact_key = v_exact_key
    and artifact.key_version = p_key_version
    and private.is_completed_apple_v2_artifact(
      artifact.library_id,
      binding.id,
      revision.id,
      artifact.id
    )
  order by
    coalesce(source_artifact.fetched_at, artifact.fetched_at) desc,
    revision.revision_number desc,
    coalesce(source_artifact.id, artifact.id) desc,
    artifact.fetched_at desc,
    artifact.id desc
  limit 1;

  if not found then
    raise exception 'completed Apple v2 document count lost its candidate'
      using errcode = '40001';
  end if;

  v_rejection_code := private.apple_primary_candidate_rejection_code(
    p_library_id,
    v_candidate.binding_id,
    v_candidate.revision_id,
    v_candidate.artifact_id
  );

  if v_rejection_code is not null then
    update public.apple_lyrics_primary_routes as route
    set
      enabled = false,
      disabled_reason = v_rejection_code,
      route_version = route.route_version + 1,
      updated_at = transaction_timestamp()
    where route.library_id = p_library_id
      and route.key_version = p_key_version
      and route.exact_key = v_exact_key
      and (
        route.enabled
        or route.disabled_reason is distinct from v_rejection_code
      )
    returning route.* into v_route;

    return jsonb_build_object(
      'state', 'fallback',
      'reason', v_rejection_code,
      'eligible_document_count', 1,
      'changed', found
    );
  end if;

  select coalesce(
    (
      select route.enabled
        and route.binding_id = v_candidate.binding_id
        and route.revision_id = v_candidate.revision_id
        and route.artifact_id = v_candidate.artifact_id
      from public.apple_lyrics_primary_routes as route
      where route.library_id = p_library_id
        and route.key_version = p_key_version
        and route.exact_key = v_exact_key
    ),
    false
  )
  into v_route_unchanged;

  if v_route_unchanged then
    select route.*
    into strict v_route
    from public.apple_lyrics_primary_routes as route
    where route.library_id = p_library_id
      and route.key_version = p_key_version
      and route.exact_key = v_exact_key;

    return jsonb_build_object(
      'state', 'apple-primary',
      'reason', null,
      'eligible_document_count', 1,
      'changed', false,
      'route_version', v_route.route_version
    );
  end if;

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
    disabled_reason,
    policy_version,
    route_version,
    promoted_at
  )
  values (
    p_library_id,
    p_key_version,
    v_exact_key,
    v_candidate.binding_id,
    v_candidate.document_id,
    v_candidate.revision_id,
    v_candidate.artifact_id,
    v_candidate.revision_content_hash,
    v_candidate.source_snapshot_at,
    v_candidate.source_snapshot_id,
    v_candidate.artifact_fetched_at,
    true,
    null,
    'apple-primary-v1',
    1,
    transaction_timestamp()
  )
  on conflict (library_id, key_version, exact_key)
  do update set
    binding_id = excluded.binding_id,
    document_id = excluded.document_id,
    revision_id = excluded.revision_id,
    artifact_id = excluded.artifact_id,
    revision_content_hash = excluded.revision_content_hash,
    source_snapshot_at = excluded.source_snapshot_at,
    source_snapshot_id = excluded.source_snapshot_id,
    artifact_fetched_at = excluded.artifact_fetched_at,
    enabled = true,
    disabled_reason = null,
    policy_version = excluded.policy_version,
    route_version = case
      when apple_lyrics_primary_routes.binding_id = excluded.binding_id
        and apple_lyrics_primary_routes.revision_id = excluded.revision_id
        and apple_lyrics_primary_routes.artifact_id = excluded.artifact_id
        and apple_lyrics_primary_routes.enabled
        then apple_lyrics_primary_routes.route_version
      else apple_lyrics_primary_routes.route_version + 1
    end,
    promoted_at = case
      when apple_lyrics_primary_routes.binding_id = excluded.binding_id
        and apple_lyrics_primary_routes.revision_id = excluded.revision_id
        and apple_lyrics_primary_routes.artifact_id = excluded.artifact_id
        and apple_lyrics_primary_routes.enabled
        then apple_lyrics_primary_routes.promoted_at
      else transaction_timestamp()
    end,
    updated_at = case
      when apple_lyrics_primary_routes.binding_id = excluded.binding_id
        and apple_lyrics_primary_routes.revision_id = excluded.revision_id
        and apple_lyrics_primary_routes.artifact_id = excluded.artifact_id
        and apple_lyrics_primary_routes.enabled
        then apple_lyrics_primary_routes.updated_at
      else transaction_timestamp()
    end
  returning * into v_route;

  return jsonb_build_object(
    'state', 'apple-primary',
    'reason', null,
    'eligible_document_count', 1,
    'changed', true,
    'route_version', v_route.route_version
  );
end;
$$;

revoke all on function private.refresh_apple_primary_route_for_key(
  uuid,
  text,
  integer
) from public, anon, authenticated, service_role;

create function public.refresh_apple_lyrics_primary_routes(
  p_library_id uuid,
  p_limit integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key record;
  v_result jsonb;
  v_scanned integer := 0;
  v_apple_primary integer := 0;
  v_fallback integer := 0;
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'apple-primary-refresh:' || p_library_id::text,
      0
    )
  );

  for v_key in
    select candidate.exact_key, candidate.key_version
    from (
      select artifact.exact_key, artifact.key_version::integer
      from public.lyrics_source_artifacts as artifact
      where artifact.library_id = p_library_id
        and artifact.provider_name = 'apple'
        and artifact.projection_version = 'apple-ttml-line-model-v2'
      union
      select route.exact_key, route.key_version::integer
      from public.apple_lyrics_primary_routes as route
      where route.library_id = p_library_id
    ) as candidate
    order by candidate.key_version, candidate.exact_key
    limit p_limit
  loop
    v_result := private.refresh_apple_primary_route_for_key(
      p_library_id,
      v_key.exact_key,
      v_key.key_version
    );
    v_scanned := v_scanned + 1;
    if v_result ->> 'state' = 'apple-primary' then
      v_apple_primary := v_apple_primary + 1;
    else
      v_fallback := v_fallback + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'policy_version', 'apple-primary-v1',
    'scanned', v_scanned,
    'apple_primary', v_apple_primary,
    'fallback', v_fallback
  );
end;
$$;

comment on function public.refresh_apple_lyrics_primary_routes(
  uuid,
  integer
) is
  'Idempotently recompute immutable Apple-primary pins from completed v2 evidence. Multiple Apple documents fail closed; one document uses its newest source snapshot before quality validation.';

create function public.set_apple_lyrics_primary_enabled(
  p_library_id uuid,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config public.lyrics_provider_routing_config%rowtype;
begin
  if p_enabled is null then
    raise exception 'enabled is required'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.lyrics_libraries as library
    where library.id = p_library_id
  ) then
    raise exception 'lyrics library does not exist'
      using errcode = '23503';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'apple-primary-config:' || p_library_id::text,
      0
    )
  );

  insert into public.lyrics_provider_routing_config (
    library_id,
    apple_primary_enabled,
    policy_version
  )
  values (
    p_library_id,
    p_enabled,
    'apple-primary-v1'
  )
  on conflict (library_id)
  do update set
    apple_primary_enabled = excluded.apple_primary_enabled,
    policy_version = excluded.policy_version,
    updated_at = transaction_timestamp()
  returning * into v_config;

  return jsonb_build_object(
    'library_id', v_config.library_id,
    'apple_primary_enabled', v_config.apple_primary_enabled,
    'policy_version', v_config.policy_version,
    'updated_at', v_config.updated_at
  );
end;
$$;

comment on function public.set_apple_lyrics_primary_enabled(
  uuid,
  boolean
) is
  'Global per-library Apple-primary kill switch. False immediately restores the pre-existing LRCLIB/work resolver without mutating routes or bindings.';

create function public.set_apple_lyrics_primary_block(
  p_library_id uuid,
  p_exact_key text,
  p_key_version integer,
  p_blocked boolean,
  p_anomaly_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exact_key text := nullif(btrim(p_exact_key), '');
  v_code text := lower(nullif(btrim(p_anomaly_code), ''));
  v_refresh jsonb;
begin
  if v_exact_key is null or char_length(v_exact_key) > 512 then
    raise exception 'exact_key must contain between 1 and 512 characters'
      using errcode = '22023';
  end if;
  if p_key_version is null or p_key_version < 1 or p_key_version > 32767 then
    raise exception 'key_version must be between 1 and 32767'
      using errcode = '22023';
  end if;
  if p_blocked is null then
    raise exception 'blocked is required'
      using errcode = '22023';
  end if;
  if v_code is null
    or char_length(v_code) > 128
    or v_code !~ '^[a-z0-9][a-z0-9._:-]*$' then
    raise exception 'anomaly_code must be a safe 1-128 character identifier'
      using errcode = '22023';
  end if;

  insert into public.apple_lyrics_primary_blocks (
    library_id,
    key_version,
    exact_key,
    is_active,
    anomaly_code
  )
  values (
    p_library_id,
    p_key_version,
    v_exact_key,
    p_blocked,
    v_code
  )
  on conflict (library_id, key_version, exact_key)
  do update set
    is_active = excluded.is_active,
    anomaly_code = excluded.anomaly_code,
    updated_at = transaction_timestamp();

  v_refresh := private.refresh_apple_primary_route_for_key(
    p_library_id,
    v_exact_key,
    p_key_version
  );

  return jsonb_build_object(
    'library_id', p_library_id,
    'exact_key', v_exact_key,
    'key_version', p_key_version,
    'blocked', p_blocked,
    'anomaly_code', v_code,
    'route_state', v_refresh ->> 'state',
    'route_reason', v_refresh ->> 'reason'
  );
end;
$$;

comment on function public.set_apple_lyrics_primary_block(
  uuid,
  text,
  integer,
  boolean,
  text
) is
  'Set or clear an audited hard-anomaly block and recompute the Exact route transactionally.';

create function private.build_routed_lyrics_hit(
  p_binding_id uuid,
  p_revision_id uuid,
  p_auto_scroll boolean,
  p_effective_status text default null,
  p_route_version bigint default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'result_status', 'hit',
    'match_kind', binding.binding_kind,
    'auto_scroll',
      coalesce(p_auto_scroll, false)
      and revision.synced_lyrics is not null
      and binding.binding_kind = 'exact',
    'binding_id', binding.id,
    'document_id', document.id,
    'revision_id', revision.id,
    'status', coalesce(p_effective_status, binding.status::text),
    'storage_binding_status', binding.status,
    'selection_method', binding.selection_method,
    'selection_version', case
      when p_route_version is not null then 0
      else binding.selection_version
    end,
    'match_confidence', binding.match_confidence,
    'synced_lyrics', revision.synced_lyrics,
    'plain_lyrics', revision.plain_lyrics,
    'is_instrumental', revision.is_instrumental,
    'language_code', revision.language_code,
    'duration_ms', revision.duration_ms,
    'provider_name', revision.provider_name,
    'provider_track_id', revision.provider_track_id,
    'provider_url', revision.provider_url,
    'rights_basis', revision.rights_basis,
    'content_hash', revision.content_hash,
    'raw_metadata', binding.raw_metadata,
    'provenance', revision.provenance,
    'revision_created_at', revision.created_at,
    'provider_route', case
      when p_route_version is null then null
      else 'apple-primary-v1'
    end,
    'provider_route_version', p_route_version,
    'candidates', '[]'::jsonb
  )
  from public.lyrics_bindings as binding
  join public.lyrics_documents as document
    on document.library_id = binding.library_id
    and document.id = binding.document_id
  join public.lyrics_revisions as revision
    on revision.document_id = document.id
    and revision.id = p_revision_id
  where binding.id = p_binding_id;
$$;

revoke all on function private.build_routed_lyrics_hit(
  uuid,
  uuid,
  boolean,
  text,
  bigint
) from public, anon, authenticated, service_role;

-- Retain the complete pre-Apple resolver as the fail-open fallback. The new
-- wrapper adds only two precedence checks and delegates all original active
-- Exact, Work, candidate, and miss semantics unchanged.
alter function public.resolve_lyrics(
  uuid,
  text,
  text,
  integer
) set schema private;

alter function private.resolve_lyrics(
  uuid,
  text,
  text,
  integer
) rename to resolve_lyrics_before_apple_primary_v1;

revoke all on function private.resolve_lyrics_before_apple_primary_v1(
  uuid,
  text,
  text,
  integer
) from public, anon, authenticated, service_role;

comment on function private.resolve_lyrics_before_apple_primary_v1(
  uuid,
  text,
  text,
  integer
) is
  'Unmodified pre-Apple-primary resolver: active Exact, active Work, quarantined candidates, then miss.';

create function public.resolve_lyrics(
  p_library_id uuid,
  p_exact_key text,
  p_work_key text,
  p_key_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_exact_key text := nullif(btrim(p_exact_key), '');
  v_work_key text := nullif(btrim(p_work_key), '');
  v_manual_binding_id uuid;
  v_manual_revision_id uuid;
  v_route public.apple_lyrics_primary_routes%rowtype;
  v_hit jsonb;
begin
  if p_key_version is null or p_key_version < 1 or p_key_version > 32767 then
    raise exception 'key_version must be between 1 and 32767'
      using errcode = '22023';
  end if;

  if v_exact_key is null and v_work_key is null then
    raise exception 'at least one lookup key is required'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.lyrics_libraries as library
    where library.id = p_library_id
  ) then
    raise exception 'lyrics library does not exist'
      using errcode = '23503';
  end if;

  -- Any valid active human Exact selection remains the highest authority.
  if v_exact_key is not null then
    select binding.id, revision.id
    into v_manual_binding_id, v_manual_revision_id
    from public.lyrics_bindings as binding
    join public.lyrics_revisions as revision
      on revision.document_id = binding.document_id
      and revision.is_current
    where binding.library_id = p_library_id
      and binding.binding_kind = 'exact'
      and binding.key_version = p_key_version
      and binding.lookup_key = v_exact_key
      and binding.status = 'active'
      and binding.selection_method in ('manual', 'candidate')
      and binding.selection_version is not null
    order by binding.selection_version desc, binding.updated_at desc
    limit 1;

    if found then
      return private.build_routed_lyrics_hit(
        v_manual_binding_id,
        v_manual_revision_id,
        true,
        null,
        null
      );
    end if;
  end if;

  if v_exact_key is not null
    and exists (
      select 1
      from public.lyrics_provider_routing_config as config
      where config.library_id = p_library_id
        and config.apple_primary_enabled
        and config.policy_version = 'apple-primary-v1'
    ) then
    select route.*
    into v_route
    from public.apple_lyrics_primary_routes as route
    where route.library_id = p_library_id
      and route.key_version = p_key_version
      and route.exact_key = v_exact_key
      and route.enabled
      and route.policy_version = 'apple-primary-v1'
      and private.is_apple_primary_route_valid(
        route.library_id,
        route.exact_key,
        route.key_version,
        route.binding_id,
        route.document_id,
        route.revision_id,
        route.artifact_id,
        route.revision_content_hash,
        route.source_snapshot_at,
        route.source_snapshot_id,
        route.artifact_fetched_at
      );

    if found then
      v_hit := private.build_routed_lyrics_hit(
        v_route.binding_id,
        v_route.revision_id,
        true,
        'active',
        v_route.route_version
      );
      if v_hit is not null then
        return v_hit;
      end if;
    end if;
  end if;

  -- Apple missing, disabled, static, ambiguous, rejected, or invalid:
  -- execute the original active Exact (normally LRCLIB) -> active Work ->
  -- quarantined candidate behavior without modifying fallback data.
  return private.resolve_lyrics_before_apple_primary_v1(
    p_library_id,
    v_exact_key,
    v_work_key,
    p_key_version
  );
end;
$$;

comment on function public.resolve_lyrics(
  uuid,
  text,
  text,
  integer
) is
  'Resolve active human Exact first, then a rigorously validated immutable Apple v2 Exact pin, then the original active Exact/LRCLIB, Work, candidate, and miss chain.';

-- Completion RPCs insert the artifact before marking their durable job
-- completed. Deferred triggers run at transaction end, after both facts are
-- visible, and recompute from the full completed corpus rather than blindly
-- pinning the artifact that happened to finish last.
create function private.refresh_apple_primary_from_artifact_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.provider_name = 'apple'
    and new.projection_version = 'apple-ttml-line-model-v2' then
    perform private.refresh_apple_primary_route_for_key(
      new.library_id,
      new.exact_key,
      new.key_version
    );
  end if;
  return new;
end;
$$;

revoke all on function private.refresh_apple_primary_from_artifact_trigger()
  from public, anon, authenticated, service_role;

create constraint trigger lyrics_source_artifacts_refresh_apple_primary
after insert on public.lyrics_source_artifacts
deferrable initially deferred
for each row
execute function private.refresh_apple_primary_from_artifact_trigger();

create function private.refresh_apple_primary_from_backfill_job_trigger()
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
      and v_artifact.projection_version = 'apple-ttml-line-model-v2'
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

revoke all on function private.refresh_apple_primary_from_backfill_job_trigger()
  from public, anon, authenticated, service_role;

create constraint trigger apple_backfill_jobs_refresh_apple_primary
after update of status, artifact_id on public.apple_lyrics_backfill_jobs
deferrable initially deferred
for each row
execute function private.refresh_apple_primary_from_backfill_job_trigger();

create function private.refresh_apple_primary_from_reprojection_job_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_artifact public.lyrics_source_artifacts%rowtype;
begin
  if new.status = 'completed'
    and new.result_artifact_id is not null then
    select artifact.*
    into v_artifact
    from public.lyrics_source_artifacts as artifact
    where artifact.library_id = new.library_id
      and artifact.id = new.result_artifact_id;

    if found
      and v_artifact.provider_name = 'apple'
      and v_artifact.projection_version = 'apple-ttml-line-model-v2'
      and v_artifact.revision_id = new.result_revision_id then
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
        'reprojection',
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

revoke all on function private.refresh_apple_primary_from_reprojection_job_trigger()
  from public, anon, authenticated, service_role;

create constraint trigger apple_reprojection_jobs_refresh_apple_primary
after update of status, result_artifact_id
on public.apple_lyrics_reprojection_jobs
deferrable initially deferred
for each row
execute function private.refresh_apple_primary_from_reprojection_job_trigger();

-- Enable the policy atomically with its initial deterministic route snapshot.
-- The kill switch RPC reverses read precedence immediately without deleting
-- this audit state.
insert into public.lyrics_provider_routing_config (
  library_id,
  apple_primary_enabled,
  policy_version
)
select
  library.id,
  true,
  'apple-primary-v1'
from public.lyrics_libraries as library
on conflict (library_id)
do update set
  apple_primary_enabled = excluded.apple_primary_enabled,
  policy_version = excluded.policy_version,
  updated_at = transaction_timestamp();

do $seed$
declare
  v_library record;
begin
  for v_library in
    select library.id
    from public.lyrics_libraries as library
    order by library.id
  loop
    perform public.refresh_apple_lyrics_primary_routes(
      v_library.id,
      10000
    );
  end loop;
end;
$seed$;

alter table public.lyrics_provider_routing_config enable row level security;
alter table public.apple_lyrics_primary_blocks enable row level security;
alter table public.apple_lyrics_primary_routes enable row level security;
alter table public.apple_lyrics_v2_completion_evidence
  enable row level security;

revoke all on table public.lyrics_provider_routing_config
  from public, anon, authenticated, service_role;
revoke all on table public.apple_lyrics_primary_blocks
  from public, anon, authenticated, service_role;
revoke all on table public.apple_lyrics_primary_routes
  from public, anon, authenticated, service_role;
revoke all on table public.apple_lyrics_v2_completion_evidence
  from public, anon, authenticated, service_role;

revoke all on function public.resolve_lyrics(
  uuid,
  text,
  text,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.refresh_apple_lyrics_primary_routes(
  uuid,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.set_apple_lyrics_primary_enabled(
  uuid,
  boolean
) from public, anon, authenticated, service_role;
revoke all on function public.set_apple_lyrics_primary_block(
  uuid,
  text,
  integer,
  boolean,
  text
) from public, anon, authenticated, service_role;

grant execute on function public.resolve_lyrics(
  uuid,
  text,
  text,
  integer
) to service_role;
grant execute on function public.refresh_apple_lyrics_primary_routes(
  uuid,
  integer
) to service_role;
grant execute on function public.set_apple_lyrics_primary_enabled(
  uuid,
  boolean
) to service_role;
grant execute on function public.set_apple_lyrics_primary_block(
  uuid,
  text,
  integer,
  boolean,
  text
) to service_role;

comment on table public.lyrics_bindings is
  'Versioned Exact/Work aliases. LRCLIB remains the active automatic Exact fallback; Apple primary is an independently validated immutable route; manual/candidate selections and rejection remain protected.';
