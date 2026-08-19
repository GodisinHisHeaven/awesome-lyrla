create function public.compare_quarantined_lyrics(
  p_library_id uuid,
  p_exact_key text,
  p_work_key text,
  p_key_version integer,
  p_observed_before timestamptz,
  p_expected_exact jsonb,
  p_expected_work jsonb
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
  v_compare_exact boolean := p_expected_exact is not null
    and p_expected_exact <> 'null'::jsonb;
  v_compare_work boolean := p_expected_work is not null
    and p_expected_work <> 'null'::jsonb;
  v_effective_observed_before timestamptz;
  v_exact_synced text;
  v_exact_plain text;
  v_exact_instrumental boolean;
  v_work_synced text;
  v_work_plain text;
  v_work_instrumental boolean;
  v_exact_candidate_count bigint := 0;
  v_exact_comparisons bigint := 0;
  v_exact_agreements bigint := 0;
  v_work_candidate_count bigint := 0;
  v_work_comparisons bigint := 0;
  v_work_agreements bigint := 0;
begin
  if p_key_version is null or p_key_version < 1 or p_key_version > 32767 then
    raise exception 'key_version must be between 1 and 32767'
      using errcode = '22023';
  end if;

  if p_observed_before is null then
    raise exception 'observed_before is required'
      using errcode = '22023';
  end if;

  -- Use the earlier of the app-captured observation boundary and the database
  -- clock safety window. This remains conservative if either clock leads.
  v_effective_observed_before := least(
    p_observed_before,
    statement_timestamp() - interval '5 seconds'
  );

  if char_length(coalesce(v_exact_key, '')) > 512
    or char_length(coalesce(v_work_key, '')) > 512 then
    raise exception 'lookup keys must not exceed 512 characters'
      using errcode = '22023';
  end if;

  if v_exact_key is null and v_work_key is null then
    raise exception 'at least one lookup key is required'
      using errcode = '22023';
  end if;

  if v_compare_exact and v_exact_key is null then
    raise exception 'expected exact lyrics require an exact lookup key'
      using errcode = '22023';
  end if;

  if v_compare_work and v_work_key is null then
    raise exception 'expected work lyrics require a work lookup key'
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

  if v_compare_exact then
    if jsonb_typeof(p_expected_exact) <> 'object' then
      raise exception 'expected exact lyrics must be a JSON object or null'
        using errcode = '22023';
    end if;

    v_exact_synced := coalesce(
      p_expected_exact ->> 'synced_lyrics',
      p_expected_exact ->> 'syncedLyrics'
    );
    if v_exact_synced is not null and btrim(v_exact_synced) = '' then
      v_exact_synced := null;
    end if;

    v_exact_plain := coalesce(
      p_expected_exact ->> 'plain_lyrics',
      p_expected_exact ->> 'plainLyrics'
    );
    if v_exact_plain is not null and btrim(v_exact_plain) = '' then
      v_exact_plain := null;
    end if;

    v_exact_instrumental := coalesce(
      nullif(
        coalesce(
          p_expected_exact ->> 'is_instrumental',
          p_expected_exact ->> 'instrumental'
        ),
        ''
      )::boolean,
      false
    );

    if char_length(coalesce(v_exact_synced, '')) > 512000
      or char_length(coalesce(v_exact_plain, '')) > 512000 then
      raise exception 'expected exact lyrics fields must not exceed 512000 characters'
        using errcode = '22023';
    end if;

    if v_exact_instrumental
      and (v_exact_synced is not null or v_exact_plain is not null) then
      raise exception 'instrumental exact lyrics must not contain lyric text'
        using errcode = '22023';
    end if;

    if not v_exact_instrumental
      and v_exact_synced is null
      and v_exact_plain is null then
      raise exception 'non-instrumental exact lyrics require synced or plain lyrics'
        using errcode = '22023';
    end if;
  end if;

  if v_compare_work then
    if jsonb_typeof(p_expected_work) <> 'object' then
      raise exception 'expected work lyrics must be a JSON object or null'
        using errcode = '22023';
    end if;

    v_work_synced := coalesce(
      p_expected_work ->> 'synced_lyrics',
      p_expected_work ->> 'syncedLyrics'
    );
    if v_work_synced is not null and btrim(v_work_synced) = '' then
      v_work_synced := null;
    end if;

    v_work_plain := coalesce(
      p_expected_work ->> 'plain_lyrics',
      p_expected_work ->> 'plainLyrics'
    );
    if v_work_plain is not null and btrim(v_work_plain) = '' then
      v_work_plain := null;
    end if;

    v_work_instrumental := coalesce(
      nullif(
        coalesce(
          p_expected_work ->> 'is_instrumental',
          p_expected_work ->> 'instrumental'
        ),
        ''
      )::boolean,
      false
    );

    if char_length(coalesce(v_work_synced, '')) > 512000
      or char_length(coalesce(v_work_plain, '')) > 512000 then
      raise exception 'expected work lyrics fields must not exceed 512000 characters'
        using errcode = '22023';
    end if;

    if v_work_instrumental
      and (v_work_synced is not null or v_work_plain is not null) then
      raise exception 'instrumental work lyrics must not contain lyric text'
        using errcode = '22023';
    end if;

    if not v_work_instrumental
      and v_work_synced is null
      and v_work_plain is null then
      raise exception 'non-instrumental work lyrics require synced or plain lyrics'
        using errcode = '22023';
    end if;
  end if;

  select
    count(*),
    count(*) filter (where v_compare_exact),
    count(*) filter (
      where v_compare_exact
        and (
          (
            v_exact_instrumental
            and candidate.is_instrumental
          )
          or (
            not v_exact_instrumental
            and not candidate.is_instrumental
            and (
              (
                v_exact_synced is not null
                and candidate.synced_lyrics is not distinct from v_exact_synced
              )
              or (
                v_exact_synced is null
                and candidate.synced_lyrics is null
                and candidate.plain_lyrics is not distinct from v_exact_plain
              )
            )
          )
        )
    )
  into
    v_exact_candidate_count,
    v_exact_comparisons,
    v_exact_agreements
  from (
    select
      revision.synced_lyrics,
      revision.plain_lyrics,
      revision.is_instrumental
    from public.lyrics_bindings as binding
    join public.lyrics_documents as document
      on document.id = binding.document_id
      and document.library_id = binding.library_id
    join public.lyrics_revisions as revision
      on revision.document_id = document.id
      and revision.created_at < v_effective_observed_before
      and (
        revision.superseded_at is null
        or revision.superseded_at >= v_effective_observed_before
      )
    where binding.library_id = p_library_id
      and binding.binding_kind = 'exact'
      and binding.key_version = p_key_version
      and binding.lookup_key = v_exact_key
      and binding.status = 'quarantine'
      and binding.created_at < v_effective_observed_before
  ) as candidate;

  select
    count(*),
    count(*) filter (where v_compare_work),
    count(*) filter (
      where v_compare_work
        and (
          (
            v_work_instrumental
            and candidate.is_instrumental
          )
          or (
            not v_work_instrumental
            and not candidate.is_instrumental
            and candidate.synced_lyrics is not distinct from v_work_synced
            and candidate.plain_lyrics is not distinct from v_work_plain
          )
        )
    )
  into
    v_work_candidate_count,
    v_work_comparisons,
    v_work_agreements
  from (
    select
      revision.synced_lyrics,
      revision.plain_lyrics,
      revision.is_instrumental
    from public.lyrics_bindings as binding
    join public.lyrics_documents as document
      on document.id = binding.document_id
      and document.library_id = binding.library_id
    join public.lyrics_revisions as revision
      on revision.document_id = document.id
      and revision.created_at < v_effective_observed_before
      and (
        revision.superseded_at is null
        or revision.superseded_at >= v_effective_observed_before
      )
    where binding.library_id = p_library_id
      and binding.binding_kind = 'work'
      and binding.key_version = p_key_version
      and binding.lookup_key = v_work_key
      and binding.status = 'quarantine'
      and binding.created_at < v_effective_observed_before
  ) as candidate;

  return jsonb_build_object(
    'exact', jsonb_build_object(
      'candidate_count', v_exact_candidate_count,
      'comparisons', v_exact_comparisons,
      'agreements', v_exact_agreements,
      'disagreements', v_exact_comparisons - v_exact_agreements
    ),
    'work', jsonb_build_object(
      'candidate_count', v_work_candidate_count,
      'comparisons', v_work_comparisons,
      'agreements', v_work_agreements,
      'disagreements', v_work_comparisons - v_work_agreements
    )
  );
end;
$$;

comment on function public.compare_quarantined_lyrics(
  uuid,
  text,
  text,
  integer,
  timestamptz,
  jsonb,
  jsonb
) is
  'Read-only aggregate comparison against quarantined exact/work candidates that predate the observation cutoff. Returns no lyrics or identifiers.';

revoke all on function public.compare_quarantined_lyrics(
  uuid,
  text,
  text,
  integer,
  timestamptz,
  jsonb,
  jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.compare_quarantined_lyrics(
  uuid,
  text,
  text,
  integer,
  timestamptz,
  jsonb,
  jsonb
) to service_role;
