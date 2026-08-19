create schema if not exists extensions;
create schema if not exists private;

create extension if not exists pgcrypto with schema extensions;

create type public.lyrics_status as enum (
  'quarantine',
  'active',
  'rejected',
  'superseded'
);

create type public.lyrics_acquisition as enum (
  'provider',
  'manual',
  'candidate',
  'legacy_import'
);

create type public.lyrics_binding_kind as enum (
  'exact',
  'work'
);

create table public.lyrics_libraries (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  is_private boolean not null default true,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint lyrics_libraries_slug_format
    check (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  constraint lyrics_libraries_display_name_length
    check (char_length(display_name) between 1 and 120),
  constraint lyrics_libraries_private_only
    check (is_private)
);

comment on table public.lyrics_libraries is
  'Private lyrics-library tenants. Version one seeds exactly one private library.';

create table public.lyrics_documents (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references public.lyrics_libraries(id) on delete cascade,
  source_identity text not null,
  initial_acquisition public.lyrics_acquisition not null,
  is_private boolean not null default true,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint lyrics_documents_source_identity_length
    check (char_length(source_identity) between 1 and 1024),
  constraint lyrics_documents_private_only
    check (is_private),
  constraint lyrics_documents_library_id_id_unique
    unique (library_id, id),
  constraint lyrics_documents_source_identity_unique
    unique (library_id, source_identity)
);

comment on table public.lyrics_documents is
  'Stable, library-private lyric identities. Mutable lyric text lives in immutable revisions.';

create table public.lyrics_revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.lyrics_documents(id) on delete cascade,
  revision_number integer not null,
  is_current boolean not null default true,
  synced_lyrics text,
  plain_lyrics text,
  is_instrumental boolean not null default false,
  language_code text,
  duration_ms integer,
  content_hash text not null,
  provider_name text,
  provider_track_id text,
  provider_url text,
  rights_basis text,
  source_terms_version text,
  source_payload jsonb not null default '{}'::jsonb,
  provenance jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default transaction_timestamp(),
  created_at timestamptz not null default transaction_timestamp(),
  superseded_at timestamptz,
  constraint lyrics_revisions_revision_number_positive
    check (revision_number > 0),
  constraint lyrics_revisions_document_revision_unique
    unique (document_id, revision_number),
  constraint lyrics_revisions_content_hash_format
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint lyrics_revisions_content_required
    check (
      (
        is_instrumental
        and synced_lyrics is null
        and plain_lyrics is null
      )
      or
      (
        not is_instrumental
        and (synced_lyrics is not null or plain_lyrics is not null)
      )
    ),
  constraint lyrics_revisions_language_code_length
    check (language_code is null or char_length(language_code) between 1 and 35),
  constraint lyrics_revisions_duration_nonnegative
    check (duration_ms is null or duration_ms >= 0),
  constraint lyrics_revisions_provider_name_length
    check (provider_name is null or char_length(provider_name) between 1 and 120),
  constraint lyrics_revisions_provider_track_id_length
    check (provider_track_id is null or char_length(provider_track_id) between 1 and 512),
  constraint lyrics_revisions_source_payload_object
    check (jsonb_typeof(source_payload) = 'object'),
  constraint lyrics_revisions_provenance_object
    check (jsonb_typeof(provenance) = 'object'),
  constraint lyrics_revisions_superseded_consistency
    check (
      (is_current and superseded_at is null)
      or (not is_current and superseded_at is not null)
    )
);

comment on table public.lyrics_revisions is
  'Immutable lyric payload revisions, including instrumental positive records and provider provenance.';

create unique index lyrics_revisions_one_current_per_document
  on public.lyrics_revisions (document_id)
  where is_current;

create index lyrics_revisions_provider_reference
  on public.lyrics_revisions (provider_name, provider_track_id)
  where provider_name is not null and provider_track_id is not null;

create index lyrics_revisions_content_hash
  on public.lyrics_revisions (content_hash);

create table public.lyrics_bindings (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references public.lyrics_libraries(id) on delete cascade,
  document_id uuid not null,
  binding_kind public.lyrics_binding_kind not null,
  key_version smallint not null,
  lookup_key text not null,
  status public.lyrics_status not null default 'quarantine',
  selection_method public.lyrics_acquisition not null,
  selection_version bigint,
  match_confidence numeric(6, 5),
  raw_metadata jsonb not null default '{}'::jsonb,
  status_reason text,
  superseded_by_binding_id uuid,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  superseded_at timestamptz,
  constraint lyrics_bindings_key_version_positive
    check (key_version > 0),
  constraint lyrics_bindings_lookup_key_length
    check (char_length(lookup_key) between 1 and 512),
  constraint lyrics_bindings_match_confidence_range
    check (match_confidence is null or match_confidence between 0 and 1),
  constraint lyrics_bindings_selection_version_nonnegative
    check (selection_version is null or selection_version >= 0),
  constraint lyrics_bindings_active_selection_version_required
    check (status <> 'active' or selection_version is not null),
  constraint lyrics_bindings_raw_metadata_object
    check (jsonb_typeof(raw_metadata) = 'object'),
  constraint lyrics_bindings_not_self_superseded
    check (superseded_by_binding_id is null or superseded_by_binding_id <> id),
  constraint lyrics_bindings_superseded_consistency
    check (
      (status = 'superseded' and superseded_at is not null)
      or (status <> 'superseded' and superseded_at is null)
    ),
  constraint lyrics_bindings_library_id_id_unique
    unique (library_id, id),
  constraint lyrics_bindings_document_library_fk
    foreign key (library_id, document_id)
    references public.lyrics_documents(library_id, id)
    on delete cascade,
  constraint lyrics_bindings_superseded_library_fk
    foreign key (library_id, superseded_by_binding_id)
    references public.lyrics_bindings(library_id, id)
    on delete no action,
  constraint lyrics_bindings_document_key_unique
    unique (library_id, binding_kind, key_version, lookup_key, document_id)
);

