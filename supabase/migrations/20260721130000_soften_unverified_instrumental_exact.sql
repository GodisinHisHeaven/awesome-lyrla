-- An LRCLIB `instrumental=true` row without title evidence is not proof that a
-- vocal recording has no lyrics. Keep the existing provider-aware writer as a
-- private implementation, then place this narrower trust gate in front of it.
-- This wrapper is rolling-deploy safe: old application revisions also lose the
-- ability to reactivate an unverified instrumental Exact during rollout.

alter function public.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) set schema private;

alter function private.upsert_lyrics_document(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) rename to upsert_lyrics_document_provider_policy_v1;

revoke all on function private.upsert_lyrics_document_provider_policy_v1(
  uuid,
  text,
  text,
  integer,
  jsonb,
  jsonb,
  jsonb,
  public.lyrics_acquisition,
  public.lyrics_status
) from public, anon, authenticated, service_role;

comment on function private.upsert_lyrics_document_provider_policy_v1(
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
  'Private provider allowlist and LRCLIB Exact promotion policy retained behind the unverified-instrumental trust gate.';

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
  v_title text := coalesce(
    coalesce(p_raw_metadata, '{}'::jsonb) ->> 'title',
    ''
  );
  v_is_instrumental boolean := lower(
    coalesce(
      coalesce(p_payload, '{}'::jsonb) ->> 'is_instrumental',
      coalesce(p_payload, '{}'::jsonb) ->> 'instrumental',
      'false'
    )
  ) = 'true';
  v_has_lyric_text boolean := nullif(
    btrim(
      coalesce(
        coalesce(p_payload, '{}'::jsonb) ->> 'synced_lyrics',
        coalesce(p_payload, '{}'::jsonb) ->> 'syncedLyrics',
        ''
      )
    ),
    ''
  ) is not null or nullif(
    btrim(
      coalesce(
        coalesce(p_payload, '{}'::jsonb) ->> 'plain_lyrics',
        coalesce(p_payload, '{}'::jsonb) ->> 'plainLyrics',
        ''
      )
    ),
    ''
  ) is not null;
  v_explicit_instrumental boolean := (
    v_title ~* '(^|[^[:alnum:]])(instrumental|karaoke)([^[:alnum:]]|$)'
    or position('纯音乐' in v_title) > 0
    or position('純音樂' in v_title) > 0
  );
  v_unverified_provider_instrumental boolean;
  v_result jsonb;
begin
  v_unverified_provider_instrumental := p_acquisition = 'provider'
    and nullif(btrim(p_exact_key), '') is not null
    and nullif(btrim(p_work_key), '') is null
    and v_is_instrumental
    and not v_has_lyric_text
    and not v_explicit_instrumental;

  if not v_unverified_provider_instrumental then
    return private.upsert_lyrics_document_provider_policy_v1(
      p_library_id,
      p_exact_key,
      p_work_key,
      p_key_version,
      p_raw_metadata,
      p_payload,
      p_provenance,
      p_acquisition,
      p_requested_status
    );
  end if;

  v_result := private.upsert_lyrics_document_quarantine_v1(
    p_library_id,
    p_exact_key,
    p_work_key,
    p_key_version,
    p_raw_metadata,
    p_payload,
    coalesce(p_provenance, '{}'::jsonb) || jsonb_build_object(
      'status_reason', 'unverified-instrumental-quarantine:v1'
    ),
    p_acquisition,
    'quarantine'::public.lyrics_status
  );

  return v_result || jsonb_build_object(
    'requested_status', p_requested_status,
    'effective_status', coalesce(v_result ->> 'effective_status', 'quarantine'),
    'promotion_blocked', true,
    'promotion_block_reason', 'unverified-instrumental'
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
  'Provider-aware server-only write. Unverified provider instrumental Exact results remain quarantined; explicit Instrumental/Karaoke/纯音乐 titles and text-bearing LRCLIB Exact results retain the existing policy.';

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
) from public, anon, authenticated, service_role;

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

-- Remove the known false positive without rejecting the key. `rejected` is a
-- human protection state and would also block a future verified Apple route.
-- This exact predicate is intentionally a fresh-database-safe no-op.
update public.lyrics_bindings as binding
set
  status = 'superseded',
  selection_version = 0,
  status_reason = 'unverified-instrumental-softened:v1',
  superseded_at = transaction_timestamp(),
  superseded_by_binding_id = null,
  updated_at = transaction_timestamp()
from public.lyrics_revisions as revision
where binding.document_id = revision.document_id
  and revision.is_current
  and binding.library_id = '00000000-0000-4000-8000-000000000001'::uuid
  and binding.binding_kind = 'exact'
  and binding.key_version = 1
  and binding.lookup_key = '单车::陈奕迅::210::2013 陈奕迅 music life 精选'
  and binding.status = 'active'
  and binding.selection_method = 'provider'
  and binding.selection_version = 0
  and lower(btrim(coalesce(revision.provider_name, ''))) = 'lrclib'
  and revision.provider_track_id = '27248323'
  and revision.is_instrumental
  and revision.synced_lyrics is null
  and revision.plain_lyrics is null;
