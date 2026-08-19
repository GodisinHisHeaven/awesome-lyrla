create function public.read_artwork_palette(
  p_library_id uuid,
  p_artwork_key text,
  p_key_version integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_artwork_key text := nullif(btrim(p_artwork_key), '');
  v_palette public.artwork_palettes%rowtype;
begin
  if p_library_id is null then
    raise exception 'library_id is required'
      using errcode = '22023';
  end if;

  if p_key_version is null or p_key_version < 1 or p_key_version > 32767 then
    raise exception 'key_version must be between 1 and 32767'
      using errcode = '22023';
  end if;

  if v_artwork_key is null
    or v_artwork_key !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'artwork_key must be a lowercase SHA-256 digest'
      using errcode = '22023';
  end if;

  select palette.*
  into v_palette
  from public.artwork_palettes as palette
  where palette.library_id = p_library_id
    and palette.artwork_key = v_artwork_key
    and palette.key_version = p_key_version;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'palette', v_palette.palette,
    'provider_name', v_palette.provider_name,
    'provider_track_id', v_palette.provider_track_id,
    'match_confidence', v_palette.match_confidence,
    'updated_at', v_palette.updated_at
  );
end;
$$;

comment on function public.read_artwork_palette(
  uuid,
  text,
  integer
) is
  'Read one exact private artwork palette by library, SHA-256 key, and schema version.';

revoke all on function public.read_artwork_palette(
  uuid,
  text,
  integer
) from public, anon, authenticated, service_role;

grant execute on function public.read_artwork_palette(
  uuid,
  text,
  integer
) to service_role;