comment on table public.lyrics_bindings is
  'Versioned exact/work lookup aliases. Automatic matches remain quarantined until explicitly selected.';

create unique index lyrics_bindings_one_active_per_key
  on public.lyrics_bindings (library_id, binding_kind, key_version, lookup_key)
  where status = 'active';

create index lyrics_bindings_resolve
  on public.lyrics_bindings (
    library_id,
    key_version,
    binding_kind,
    lookup_key,
    status,
    updated_at desc
  )
  include (document_id, selection_method, selection_version, match_confidence);

create index lyrics_bindings_document
  on public.lyrics_bindings (document_id, status);

create table public.artwork_assets (
  id uuid primary key default gen_random_uuid(),
  library_id uuid not null references public.lyrics_libraries(id) on delete cascade,
  artwork_key text not null,
  key_version smallint not null,
  storage_path text not null,
  sha256 text not null,
  mime_type text not null,
  byte_size bigint not null,
  provider_track_id text,
  raw_metadata jsonb not null default '{}'::jsonb,
  palette jsonb,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  constraint artwork_assets_key_version_positive
    check (key_version > 0),
  constraint artwork_assets_artwork_key_length
    check (octet_length(artwork_key) between 1 and 512),
  constraint artwork_assets_storage_path_length
    check (octet_length(storage_path) between 38 and 1024),
  constraint artwork_assets_storage_path_library_prefix
    check (storage_path like library_id::text || '/%'),
  constraint artwork_assets_storage_path_safe
    check (
      storage_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9][A-Za-z0-9._/-]*$'
      and storage_path !~ '(^|/)[.]{1,2}(/|$)'
      and position('//' in storage_path) = 0
    ),
  constraint artwork_assets_sha256_format
    check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint artwork_assets_mime_type_supported
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint artwork_assets_byte_size_limit
    check (byte_size between 1 and 2097152),
  constraint artwork_assets_provider_track_id_length
    check (
      provider_track_id is null
      or octet_length(provider_track_id) between 1 and 512
    ),
  constraint artwork_assets_raw_metadata_object
    check (jsonb_typeof(raw_metadata) = 'object'),
  constraint artwork_assets_raw_metadata_size
    check (octet_length(raw_metadata::text) <= 16384),
  constraint artwork_assets_palette_object
    check (palette is null or jsonb_typeof(palette) = 'object'),
  constraint artwork_assets_palette_size
    check (palette is null or octet_length(palette::text) <= 4096),
  constraint artwork_assets_key_unique
    unique (library_id, artwork_key, key_version)
);

comment on table public.artwork_assets is
  'Private artwork lookup metadata. Object bytes live in the private lyrics-artwork Storage bucket.';

create index artwork_assets_storage_path
  on public.artwork_assets (library_id, storage_path);

create index artwork_assets_sha256
  on public.artwork_assets (library_id, sha256);

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := transaction_timestamp();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public;

create trigger lyrics_libraries_set_updated_at
before update on public.lyrics_libraries
for each row execute function private.set_updated_at();

create trigger lyrics_documents_set_updated_at
before update on public.lyrics_documents
for each row execute function private.set_updated_at();

create trigger lyrics_bindings_set_updated_at
before update on public.lyrics_bindings
for each row execute function private.set_updated_at();

create trigger artwork_assets_set_updated_at
before update on public.artwork_assets
for each row execute function private.set_updated_at();

