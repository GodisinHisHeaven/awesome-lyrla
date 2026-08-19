create table public.artwork_palettes (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references public.lyrics_libraries(id) on delete cascade,
  artwork_key text not null,
  key_version smallint not null,
  palette jsonb not null,
  provider_name text,
  provider_track_id text,
  match_confidence numeric(6, 5),
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint artwork_palettes_key_version_positive
    check (key_version > 0),
  constraint artwork_palettes_artwork_key_length
    check (octet_length(artwork_key) between 1 and 512),
  constraint artwork_palettes_palette_object
    check (jsonb_typeof(palette) = 'object'),
  constraint artwork_palettes_palette_size
    check (octet_length(palette::text) <= 4096),
  constraint artwork_palettes_primary_color
    check (
      palette ? 'primary'
      and (palette ->> 'primary') ~ '^#[0-9A-Fa-f]{6}$'
    ),
  constraint artwork_palettes_secondary_color
    check (
      palette ? 'secondary'
      and (palette ->> 'secondary') ~ '^#[0-9A-Fa-f]{6}$'
    ),
  constraint artwork_palettes_source_length
    check (
      not (palette ? 'source')
      or (
        (palette ->> 'source') is not null
        and octet_length(palette ->> 'source') between 1 and 64
      )
    ),
  constraint artwork_palettes_provider_name_length
    check (
      provider_name is null
      or octet_length(provider_name) between 1 and 120
    ),
  constraint artwork_palettes_provider_track_id_length
    check (
      provider_track_id is null
      or octet_length(provider_track_id) between 1 and 512
    ),
  constraint artwork_palettes_provider_identity_consistency
    check (provider_track_id is null or provider_name is not null),
  constraint artwork_palettes_match_confidence_range
    check (match_confidence is null or match_confidence between 0 and 1),
  constraint artwork_palettes_raw_metadata_object
    check (jsonb_typeof(raw_metadata) = 'object'),
  constraint artwork_palettes_raw_metadata_size
    check (octet_length(raw_metadata::text) <= 16384),
  constraint artwork_palettes_key_unique
    unique (library_id, artwork_key, key_version)
);

comment on table public.artwork_palettes is
  'Private derived artwork colors and match metadata. No image bytes or Storage paths are persisted.';

create index artwork_palettes_provider_reference
  on public.artwork_palettes (library_id, provider_name, provider_track_id)
  where provider_name is not null;

create trigger artwork_palettes_set_updated_at
before update on public.artwork_palettes
for each row execute function private.set_updated_at();

create function public.upsert_artwork_palette(
  p_library_id uuid,
  p_artwork_key text,
  p_key_version integer,
  p_palette jsonb,
  p_provider_name text,
  p_provider_track_id text,
  p_match_confidence numeric,
  p_raw_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_artwork_key text := nullif(btrim(p_artwork_key), '');
  v_provider_name text := nullif(btrim(p_provider_name), '');
  v_provider_track_id text := nullif(btrim(p_provider_track_id), '');
  v_raw_metadata jsonb := coalesce(p_raw_metadata, '{}'::jsonb);
  v_palette public.artwork_palettes%rowtype;
begin
  if p_key_version is null or p_key_version < 1 or p_key_version > 32767 then
    raise exception 'key_version must be between 1 and 32767'
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

  if v_artwork_key is null or octet_length(v_artwork_key) > 512 then
    raise exception 'artwork_key must contain between 1 and 512 bytes'
      using errcode = '22023';
  end if;

  if p_palette is null
    or jsonb_typeof(p_palette) <> 'object'
    or octet_length(p_palette::text) > 4096 then
    raise exception 'palette must be a JSON object no larger than 4096 bytes'
      using errcode = '22023';
  end if;

  if (p_palette ->> 'primary') is null
    or (p_palette ->> 'primary') !~ '^#[0-9A-Fa-f]{6}$'
    or (p_palette ->> 'secondary') is null
    or (p_palette ->> 'secondary') !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'palette primary and secondary must be hexadecimal colors'
      using errcode = '22023';
  end if;

  if p_palette ? 'source'
    and (
      (p_palette ->> 'source') is null
      or octet_length(p_palette ->> 'source') not between 1 and 64
    ) then
    raise exception 'palette source must contain between 1 and 64 bytes'
      using errcode = '22023';
  end if;

  if v_provider_name is not null and octet_length(v_provider_name) > 120 then
    raise exception 'provider_name must not exceed 120 bytes'
      using errcode = '22023';
  end if;

  if v_provider_track_id is not null then
    if v_provider_name is null then
      raise exception 'provider_name is required when provider_track_id is present'
        using errcode = '22023';
    end if;
    if octet_length(v_provider_track_id) > 512 then
      raise exception 'provider_track_id must not exceed 512 bytes'
        using errcode = '22023';
    end if;
  end if;

  if p_match_confidence is not null
    and (p_match_confidence < 0 or p_match_confidence > 1) then
    raise exception 'match_confidence must be between 0 and 1'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_raw_metadata) <> 'object'
    or octet_length(v_raw_metadata::text) > 16384 then
    raise exception 'raw_metadata must be a JSON object no larger than 16384 bytes'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'artwork-palette:' || p_library_id::text || ':'
      || p_key_version::text || ':' || v_artwork_key,
      0
    )
  );

  insert into public.artwork_palettes (
    library_id,
    artwork_key,
    key_version,
    palette,
    provider_name,
    provider_track_id,
    match_confidence,
    raw_metadata
  )
  values (
    p_library_id,
    v_artwork_key,
    p_key_version,
    p_palette,
    v_provider_name,
    v_provider_track_id,
    p_match_confidence,
    v_raw_metadata
  )
  on conflict (library_id, artwork_key, key_version)
  do update set
    palette = excluded.palette,
    provider_name = excluded.provider_name,
    provider_track_id = excluded.provider_track_id,
    match_confidence = excluded.match_confidence,
    raw_metadata = excluded.raw_metadata
  returning * into v_palette;

  return jsonb_build_object(
    'palette_id', v_palette.id,
    'artwork_key', v_palette.artwork_key,
    'key_version', v_palette.key_version,
    'palette', v_palette.palette,
    'provider_name', v_palette.provider_name,
    'provider_track_id', v_palette.provider_track_id,
    'match_confidence', v_palette.match_confidence,
    'created_at', v_palette.created_at,
    'updated_at', v_palette.updated_at
  );
