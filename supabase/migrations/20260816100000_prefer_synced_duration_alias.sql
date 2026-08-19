-- A validated Apple synchronized duration alias is a better result than an
-- automatic LRCLIB Exact that contains only static text. Keep every other
-- resolver priority unchanged: manual/candidate selections, synchronized
-- Exact rows, and active Work rows still return from the private resolver
-- before this narrow promotion is considered.
create or replace function public.resolve_lyrics(
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

  if v_resolved ->> 'result_status' = 'hit' then
    -- The first foreground lookup intentionally omits p_work_key. When the
    -- caller supplies it on a bounded retry, only an automatic LRCLIB static
    -- Exact may be replaced, and only by a validated synchronized Apple
    -- duration alias. Manual/candidate rows and LRCLIB synchronized rows are
    -- never displaced by this route.
    if nullif(btrim(p_work_key), '') is not null
      and v_resolved ->> 'match_kind' = 'exact'
      and lower(btrim(coalesce(v_resolved ->> 'provider_name', ''))) = 'lrclib'
      and v_resolved ->> 'selection_method' = 'provider'
      and coalesce(v_resolved ->> 'is_instrumental', 'false') = 'false'
      and coalesce(v_resolved ->> 'auto_scroll', 'false') = 'false'
      and (
        nullif(btrim(v_resolved ->> 'plain_lyrics'), '') is not null
        or nullif(btrim(v_resolved ->> 'synced_lyrics'), '') is not null
      ) then
      v_duration_alias_hit := private.resolve_apple_duration_alias_static_v1(
        p_library_id,
        p_exact_key,
        p_work_key,
        p_key_version
      );
      if v_duration_alias_hit ->> 'result_status' = 'hit'
        and v_duration_alias_hit ->> 'match_kind' = 'work'
        and lower(btrim(coalesce(v_duration_alias_hit ->> 'provider_name', ''))) = 'apple'
        and v_duration_alias_hit ->> 'provider_route'
          = 'apple-duration-alias-synced-v1'
        and v_duration_alias_hit ->> 'auto_scroll' = 'true'
        and nullif(btrim(v_duration_alias_hit ->> 'synced_lyrics'), '') is not null then
        return v_duration_alias_hit;
      end if;
    end if;
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

  -- A duration alias remains available after a true miss for callers that
  -- explicitly enabled Work fallback. Static aliases retain their existing
  -- behavior; synchronized aliases are promoted above in the hit branch.
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
  'Resolve established paths first; promote only a validated synchronized Apple duration alias over an automatic static LRCLIB Exact, then retain current Apple static and Work fallback behavior.';