insert into public.lyrics_libraries (id, slug, display_name)
values (
  '00000000-0000-4000-8000-000000000001'::uuid,
  'default',
  'Lyrla'
)
on conflict (id) do nothing;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'lyrics-artwork',
  'lyrics-artwork',
  false,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  updated_at = transaction_timestamp();

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
  v_match record;
  v_candidates jsonb;
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

  if v_exact_key is not null then
    select
      binding.id as binding_id,
      binding.binding_kind,
      binding.status,
      binding.selection_method,
      binding.selection_version,
      binding.match_confidence,
      binding.raw_metadata,
      document.id as document_id,
      revision.id as revision_id,
      revision.synced_lyrics,
      revision.plain_lyrics,
      revision.is_instrumental,
      revision.language_code,
      revision.duration_ms,
      revision.provider_name,
      revision.provider_track_id,
      revision.provider_url,
      revision.rights_basis,
      revision.provenance,
      revision.content_hash,
      revision.created_at as revision_created_at
    into v_match
    from public.lyrics_bindings as binding
    join public.lyrics_documents as document
      on document.id = binding.document_id
      and document.library_id = binding.library_id
    join public.lyrics_revisions as revision
      on revision.document_id = document.id
      and revision.is_current
    where binding.library_id = p_library_id
      and binding.binding_kind = 'exact'
      and binding.key_version = p_key_version
      and binding.lookup_key = v_exact_key
      and binding.status = 'active'
    limit 1;

    if found then
      return jsonb_build_object(
        'result_status', 'hit',
        'match_kind', v_match.binding_kind,
        'auto_scroll', v_match.synced_lyrics is not null,
        'binding_id', v_match.binding_id,
        'document_id', v_match.document_id,
        'revision_id', v_match.revision_id,
        'status', v_match.status,
        'selection_method', v_match.selection_method,
        'selection_version', v_match.selection_version,
        'match_confidence', v_match.match_confidence,
        'synced_lyrics', v_match.synced_lyrics,
        'plain_lyrics', v_match.plain_lyrics,
        'is_instrumental', v_match.is_instrumental,
        'language_code', v_match.language_code,
        'duration_ms', v_match.duration_ms,
        'provider_name', v_match.provider_name,
        'provider_track_id', v_match.provider_track_id,
        'provider_url', v_match.provider_url,
        'rights_basis', v_match.rights_basis,
        'content_hash', v_match.content_hash,
        'raw_metadata', v_match.raw_metadata,
        'provenance', v_match.provenance,
        'revision_created_at', v_match.revision_created_at,
        'candidates', '[]'::jsonb
      );
    end if;
  end if;

  if v_work_key is not null then
    select
      binding.id as binding_id,
      binding.binding_kind,
      binding.status,
      binding.selection_method,
      binding.selection_version,
      binding.match_confidence,
      binding.raw_metadata,
      document.id as document_id,
      revision.id as revision_id,
      revision.synced_lyrics,
      revision.plain_lyrics,
      revision.is_instrumental,
      revision.language_code,
      revision.duration_ms,
      revision.provider_name,
      revision.provider_track_id,
      revision.provider_url,
      revision.rights_basis,
      revision.provenance,
      revision.content_hash,
      revision.created_at as revision_created_at
    into v_match
    from public.lyrics_bindings as binding
    join public.lyrics_documents as document
      on document.id = binding.document_id
      and document.library_id = binding.library_id
    join public.lyrics_revisions as revision
      on revision.document_id = document.id
      and revision.is_current
    where binding.library_id = p_library_id
      and binding.binding_kind = 'work'
      and binding.key_version = p_key_version
      and binding.lookup_key = v_work_key
      and binding.status = 'active'
    limit 1;

    if found then
      return jsonb_build_object(
        'result_status', 'hit',
        'match_kind', v_match.binding_kind,
        'auto_scroll', false,
        'binding_id', v_match.binding_id,
        'document_id', v_match.document_id,
        'revision_id', v_match.revision_id,
        'status', v_match.status,
        'selection_method', v_match.selection_method,
        'selection_version', v_match.selection_version,
        'match_confidence', v_match.match_confidence,
        'synced_lyrics', v_match.synced_lyrics,
        'plain_lyrics', v_match.plain_lyrics,
        'is_instrumental', v_match.is_instrumental,
        'language_code', v_match.language_code,
        'duration_ms', v_match.duration_ms,
        'provider_name', v_match.provider_name,
        'provider_track_id', v_match.provider_track_id,
        'provider_url', v_match.provider_url,
        'rights_basis', v_match.rights_basis,
        'content_hash', v_match.content_hash,
        'raw_metadata', v_match.raw_metadata,
        'provenance', v_match.provenance,
        'revision_created_at', v_match.revision_created_at,
        'candidates', '[]'::jsonb
      );
    end if;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'match_kind', candidate.binding_kind,
        'binding_id', candidate.binding_id,
        'document_id', candidate.document_id,
        'revision_id', candidate.revision_id,
        'status', candidate.status,
        'selection_method', candidate.selection_method,
        'match_confidence', candidate.match_confidence,
        'title', candidate.title,
        'artist', candidate.artist,
        'album', candidate.album,
        'duration_ms', candidate.metadata_duration_ms,
        'has_synced', candidate.has_synced,
        'has_plain', candidate.has_plain,
        'is_instrumental', candidate.is_instrumental,
        'language_code', candidate.language_code,
        'provider_name', candidate.provider_name,
        'provider_track_id', candidate.provider_track_id
      )
      order by
        case candidate.binding_kind when 'exact' then 0 else 1 end,
        candidate.match_confidence desc nulls last,
        candidate.binding_updated_at desc
    ),
    '[]'::jsonb
  )
  into v_candidates
  from (
    select
      binding.id as binding_id,
      binding.binding_kind,
      binding.status,
      binding.selection_method,
      binding.match_confidence,
      binding.updated_at as binding_updated_at,
      binding.raw_metadata ->> 'title' as title,
      binding.raw_metadata ->> 'artist' as artist,
      binding.raw_metadata ->> 'album' as album,
      coalesce(
        binding.raw_metadata -> 'duration_ms',
        binding.raw_metadata -> 'durationMs'
      ) as metadata_duration_ms,
      document.id as document_id,
      revision.id as revision_id,
      revision.synced_lyrics is not null as has_synced,
      revision.plain_lyrics is not null as has_plain,
      revision.is_instrumental,
      revision.language_code,
      revision.provider_name,
      revision.provider_track_id
    from public.lyrics_bindings as binding
    join public.lyrics_documents as document
      on document.id = binding.document_id
      and document.library_id = binding.library_id
    join public.lyrics_revisions as revision
      on revision.document_id = document.id
      and revision.is_current
    where binding.library_id = p_library_id
      and binding.key_version = p_key_version
      and binding.status = 'quarantine'
      and (
        (
          v_exact_key is not null
          and binding.binding_kind = 'exact'
          and binding.lookup_key = v_exact_key
        )
        or
        (
          v_work_key is not null
          and binding.binding_kind = 'work'
          and binding.lookup_key = v_work_key
        )
      )
    order by
      case binding.binding_kind when 'exact' then 0 else 1 end,
      binding.match_confidence desc nulls last,
      binding.updated_at desc
    limit 20
  ) as candidate;

  if jsonb_array_length(v_candidates) > 0 then
    return jsonb_build_object(
      'result_status', 'ambiguous',
      'match_kind', null,
      'auto_scroll', false,
      'candidate_count', jsonb_array_length(v_candidates),
      'candidates', v_candidates
    );
  end if;

  return jsonb_build_object(
    'result_status', 'miss',
    'match_kind', null,
    'auto_scroll', false,
    'candidate_count', 0,
    'candidates', '[]'::jsonb
  );
