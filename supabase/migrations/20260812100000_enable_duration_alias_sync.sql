-- A duration mismatch is not, by itself, evidence that an Apple timeline is
-- unusable. The primary route has already passed the Apple timing gate and
-- the alias requires the same v1 duration family, document, and content hash.
-- Preserve its timestamps when they exist; only a genuinely static revision
-- remains a non-scrolling fallback.
create or replace function private.resolve_apple_duration_alias_static_v1(
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
  v_has_timeline boolean;
begin
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

  v_has_timeline := nullif(btrim(v_hit ->> 'synced_lyrics'), '') is not null;
  return (v_hit - 'provider_fallback') || jsonb_build_object(
    'match_kind', 'work',
    'auto_scroll', v_has_timeline,
    'provider_route', case
      when v_has_timeline then 'apple-duration-alias-synced-v1'
      else 'apple-duration-alias-static-v1'
    end,
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
  'Serve a validated Apple duration alias with timestamps when the pinned revision has a timeline; otherwise return static text. Duration mismatch alone does not disable scrolling.';
