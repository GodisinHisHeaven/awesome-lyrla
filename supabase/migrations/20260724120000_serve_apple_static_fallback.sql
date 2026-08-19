-- A completed Apple Exact can contain trustworthy text without a usable
-- timeline. Keep synchronized Apple primary and every pre-existing fallback
-- ahead of this last-resort static route, but do not surface the one verified
-- Apple document as an ambiguous candidate when it is the only lyric text we
-- can serve.

-- Static fallback needs one rolling-compatible evidence boundary of its own:
-- retained v1 static artifacts were completed before v2 reprojection existed,
-- while current static artifacts can be direct v2 completions or reprojection
-- results. Requiring a terminal durable job prevents an unattached artifact
-- row from becoming serveable. V3 is included only in newest-snapshot and
-- ambiguity calculations below; the payload gate later permits static v1/v2
-- exclusively.
create function private.is_completed_apple_static_fallback_source_v1(
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
        'apple-ttml-line-model-v1',
        'apple-ttml-line-model-v2',
        'apple-ttml-line-model-v3'
      )
      and revision.provider_name = 'apple'
      and revision.provider_track_id = artifact.provider_track_id
      and (
        exists (
          select 1
          from public.apple_lyrics_backfill_jobs as source_job
          where source_job.library_id = artifact.library_id
            and source_job.status = 'completed'
            and source_job.exact_key = artifact.exact_key
            and source_job.key_version = artifact.key_version
            and source_job.provider_track_id = artifact.provider_track_id
            and source_job.document_id = document.id
            and source_job.revision_id = revision.id
            and source_job.artifact_id = artifact.id
        )
        or (
          artifact.projection_version in (
            'apple-ttml-line-model-v2',
            'apple-ttml-line-model-v3'
          )
          and exists (
            select 1
            from public.apple_lyrics_reprojection_jobs as reprojection
            where reprojection.library_id = artifact.library_id
              and reprojection.status = 'completed'
              and reprojection.result_document_id = document.id
              and reprojection.result_revision_id = revision.id
              and reprojection.result_artifact_id = artifact.id
          )
        )
      )
  );
$$;

revoke all on function
  private.is_completed_apple_static_fallback_source_v1(
    uuid,
    uuid,
    uuid,
    uuid
  )
  from public, anon, authenticated, service_role;

comment on function private.is_completed_apple_static_fallback_source_v1(
  uuid,
  uuid,
  uuid,
  uuid
) is
  'Verify exact-linked Apple v1/v2/v3 artifact lineage through a completed durable backfill or reprojection job; static payload eligibility is checked separately after newest-snapshot selection.';

-- A v1 Exact fingerprint has one of two closed shapes:
--   title::artist::duration-seconds::album
--   title::artist::duration-seconds::v=version[,version]::album
-- normalizeMetadata removes literal colons from every metadata field, so the
-- delimiter is unambiguous. This helper preserves every byte except the
-- duration field; it is intentionally not a general Work fingerprint.
create function private.lyrics_v1_exact_duration_family(
  p_exact_key text
)
returns text
language plpgsql
immutable
parallel safe
strict
set search_path = ''
as $$
declare
  v_exact_key text := btrim(p_exact_key);
  v_parts text[];
begin
  if v_exact_key = '' or char_length(v_exact_key) > 512 then
    return null;
  end if;

  v_parts := string_to_array(v_exact_key, '::');
  if cardinality(v_parts) = 4
    and v_parts[1] <> ''
    and v_parts[2] <> ''
    and v_parts[3] ~ '^[0-9]{1,10}$' then
    return v_parts[1] || '::' || v_parts[2] || '::' || v_parts[4];
  end if;

  if cardinality(v_parts) = 5
    and v_parts[1] <> ''
    and v_parts[2] <> ''
    and v_parts[3] ~ '^[0-9]{1,10}$'
    and v_parts[4] ~ '^v=[a-z0-9][a-z0-9 ,_-]{0,127}$' then
    return v_parts[1] || '::' || v_parts[2] || '::'
      || v_parts[4] || '::' || v_parts[5];
  end if;

  return null;
end;
$$;

revoke all on function private.lyrics_v1_exact_duration_family(text)
  from public, anon, authenticated, service_role;

comment on function private.lyrics_v1_exact_duration_family(text) is
  'Parse a closed v1 Exact fingerprint and return a byte-preserving title/artist/version/album family with only duration removed; malformed and future key shapes fail closed.';