end;
$$;

comment on function public.resolve_lyrics(uuid, text, text, integer) is
  'Resolve trusted exact lyrics first, trusted work fallback second, then surface quarantined candidates.';

create function public.upsert_lyrics_document(
  p_library_id uuid,
  p_exact_key text,
  p_work_key text,
  p_key_version integer,
  p_raw_metadata jsonb,
  p_payload jsonb,
  p_provenance jsonb,
  p_acquisition public.lyrics_acquisition,
  p_requested_status public.lyrics_status default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := transaction_timestamp();
  v_exact_key text := nullif(btrim(p_exact_key), '');
  v_work_key text := nullif(btrim(p_work_key), '');
  v_raw_metadata jsonb := coalesce(p_raw_metadata, '{}'::jsonb);
  v_provenance jsonb := coalesce(p_provenance, '{}'::jsonb);
  v_synced_lyrics text;
  v_plain_lyrics text;
  v_is_instrumental boolean;
  v_language_code text;
  v_duration_ms integer;
  v_content_hash text;
  v_provider_name text;
  v_provider_track_id text;
  v_provider_url text;
  v_rights_basis text;
  v_source_terms_version text;
  v_source_identity text;
  v_idempotency_key text;
  v_status_reason text;
  v_selection_version bigint;
  v_match_confidence numeric(6, 5);
  v_effective_status public.lyrics_status;
  v_document_id uuid;
  v_revision_id uuid;
  v_existing_revision record;
  v_revision_number integer;
  v_key record;
  v_binding_id uuid;
  v_binding_status public.lyrics_status;
  v_binding_selection_version bigint;
  v_superseded_ids uuid[];
  v_stale_binding_count integer := 0;
  v_conflicting_binding_count integer := 0;
  v_bindings jsonb := '[]'::jsonb;
begin
  if p_acquisition is null then
    raise exception 'acquisition is required'
      using errcode = '22023';
  end if;

  if p_key_version is null or p_key_version < 1 or p_key_version > 32767 then
    raise exception 'key_version must be between 1 and 32767'
      using errcode = '22023';
  end if;

  if v_exact_key is null and v_work_key is null then
    raise exception 'at least one lookup key is required'
      using errcode = '22023';
  end if;

  if char_length(coalesce(v_exact_key, '')) > 512
    or char_length(coalesce(v_work_key, '')) > 512 then
    raise exception 'lookup keys must not exceed 512 characters'
      using errcode = '22023';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload must be a JSON object'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_raw_metadata) <> 'object' then
    raise exception 'raw_metadata must be a JSON object'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_provenance) <> 'object' then
    raise exception 'provenance must be a JSON object'
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

  v_synced_lyrics := coalesce(
    p_payload ->> 'synced_lyrics',
    p_payload ->> 'syncedLyrics'
  );
  if v_synced_lyrics is not null and btrim(v_synced_lyrics) = '' then
    v_synced_lyrics := null;
  end if;

  v_plain_lyrics := coalesce(
    p_payload ->> 'plain_lyrics',
    p_payload ->> 'plainLyrics'
  );
  if v_plain_lyrics is not null and btrim(v_plain_lyrics) = '' then
    v_plain_lyrics := null;
  end if;

  v_is_instrumental := coalesce(
    nullif(
      coalesce(
        p_payload ->> 'is_instrumental',
        p_payload ->> 'instrumental'
      ),
      ''
    )::boolean,
    false
  );

  v_language_code := nullif(
    btrim(
      coalesce(
        p_payload ->> 'language_code',
        p_payload ->> 'languageCode'
      )
    ),
    ''
  );

  v_duration_ms := nullif(
    coalesce(
      p_payload ->> 'duration_ms',
      p_payload ->> 'durationMs'
    ),
    ''
  )::integer;

  if v_duration_ms is not null and v_duration_ms < 0 then
    raise exception 'duration_ms must be nonnegative'
      using errcode = '22023';
  end if;

  if v_is_instrumental and (v_synced_lyrics is not null or v_plain_lyrics is not null) then
    raise exception 'instrumental payloads must not contain lyric text'
      using errcode = '22023';
  end if;

  if not v_is_instrumental and v_synced_lyrics is null and v_plain_lyrics is null then
    raise exception 'non-instrumental payloads require synced or plain lyrics'
      using errcode = '22023';
  end if;

  v_provider_name := nullif(
    btrim(
      coalesce(
        v_provenance ->> 'provider_name',
        v_provenance ->> 'providerName'
      )
    ),
    ''
  );
  v_provider_track_id := nullif(
    btrim(
      coalesce(
        v_provenance ->> 'provider_track_id',
        v_provenance ->> 'providerTrackId'
      )
    ),
    ''
  );
  v_provider_url := nullif(
    btrim(
      coalesce(
        v_provenance ->> 'provider_url',
        v_provenance ->> 'providerUrl'
      )
    ),
    ''
  );
  v_rights_basis := nullif(
    btrim(
      coalesce(
        v_provenance ->> 'rights_basis',
        v_provenance ->> 'rightsBasis'
      )
    ),
    ''
  );
  v_source_terms_version := nullif(
    btrim(
      coalesce(
        v_provenance ->> 'source_terms_version',
        v_provenance ->> 'sourceTermsVersion'
      )
    ),
    ''
  );
  v_idempotency_key := nullif(
    btrim(
      coalesce(
        v_provenance ->> 'idempotency_key',
        v_provenance ->> 'idempotencyKey'
      )
    ),
    ''
  );
  v_status_reason := nullif(
    btrim(
      coalesce(
        v_provenance ->> 'status_reason',
        v_provenance ->> 'statusReason'
      )
    ),
    ''
  );

  v_selection_version := nullif(
    coalesce(
      v_provenance ->> 'selection_version',
      v_provenance ->> 'selectionVersion'
    ),
    ''
  )::bigint;

  if v_selection_version is not null and v_selection_version < 0 then
    raise exception 'selection_version must be a nonnegative integer'
      using errcode = '22023';
  end if;

  v_match_confidence := nullif(
    coalesce(
      v_provenance ->> 'match_confidence',
      v_provenance ->> 'matchConfidence'
    ),
    ''
  )::numeric;

  if v_match_confidence is not null
    and (v_match_confidence < 0 or v_match_confidence > 1) then
    raise exception 'match_confidence must be between 0 and 1'
      using errcode = '22023';
  end if;

  v_effective_status := coalesce(p_requested_status, 'quarantine');
  if p_acquisition in ('provider', 'legacy_import')
    and v_effective_status = 'active' then
    v_effective_status := 'quarantine';
  end if;

  if p_acquisition in ('manual', 'candidate')
    and v_effective_status = 'active'
    and v_selection_version is null then
    raise exception 'active manual/candidate writes require selection_version'
      using errcode = '22023';
  end if;

  v_content_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'duration_ms', v_duration_ms,
          'is_instrumental', v_is_instrumental,
          'language_code', v_language_code,
          'plain_lyrics', v_plain_lyrics,
          'synced_lyrics', v_synced_lyrics
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  if v_idempotency_key is not null then
    if char_length(v_idempotency_key) > 900 then
      raise exception 'idempotency_key must not exceed 900 characters'
        using errcode = '22023';
    end if;
    v_source_identity := 'custom:' || v_idempotency_key;
  elsif v_provider_name is not null and v_provider_track_id is not null then
    v_source_identity :=
      'provider:' || lower(v_provider_name) || ':' || v_provider_track_id;
  elsif p_acquisition = 'manual' then
    v_source_identity :=
      'manual:v' || p_key_version::text || ':' || coalesce(v_exact_key, v_work_key);
  elsif p_acquisition = 'legacy_import' then
    v_source_identity :=
      'legacy:v' || p_key_version::text || ':' || coalesce(v_exact_key, v_work_key);
  else
    v_source_identity :=
      p_acquisition::text || ':' || coalesce(lower(v_provider_name), 'unknown')
      || ':v' || p_key_version::text || ':' || coalesce(v_exact_key, v_work_key)
      || ':' || v_content_hash;
  end if;

  if char_length(v_source_identity) > 1024 then
    v_source_identity :=
      left(v_source_identity, 950) || ':'
      || encode(
        extensions.digest(convert_to(v_source_identity, 'UTF8'), 'sha256'),
        'hex'
      );
  end if;

  -- Acquire every key lock before the CAS and before writing a document or
  -- revision. Enum order is exact then work, so overlapping multi-key writes
  -- always take locks in the same order. Hash collisions only serialize
  -- unrelated writes and cannot compromise data.
  for v_key in
    select key_data.binding_kind, key_data.lookup_key
    from (
      values
        ('exact'::public.lyrics_binding_kind, v_exact_key),
        ('work'::public.lyrics_binding_kind, v_work_key)
    ) as key_data(binding_kind, lookup_key)
    where key_data.lookup_key is not null
    order by key_data.binding_kind, key_data.lookup_key
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        p_library_id::text || ':'
        || v_key.binding_kind::text || ':'
        || p_key_version::text || ':'
        || v_key.lookup_key,
        0
      )
    );
  end loop;

  if v_effective_status = 'active' then
    select
      count(*) filter (
        where active_binding.selection_version > v_selection_version
      ),
      count(*) filter (
        where active_binding.selection_version = v_selection_version
          and (
            active_document.source_identity <> v_source_identity
            or active_revision.content_hash is distinct from v_content_hash
          )
      )
    into v_stale_binding_count, v_conflicting_binding_count
    from (
      values
        ('exact'::public.lyrics_binding_kind, v_exact_key),
        ('work'::public.lyrics_binding_kind, v_work_key)
    ) as key_data(binding_kind, lookup_key)
    join public.lyrics_bindings as active_binding
      on active_binding.library_id = p_library_id
      and active_binding.binding_kind = key_data.binding_kind
      and active_binding.key_version = p_key_version
      and active_binding.lookup_key = key_data.lookup_key
      and active_binding.status = 'active'
    join public.lyrics_documents as active_document
      on active_document.id = active_binding.document_id
      and active_document.library_id = active_binding.library_id
    left join public.lyrics_revisions as active_revision
      on active_revision.document_id = active_document.id
      and active_revision.is_current
    where key_data.lookup_key is not null
      and active_binding.selection_version is not null;

    if v_stale_binding_count + v_conflicting_binding_count > 0 then
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'binding_id', active_binding.id,
            'document_id', active_binding.document_id,
            'match_kind', key_data.binding_kind,
            'status', active_binding.status,
            'lookup_key', key_data.lookup_key,
            'selection_version', active_binding.selection_version,
            'ignored_stale',
              active_binding.selection_version > v_selection_version,
            'ignored_conflict',
              active_binding.selection_version = v_selection_version
              and (
                active_document.source_identity <> v_source_identity
                or active_revision.content_hash is distinct from v_content_hash
              )
          )
          order by key_data.binding_kind, key_data.lookup_key
        ),
        '[]'::jsonb
      )
      into v_bindings
      from (
        values
          ('exact'::public.lyrics_binding_kind, v_exact_key),
          ('work'::public.lyrics_binding_kind, v_work_key)
      ) as key_data(binding_kind, lookup_key)
      join public.lyrics_bindings as active_binding
        on active_binding.library_id = p_library_id
        and active_binding.binding_kind = key_data.binding_kind
        and active_binding.key_version = p_key_version
        and active_binding.lookup_key = key_data.lookup_key
        and active_binding.status = 'active'
      join public.lyrics_documents as active_document
        on active_document.id = active_binding.document_id
        and active_document.library_id = active_binding.library_id
      left join public.lyrics_revisions as active_revision
        on active_revision.document_id = active_document.id
        and active_revision.is_current
      where key_data.lookup_key is not null
        and active_binding.selection_version is not null
        and (
          active_binding.selection_version > v_selection_version
          or (
            active_binding.selection_version = v_selection_version
            and (
              active_document.source_identity <> v_source_identity
              or active_revision.content_hash is distinct from v_content_hash
            )
          )
        );

      return jsonb_build_object(
        'document_id', null,
        'revision_id', null,
        'content_hash', v_content_hash,
        'requested_status', p_requested_status,
        'effective_status', v_effective_status,
        'selection_version', v_selection_version,
        'promotion_blocked', false,
        'ignored_stale', v_stale_binding_count > 0,
        'ignored_conflict', v_conflicting_binding_count > 0,
        'bindings', v_bindings
      );
    end if;
  end if;

  insert into public.lyrics_documents (
    library_id,
    source_identity,
    initial_acquisition
  )
  values (
    p_library_id,
    v_source_identity,
    p_acquisition
  )
  on conflict (library_id, source_identity)
  do update set updated_at = excluded.updated_at
  returning id into v_document_id;

  select
    revision.id,
    revision.revision_number,
    revision.content_hash
  into v_existing_revision
  from public.lyrics_revisions as revision
  where revision.document_id = v_document_id
    and revision.is_current
  for update;

  if found and v_existing_revision.content_hash = v_content_hash then
    v_revision_id := v_existing_revision.id;
  else
    update public.lyrics_revisions
    set
      is_current = false,
      superseded_at = v_now
    where document_id = v_document_id
      and is_current;

    select coalesce(max(revision.revision_number), 0) + 1
    into v_revision_number
    from public.lyrics_revisions as revision
    where revision.document_id = v_document_id;

    insert into public.lyrics_revisions (
      document_id,
      revision_number,
      synced_lyrics,
      plain_lyrics,
      is_instrumental,
      language_code,
      duration_ms,
      content_hash,
      provider_name,
      provider_track_id,
      provider_url,
      rights_basis,
      source_terms_version,
      source_payload,
      provenance,
      fetched_at
    )
    values (
      v_document_id,
      v_revision_number,
      v_synced_lyrics,
      v_plain_lyrics,
      v_is_instrumental,
      v_language_code,
      v_duration_ms,
      v_content_hash,
      v_provider_name,
      v_provider_track_id,
      v_provider_url,
      v_rights_basis,
      v_source_terms_version,
      p_payload,
      v_provenance,
      v_now
    )
    returning id into v_revision_id;
  end if;

  for v_key in
    select key_data.binding_kind, key_data.lookup_key
    from (
      values
        ('exact'::public.lyrics_binding_kind, v_exact_key),
        ('work'::public.lyrics_binding_kind, v_work_key)
    ) as key_data(binding_kind, lookup_key)
    where key_data.lookup_key is not null
  loop
    v_superseded_ids := array[]::uuid[];

    if v_effective_status = 'active' then
      with superseded as (
        update public.lyrics_bindings as old_binding
        set
          status = 'superseded',
          superseded_at = v_now,
          superseded_by_binding_id = null
        where old_binding.library_id = p_library_id
          and old_binding.binding_kind = v_key.binding_kind
          and old_binding.key_version = p_key_version
          and old_binding.lookup_key = v_key.lookup_key
          and old_binding.status = 'active'
          and old_binding.document_id <> v_document_id
        returning old_binding.id
      )
      select coalesce(array_agg(superseded.id), array[]::uuid[])
      into v_superseded_ids
      from superseded;
    end if;

    insert into public.lyrics_bindings (
      library_id,
      document_id,
      binding_kind,
      key_version,
      lookup_key,
      status,
      selection_method,
      selection_version,
      match_confidence,
      raw_metadata,
      status_reason,
      superseded_at
    )
    values (
      p_library_id,
      v_document_id,
      v_key.binding_kind,
      p_key_version,
      v_key.lookup_key,
      v_effective_status,
      p_acquisition,
      v_selection_version,
      v_match_confidence,
      v_raw_metadata,
      v_status_reason,
      case when v_effective_status = 'superseded' then v_now else null end
    )
    on conflict (library_id, binding_kind, key_version, lookup_key, document_id)
    do update set
      status = case
        when excluded.status = 'quarantine'
          and lyrics_bindings.status in ('active', 'rejected', 'superseded')
          then lyrics_bindings.status
        else excluded.status
      end,
      selection_method = case
        when excluded.status = 'quarantine'
          and lyrics_bindings.status in ('active', 'rejected', 'superseded')
          then lyrics_bindings.selection_method
        else excluded.selection_method
      end,
      selection_version = case
        when excluded.status = 'quarantine'
          and lyrics_bindings.status in ('active', 'rejected', 'superseded')
          then lyrics_bindings.selection_version
        else excluded.selection_version
      end,
      match_confidence = excluded.match_confidence,
      raw_metadata = excluded.raw_metadata,
      status_reason = case
        when excluded.status = 'quarantine'
          and lyrics_bindings.status in ('active', 'rejected', 'superseded')
          then lyrics_bindings.status_reason
        else excluded.status_reason
      end,
      superseded_at = case
        when excluded.status = 'quarantine'
          and lyrics_bindings.status = 'superseded'
          then lyrics_bindings.superseded_at
        when excluded.status = 'superseded'
          then excluded.superseded_at
        else null
      end,
      superseded_by_binding_id = case
        when excluded.status = 'quarantine'
          and lyrics_bindings.status = 'superseded'
          then lyrics_bindings.superseded_by_binding_id
        else null
      end
    returning id, status, selection_version
    into v_binding_id, v_binding_status, v_binding_selection_version;

    if cardinality(v_superseded_ids) > 0 then
      update public.lyrics_bindings
      set superseded_by_binding_id = v_binding_id
      where id = any(v_superseded_ids);
    end if;

    v_bindings := v_bindings || jsonb_build_array(
      jsonb_build_object(
        'binding_id', v_binding_id,
        'match_kind', v_key.binding_kind,
        'status', v_binding_status,
        'lookup_key', v_key.lookup_key,
        'selection_version', v_binding_selection_version,
        'ignored_stale', false,
        'ignored_conflict', false
      )
    );
  end loop;

  return jsonb_build_object(
    'document_id', v_document_id,
    'revision_id', v_revision_id,
    'content_hash', v_content_hash,
    'requested_status', p_requested_status,
    'effective_status', v_effective_status,
    'selection_version', v_selection_version,
    'promotion_blocked', coalesce(
      p_requested_status = 'active'
      and p_acquisition in ('provider', 'legacy_import'),
      false
    ),
    'ignored_stale', false,
    'ignored_conflict', false,
    'bindings', v_bindings
  );
