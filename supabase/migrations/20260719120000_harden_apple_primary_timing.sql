-- Apple Exact identity and structurally valid LRC are necessary but not
-- sufficient for primary routing. Fail closed only on timing shapes that are
-- impossible relative to a credible catalog duration; leave fuzzy quality and
-- audio alignment to the offline audit.

create function private.apple_synced_payload_timing_anomaly(
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
      v_last_nonempty_ms := v_start_ms;
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

  -- Catalog duration is verified by the Apple Exact ingestion path, but keep
  -- this deliberately generous: at least 30 seconds, 10% for long recordings,
  -- and never more than two minutes. This catches unit/track mixups without
  -- treating ordinary duration drift as corruption.
  v_duration_tolerance_ms := greatest(
    30000::bigint,
    least(
      120000::bigint,
      ceil(p_duration_ms::numeric * 0.10)::bigint
    )
  );
  if v_last_nonempty_ms
    > p_duration_ms::bigint + v_duration_tolerance_ms then
    return 'timestamp-duration-overrun';
  end if;

  -- At least 80% of twelve or more projected lines compressed into any window
  -- of at most two seconds and at most 2% of a recording is a catastrophic
  -- time-unit/coverage collapse. A sliding window is deliberate: fixed
  -- percentiles can be bypassed by asymmetric outliers. Requiring a minute-long
  -- track and many lines avoids scoring legitimate short vocals, long intros,
  -- long outros, or sparse compositions.
  v_collapsed_span_limit_ms := least(
    2000::bigint,
    floor(p_duration_ms::numeric * 0.02)::bigint
  );
  if p_duration_ms >= 60000 and v_nonempty_lines >= 12 then
    select array_agg(sample.start_ms order by sample.start_ms)
    into v_nonempty_timestamps
    from unnest(v_nonempty_timestamps) as sample(start_ms);

    v_required_window_lines := ceil(
      v_nonempty_lines::numeric * 0.80
    )::integer;
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
  'Return a fixed hard-anomaly code only for duration-relative Apple timing corruption; null is not an audio-alignment quality verdict.';

create or replace function private.apple_primary_candidate_rejection_code(
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

  v_anomaly := private.apple_synced_payload_timing_anomaly(
    v_row.synced_lyrics,
    v_row.duration_ms
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

-- Do not eagerly refresh every key inside this migration transaction:
-- refresh_apple_primary_route_for_key takes one transaction-scoped advisory
-- lock per key, so a whole-library loop would accumulate locks and block the
-- worker as the corpus grows. Existing enabled pins fail closed immediately
-- because resolve_lyrics calls is_apple_primary_route_valid, which invokes the
-- replacement rejection function above. Normal completion triggers and the
-- bounded operator refresh RPC update materialized route state later.