create index apple_lyrics_primary_routes_duration_family_v1
  on public.apple_lyrics_primary_routes (
    library_id,
    key_version,
    private.lyrics_v1_exact_duration_family(exact_key)
  )
  where key_version = 1;

create index apple_lyrics_primary_blocks_duration_family_v1
  on public.apple_lyrics_primary_blocks (
    library_id,
    key_version,
    private.lyrics_v1_exact_duration_family(exact_key)
  )
  where is_active and key_version = 1;

create index lyrics_bindings_rejected_exact_duration_family_v1
  on public.lyrics_bindings (
    library_id,
    key_version,
    private.lyrics_v1_exact_duration_family(lookup_key)
  )
  where binding_kind = 'exact'
    and status = 'rejected'
    and key_version = 1;

create function private.resolve_apple_static_fallback_v1(
  p_library_id uuid,
  p_exact_key text,
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
  v_candidate record;
  v_plain_lines text[];
  v_hit jsonb;
begin
  if v_exact_key is null
    or char_length(v_exact_key) > 512
    or p_key_version is null
    or p_key_version < 1
    or p_key_version > 32767 then
    return null;
  end if;

  -- The existing Apple kill switch controls both synchronized primary and
  -- static fallback. A forward fix can therefore disable all automatic Apple
  -- serving without changing stored artifacts.
  if not exists (
    select 1
    from public.lyrics_provider_routing_config as config
    where config.library_id = p_library_id
      and config.apple_primary_enabled
      and config.policy_version = 'apple-primary-v1'
  ) then
    return null;
  end if;

  -- Exact identity is document-scoped. Multiple completed Apple documents for
  -- the same key remain ambiguous instead of being resolved by recency.
  if (
    select count(distinct revision.document_id)
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
      and artifact.exact_key = v_exact_key
      and artifact.key_version = p_key_version
      and private.is_completed_apple_static_fallback_source_v1(
        artifact.library_id,
        binding.id,
        revision.id,
        artifact.id
      )
  ) <> 1 then
    return null;
  end if;

  -- Match primary routing's snapshot rule: choose the newest completed source
  -- snapshot first, then inspect its payload. Never revive an older static
  -- artifact after a newer unsupported or synchronized snapshot.
  select
    binding.id as binding_id,
    binding.document_id,
    binding.status as binding_status,
    binding.selection_method,
    binding.selection_version,
    binding.raw_metadata,
    revision.id as revision_id,
    revision.synced_lyrics,
    revision.plain_lyrics,
    revision.is_instrumental,
    revision.provenance,
    artifact.id as artifact_id,
    artifact.timing_mode,
    artifact.projection_version
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
    and private.is_completed_apple_static_fallback_source_v1(
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
    return null;
  end if;

  -- This route is deliberately narrower than "Apple has plain text": it
  -- accepts only the parser's explicit static mode and refuses malformed,
  -- instrumental, oversized, or mixed synced/static payloads.
  if v_candidate.binding_status <> 'quarantine'
    or v_candidate.selection_method <> 'provider'
    or v_candidate.selection_version is not null
    or v_candidate.projection_version not in (
      'apple-ttml-line-model-v1',
      'apple-ttml-line-model-v2'
    )
    or v_candidate.timing_mode <> 'none'
    or v_candidate.synced_lyrics is not null
    or coalesce(v_candidate.is_instrumental, false)
    or v_candidate.plain_lyrics is null
    or btrim(v_candidate.plain_lyrics) = ''
    or octet_length(v_candidate.plain_lyrics) > 524288 then
    return null;
  end if;

  v_plain_lines := regexp_split_to_array(
    replace(v_candidate.plain_lyrics, E'\r\n', E'\n'),
    E'\n'
  );
  if cardinality(v_plain_lines) < 1
    or cardinality(v_plain_lines) > 5000 then
    return null;
  end if;

  if coalesce(
    v_candidate.provenance ->> 'exact_identity_proof_version',
    ''
  ) <> '1' then
    return null;
  end if;
  if coalesce(
    jsonb_typeof(v_candidate.provenance -> 'exact_identity_evidence'),
    ''
  ) <> 'array' then
    return null;
  end if;
  if jsonb_array_length(
    v_candidate.provenance -> 'exact_identity_evidence'
  ) < 1 then
    return null;
  end if;

  if not private.is_valid_apple_lyrics_track_metadata(
    v_candidate.raw_metadata
  )
    or octet_length(v_candidate.raw_metadata::text) > 16384 then
    return null;
  end if;

  if exists (
    select 1
    from public.apple_lyrics_primary_blocks as block
    where block.library_id = p_library_id
      and block.key_version = p_key_version
      and block.exact_key = v_exact_key
      and block.is_active
  )
    or exists (
      select 1
      from public.lyrics_bindings as rejected
      where rejected.library_id = p_library_id
        and rejected.binding_kind = 'exact'
        and rejected.key_version = p_key_version
        and rejected.lookup_key = v_exact_key
        and rejected.status = 'rejected'
    )
    or exists (
      select 1
      from public.lyrics_bindings as active_alias
      where active_alias.library_id = p_library_id
        and active_alias.document_id = v_candidate.document_id
        and active_alias.status = 'active'
    ) then
    return null;
  end if;

  v_hit := private.build_routed_lyrics_hit(
    v_candidate.binding_id,
    v_candidate.revision_id,
    false,
    'active',
    null
  );
  if v_hit is null then
    return null;
  end if;

  return v_hit || jsonb_build_object(
    'provider_route', 'apple-static-fallback-v1',
    'provider_route_version', 1
  );
end;
$$;

revoke all on function private.resolve_apple_static_fallback_v1(
  uuid,
  text,
  integer
) from public, anon, authenticated, service_role;

comment on function private.resolve_apple_static_fallback_v1(
  uuid,
  text,
  integer
) is
  'Return one completed, exact-proven Apple timing_mode=none payload as a non-scrolling hit only after higher-priority resolver paths have failed.';

-- Reuse a rigorously validated Apple primary pin when Tesla reports a
-- materially wrong duration for the same recording metadata. This is narrower
-- than Work fallback: title, artist, version signature, and album are the exact
-- v1 fingerprint bytes, and only the duration segment may differ.
create function private.resolve_apple_duration_alias_static_v1(
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
  v_family text;
  v_candidate public.apple_lyrics_primary_routes%rowtype;
  v_hit jsonb;
begin
  -- This service_role-only RPC and the bundled Supabase client form one trust
  -- boundary. SQL treats Work presence solely as the caller's capability flag
  -- to show static fallback; the client independently reconstructs both the
  -- raw_metadata Work key and v1 Exact family and rejects any mismatch. Do not
  -- duplicate the JavaScript Unicode fingerprint rules in PostgreSQL.
  -- Version 1 is the only Exact grammar parsed by the helper above.
  if v_exact_key is null
    or v_work_key is null
    or char_length(v_exact_key) > 512
    or char_length(v_work_key) > 512
    or p_key_version is distinct from 1 then
    return null;
  end if;

  v_family := private.lyrics_v1_exact_duration_family(v_exact_key);
  if v_family is null then
    return null;
  end if;

  if not exists (
    select 1
    from public.lyrics_provider_routing_config as config
    where config.library_id = p_library_id
      and config.apple_primary_enabled
      and config.policy_version = 'apple-primary-v1'
  ) then
    return null;
  end if;

  -- A block or human rejection anywhere in this byte-exact recording family
  -- is explicit negative evidence. It must not disappear merely because route
  -- validity has already filtered that sibling out of the candidate set.
  if exists (
    select 1
    from public.apple_lyrics_primary_blocks as block
    where block.library_id = p_library_id
      and block.key_version = 1
      and block.key_version = p_key_version
      and block.is_active
      and private.lyrics_v1_exact_duration_family(block.exact_key) = v_family
  )
    or exists (
      select 1
      from public.lyrics_bindings as rejected
      where rejected.library_id = p_library_id
        and rejected.binding_kind = 'exact'
        and rejected.key_version = 1
        and rejected.key_version = p_key_version
        and rejected.status = 'rejected'
        and private.lyrics_v1_exact_duration_family(rejected.lookup_key)
          = v_family
    ) then
    return null;
  end if;

  select route.*
  into v_candidate
  from public.apple_lyrics_primary_routes as route
  where route.library_id = p_library_id
    and route.key_version = 1
    and route.key_version = p_key_version
    and route.exact_key <> v_exact_key
    and route.enabled
    and route.policy_version = 'apple-primary-v1'
    and private.lyrics_v1_exact_duration_family(route.exact_key) = v_family
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
    )
  order by
    route.source_snapshot_at desc,
    route.artifact_fetched_at desc,
    route.exact_key
  limit 1;

  if not found then
    return null;
  end if;

  -- Several duration aliases may safely point at the same immutable content,
  -- but a second document or content hash is genuine ambiguity. Inspect every
  -- retained route row, not just currently valid rows: a disabled/invalid
  -- sibling is still negative evidence when it points at different content.
  if exists (
    select 1
    from public.apple_lyrics_primary_routes as other_route
    where other_route.library_id = p_library_id
      and other_route.key_version = 1
      and other_route.key_version = p_key_version
      and other_route.policy_version = 'apple-primary-v1'
      and private.lyrics_v1_exact_duration_family(other_route.exact_key)
        = v_family
      and (
        other_route.document_id <> v_candidate.document_id
        or other_route.revision_content_hash
          <> v_candidate.revision_content_hash
      )
  ) then
    return null;
  end if;

  v_hit := private.build_routed_lyrics_hit(
    v_candidate.binding_id,
    v_candidate.revision_id,
    false,
    'active',
    v_candidate.route_version
  );
  if v_hit is null then
    return null;
  end if;

  -- Never expose timestamps from the differently timed recording metadata.
  -- `work` also invokes the existing client-side Work-key metadata verifier.
  return (v_hit - 'provider_fallback') || jsonb_build_object(
    'match_kind', 'work',
    'auto_scroll', false,
    'synced_lyrics', null,
    'provider_route', 'apple-duration-alias-static-v1',
    'provider_route_version', 1
  );
end;
$$;

revoke all on function private.resolve_apple_duration_alias_static_v1(
  uuid,
  text,
  text,
  integer
) from public, anon, authenticated, service_role;

comment on function private.resolve_apple_duration_alias_static_v1(
  uuid,
  text,
  text,
  integer
) is
  'Return one valid Apple primary pin as static Work-shaped fallback when a v1 Exact differs only by duration. p_work_key is a service-role capability flag; the bundled client separately verifies raw_metadata-derived Work and Exact-family identity. Malformed keys, ambiguity, blocks, rejection, and missing Work permission fail closed.';

-- Preserve the complete synchronized-Apple-primary and LRCLIB/manual/work
-- resolver byte-for-byte behind a private entrypoint. The new public wrapper
-- adds only terminal static Apple fallbacks.
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
) rename to resolve_lyrics_before_apple_static_fallback_v1;

revoke all on function private.resolve_lyrics_before_apple_static_fallback_v1(
  uuid,
  text,
  text,
  integer
) from public, anon, authenticated, service_role;

comment on function private.resolve_lyrics_before_apple_static_fallback_v1(
  uuid,
  text,
  text,
  integer
) is
  'Unmodified synchronized Apple primary, active Exact/LRCLIB, Work, candidate, and miss resolver retained ahead of Apple static fallback.';

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
  v_resolved jsonb;
  v_static_hit jsonb;
  v_duration_alias_hit jsonb;
begin
  v_resolved := private.resolve_lyrics_before_apple_static_fallback_v1(
    p_library_id,
    p_exact_key,
    p_work_key,
    p_key_version
  );

  -- This includes manual/candidate Exact, synchronized Apple primary, active
  -- LRCLIB Exact, and active Work. Their established order is untouched.
  if v_resolved ->> 'result_status' = 'hit' then
    return v_resolved;
  end if;

  if nullif(btrim(p_exact_key), '') is not null then
    v_static_hit := private.resolve_apple_static_fallback_v1(
      p_library_id,
      p_exact_key,
      p_key_version
    );
    if v_static_hit is not null then
      return v_static_hit;
    end if;
  end if;

  -- A duration alias is weaker than the current Exact static route and may
  -- never hide ambiguity. It runs only for a true miss after the caller has
  -- explicitly enabled static Work fallback.
  if v_resolved ->> 'result_status' = 'miss'
    and nullif(btrim(p_work_key), '') is not null then
    v_duration_alias_hit := private.resolve_apple_duration_alias_static_v1(
      p_library_id,
      p_exact_key,
      p_work_key,
      p_key_version
    );
    if v_duration_alias_hit is not null then
      return v_duration_alias_hit;
    end if;
  end if;

  return v_resolved;
end;
$$;

comment on function public.resolve_lyrics(
  uuid,
  text,
  text,
  integer
) is
  'Resolve existing manual, synchronized Apple, active Exact/LRCLIB, and Work paths first; then serve current-Exact static Apple text, and only for a true miss with Work permission serve one byte-identical v1 Exact duration alias without auto-scroll.';

revoke all on function public.resolve_lyrics(
  uuid,
  text,
  text,
  integer
) from public, anon, authenticated, service_role;

grant execute on function public.resolve_lyrics(
  uuid,
  text,
  text,
  integer
) to service_role;