end;
$$;

comment on function public.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) is
  'Idempotent server-only shadow write. Provider/import results cannot self-promote to active.';

create function public.upsert_artwork_asset(
  p_library_id uuid,
  p_artwork_key text,
  p_key_version integer,
  p_storage_path text,
  p_sha256 text,
  p_mime_type text,
  p_bytes bigint,
  p_provider_track_id text,
  p_raw_metadata jsonb,
  p_palette jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_artwork_key text := nullif(btrim(p_artwork_key), '');
  v_storage_path text := nullif(btrim(p_storage_path), '');
  v_storage_prefix text := p_library_id::text || '/';
  v_relative_path text;
  v_sha256 text := lower(nullif(btrim(p_sha256), ''));
  v_mime_type text := lower(nullif(btrim(p_mime_type), ''));
  v_provider_track_id text := nullif(btrim(p_provider_track_id), '');
  v_raw_metadata jsonb := coalesce(p_raw_metadata, '{}'::jsonb);
  v_asset public.artwork_assets%rowtype;
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

  if v_storage_path is null or octet_length(v_storage_path) > 1024 then
    raise exception 'storage_path must contain between 1 and 1024 bytes'
      using errcode = '22023';
  end if;

  if left(v_storage_path, char_length(v_storage_prefix)) <> v_storage_prefix then
    raise exception 'storage_path must be prefixed by the library UUID'
      using errcode = '22023';
  end if;

  v_relative_path := substr(
    v_storage_path,
    char_length(v_storage_prefix) + 1
  );
  if v_relative_path is null
    or v_relative_path = ''
    or octet_length(v_relative_path) > 987
    or v_relative_path !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
    or v_relative_path ~ '(^|/)[.]{1,2}(/|$)'
    or position('//' in v_relative_path) > 0 then
    raise exception 'storage_path contains an unsafe object name'
      using errcode = '22023';
  end if;

  if v_sha256 is null or v_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'sha256 must be 64 hexadecimal characters'
      using errcode = '22023';
  end if;

  if v_mime_type is null
    or v_mime_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'mime_type must be image/jpeg, image/png, or image/webp'
      using errcode = '22023';
  end if;

  if (v_mime_type = 'image/jpeg' and lower(v_relative_path) !~ '[.]jpe?g$')
    or (v_mime_type = 'image/png' and lower(v_relative_path) !~ '[.]png$')
    or (v_mime_type = 'image/webp' and lower(v_relative_path) !~ '[.]webp$') then
    raise exception 'storage_path extension does not match mime_type'
      using errcode = '22023';
  end if;

  if p_bytes is null or p_bytes < 1 or p_bytes > 2097152 then
    raise exception 'bytes must be between 1 and 2097152'
      using errcode = '22023';
  end if;

  if v_provider_track_id is not null
    and octet_length(v_provider_track_id) > 512 then
    raise exception 'provider_track_id must not exceed 512 bytes'
      using errcode = '22023';
  end if;

  if jsonb_typeof(v_raw_metadata) <> 'object'
    or octet_length(v_raw_metadata::text) > 16384 then
    raise exception 'raw_metadata must be a JSON object no larger than 16384 bytes'
      using errcode = '22023';
  end if;

  if p_palette is not null
    and (
      jsonb_typeof(p_palette) <> 'object'
      or octet_length(p_palette::text) > 4096
    ) then
    raise exception 'palette must be a JSON object no larger than 4096 bytes'
      using errcode = '22023';
  end if;

  -- All artwork writes acquire the logical key lock before the object-path
  -- lock. This serializes idempotent updates and prevents two metadata rows
  -- from describing the same shared object path inconsistently.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'artwork-key:' || p_library_id::text || ':'
      || p_key_version::text || ':' || v_artwork_key,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'artwork-path:' || p_library_id::text || ':' || v_storage_path,
      0
    )
  );

  if exists (
    select 1
    from public.artwork_assets as existing_asset
    where existing_asset.library_id = p_library_id
      and existing_asset.storage_path = v_storage_path
      and (
        existing_asset.sha256 <> v_sha256
        or existing_asset.mime_type <> v_mime_type
        or existing_asset.byte_size <> p_bytes
      )
  ) then
    raise exception 'storage_path is already registered with different object metadata'
      using errcode = '23514';
  end if;

  insert into public.artwork_assets (
    library_id,
    artwork_key,
    key_version,
    storage_path,
    sha256,
    mime_type,
    byte_size,
    provider_track_id,
    raw_metadata,
    palette
  )
  values (
    p_library_id,
    v_artwork_key,
    p_key_version,
    v_storage_path,
    v_sha256,
    v_mime_type,
    p_bytes,
    v_provider_track_id,
    v_raw_metadata,
    p_palette
  )
  on conflict (library_id, artwork_key, key_version)
  do update set
    storage_path = excluded.storage_path,
    sha256 = excluded.sha256,
    mime_type = excluded.mime_type,
    byte_size = excluded.byte_size,
    provider_track_id = excluded.provider_track_id,
    raw_metadata = excluded.raw_metadata,
    palette = excluded.palette
  returning * into v_asset;

  return jsonb_build_object(
    'asset_id', v_asset.id,
    'bucket_id', 'lyrics-artwork',
    'artwork_key', v_asset.artwork_key,
    'key_version', v_asset.key_version,
    'storage_path', v_asset.storage_path,
    'sha256', v_asset.sha256,
    'mime_type', v_asset.mime_type,
    'bytes', v_asset.byte_size,
    'provider_track_id', v_asset.provider_track_id,
    'palette', v_asset.palette,
    'created_at', v_asset.created_at,
    'updated_at', v_asset.updated_at
  );