end;
$$;

comment on function public.upsert_artwork_palette(
  uuid,
  text,
  integer,
  jsonb,
  text,
  text,
  numeric,
  jsonb
) is
  'Idempotently persist private derived artwork colors and match metadata without image bytes.';

alter table public.artwork_palettes enable row level security;
revoke all on table public.artwork_palettes
  from public, anon, authenticated, service_role;
revoke all on function public.upsert_artwork_palette(
  uuid,
  text,
  integer,
  jsonb,
  text,
  text,
  numeric,
  jsonb
) from public, anon, authenticated;
grant execute on function public.upsert_artwork_palette(
  uuid,
  text,
  integer,
  jsonb,
  text,
  text,
  numeric,
  jsonb
) to service_role;

-- Preserve any palette metadata if an operator briefly enabled the previous
-- image archive before applying this migration. Image paths and hashes are
-- intentionally not copied.
insert into public.artwork_palettes (
  library_id,
  artwork_key,
  key_version,
  palette,
  provider_name,
  provider_track_id,
  match_confidence,
  raw_metadata,
  created_at,
  updated_at
)
select
  asset.library_id,
  asset.artwork_key,
  asset.key_version,
  asset.palette,
  case when asset.provider_track_id is null then null else 'apple' end,
  asset.provider_track_id,
  null,
  asset.raw_metadata,
  asset.created_at,
  asset.updated_at
from public.artwork_assets as asset
on conflict (library_id, artwork_key, key_version)
do update set
  palette = excluded.palette,
  provider_name = excluded.provider_name,
  provider_track_id = excluded.provider_track_id,
  raw_metadata = excluded.raw_metadata;

-- A SQL migration cannot safely remove bytes from the Storage backend. Lock
-- the dedicated bucket and refuse the migration if it contains any objects;
-- operators must empty it through the Storage API before retrying. The prior
-- version never enabled image persistence, so the expected object count is 0.
do $$
declare
  v_object_count bigint;
begin
  perform 1
  from storage.buckets as bucket
  where bucket.id = 'lyrics-artwork'
  for update;

  select count(*)
  into v_object_count
  from storage.objects as object
  where object.bucket_id = 'lyrics-artwork';

  if v_object_count > 0 then
    raise exception 'lyrics-artwork bucket contains % object(s)', v_object_count
      using
        errcode = '55000',
        hint = 'Delete the dedicated bucket objects through the Supabase Storage API, then retry this migration.';
  end if;
end;
$$;

revoke all on function public.upsert_artwork_asset(
  uuid,
  text,
  integer,
  text,
  text,
  text,
  bigint,
  text,
  jsonb,
  jsonb
) from public, anon, authenticated, service_role;

drop function public.upsert_artwork_asset(
  uuid,
  text,
  integer,
  text,
  text,
  text,
  bigint,
  text,
  jsonb,
  jsonb
);

drop table public.artwork_assets;

-- Storage metadata cannot be deleted safely from SQL. Disable the legacy
-- bucket here so an old client cannot upload a meaningful object; the empty
-- bucket is removed through the Storage API after this migration succeeds.
update storage.buckets
set
  public = false,
  file_size_limit = 1,
  allowed_mime_types = array[]::text[],
  updated_at = transaction_timestamp()
where id = 'lyrics-artwork';
