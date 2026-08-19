create or replace function private.preserve_artwork_palette_provenance()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.provider_name = 'local-cache'
    and old.provider_name is not null
    and old.provider_name <> 'local-cache' then
    new.provider_name := old.provider_name;
    new.provider_track_id := old.provider_track_id;
    new.match_confidence := old.match_confidence;
    new.raw_metadata := old.raw_metadata;
  end if;

  return new;
end;
$$;

comment on function private.preserve_artwork_palette_provenance() is
  'Prevent local Fly cache backfills from replacing stronger upstream artwork match provenance.';

revoke all on function private.preserve_artwork_palette_provenance()
  from public, anon, authenticated, service_role;

drop trigger if exists artwork_palettes_00_preserve_provenance
  on public.artwork_palettes;

create trigger artwork_palettes_00_preserve_provenance
before update on public.artwork_palettes
for each row execute function private.preserve_artwork_palette_provenance();

update public.lyrics_libraries
set display_name = 'Lyrla'
where id = '00000000-0000-4000-8000-000000000001'::uuid;
