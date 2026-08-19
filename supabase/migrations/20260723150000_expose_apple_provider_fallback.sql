-- Expose the active provider Exact that remains behind a valid Apple primary
-- route. The fallback is response metadata only: precedence, route validation,
-- the kill switch, and the original resolver remain unchanged.
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
  v_exact_key text := nullif(btrim(p_exact_key), '');
  v_work_key text := nullif(btrim(p_work_key), '');
  v_manual_binding_id uuid;
  v_manual_revision_id uuid;
  v_route public.apple_lyrics_primary_routes%rowtype;
  v_hit jsonb;
  v_provider_fallback jsonb;
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
        v_provider_fallback :=
          private.resolve_lyrics_before_apple_primary_v1(
            p_library_id,
            v_exact_key,
            null,
            p_key_version
          );

        if v_provider_fallback ->> 'result_status' = 'hit'
          and v_provider_fallback ->> 'match_kind' = 'exact'
          and v_provider_fallback ->> 'selection_method' = 'provider'
          and v_provider_fallback ->> 'status' = 'active'
          and nullif(
            v_provider_fallback ->> 'document_id',
            ''
          ) is not null
          and v_provider_fallback ->> 'document_id'
            is distinct from v_hit ->> 'document_id' then
          v_hit := v_hit || jsonb_build_object(
            'provider_fallback',
            v_provider_fallback
          );
        end if;

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
  'Resolve active human Exact first, then a rigorously validated immutable Apple v2 Exact pin with an optional active provider Exact fallback, then the original active Exact/LRCLIB, Work, candidate, and miss chain.';