end;
$$;

comment on function public.upsert_artwork_asset(
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
) is
  'Register private artwork metadata after the object has been uploaded to the lyrics-artwork bucket.';

alter table public.lyrics_libraries enable row level security;
alter table public.lyrics_documents enable row level security;
alter table public.lyrics_revisions enable row level security;
alter table public.lyrics_bindings enable row level security;
alter table public.artwork_assets enable row level security;

revoke all on table public.lyrics_libraries from public, anon, authenticated, service_role;
revoke all on table public.lyrics_documents from public, anon, authenticated, service_role;
revoke all on table public.lyrics_revisions from public, anon, authenticated, service_role;
revoke all on table public.lyrics_bindings from public, anon, authenticated, service_role;
revoke all on table public.artwork_assets from public, anon, authenticated, service_role;

revoke all on function public.resolve_lyrics(uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) from public, anon, authenticated;
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
) from public, anon, authenticated;

grant usage on schema public to service_role;
grant usage on type public.lyrics_status to service_role;
grant usage on type public.lyrics_acquisition to service_role;
grant usage on type public.lyrics_binding_kind to service_role;
grant execute on function public.resolve_lyrics(uuid, text, text, integer)
  to service_role;
grant execute on function public.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) to service_role;
grant execute on function public.upsert_artwork_asset(
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
) to service_role;
