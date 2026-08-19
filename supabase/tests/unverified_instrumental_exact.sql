\set ON_ERROR_STOP on

begin;

do $test$
declare
  v_library_id uuid := '00000000-0000-4000-8000-000000000001'::uuid;
  v_result jsonb;
  v_document_id uuid;
  v_status public.lyrics_status;
  v_selection_version bigint;
begin
  v_result := public.upsert_lyrics_document(
    v_library_id,
    'policy ordinary vocal::fixture artist::180::fixture album',
    null,
    1,
    '{"title":"Ordinary Vocal","artist":"Fixture Artist","album":"Fixture Album","duration_ms":180000}'::jsonb,
    '{"is_instrumental":true,"duration_ms":180000}'::jsonb,
    '{"provider_name":"lrclib","provider_track_id":"soft-instrumental"}'::jsonb,
    'provider',
    'active'
  );
  v_document_id := (v_result ->> 'document_id')::uuid;

  select binding.status, binding.selection_version
  into v_status, v_selection_version
  from public.lyrics_bindings as binding
  where binding.library_id = v_library_id
    and binding.document_id = v_document_id
    and binding.binding_kind = 'exact';

  if v_status <> 'quarantine'
    or v_selection_version is not null
    or v_result ->> 'promotion_block_reason' <> 'unverified-instrumental' then
    raise exception 'unverified provider instrumental escaped quarantine';
  end if;

  update public.lyrics_bindings as binding
  set
    status = 'superseded',
    selection_version = 0,
    status_reason = 'fixture-softened',
    superseded_at = transaction_timestamp()
  where binding.document_id = v_document_id;

  perform public.upsert_lyrics_document(
    v_library_id,
    'policy ordinary vocal::fixture artist::180::fixture album',
    null,
    1,
    '{"title":"Ordinary Vocal","artist":"Fixture Artist","album":"Fixture Album","duration_ms":180000}'::jsonb,
    '{"is_instrumental":true,"duration_ms":180000}'::jsonb,
    '{"provider_name":"lrclib","provider_track_id":"soft-instrumental"}'::jsonb,
    'provider',
    'active'
  );

  select binding.status
  into v_status
  from public.lyrics_bindings as binding
  where binding.document_id = v_document_id
    and binding.binding_kind = 'exact';
  if v_status <> 'superseded' then
    raise exception 'superseded unverified instrumental was reactivated';
  end if;

  v_result := public.upsert_lyrics_document(
    v_library_id,
    'policy instrumental::fixture artist::180::fixture album::v=instrumental',
    null,
    1,
    '{"title":"Policy (Instrumental)","artist":"Fixture Artist","album":"Fixture Album","duration_ms":180000}'::jsonb,
    '{"is_instrumental":true,"duration_ms":180000}'::jsonb,
    '{"provider_name":"lrclib","provider_track_id":"verified-instrumental"}'::jsonb,
    'provider',
    'active'
  );
  if v_result ->> 'effective_status' <> 'active' then
    raise exception 'explicit instrumental did not retain automatic Exact policy';
  end if;

  v_result := public.upsert_lyrics_document(
    v_library_id,
    'policy vocal text::fixture artist::180::fixture album',
    null,
    1,
    '{"title":"Policy Vocal Text","artist":"Fixture Artist","album":"Fixture Album","duration_ms":180000}'::jsonb,
    '{"synced_lyrics":"[00:01.000]Fixture text","plain_lyrics":"Fixture text","is_instrumental":false,"duration_ms":180000}'::jsonb,
    '{"provider_name":"lrclib","provider_track_id":"text-bearing"}'::jsonb,
    'provider',
    'active'
  );
  if v_result ->> 'effective_status' <> 'active' then
    raise exception 'text-bearing LRCLIB Exact no longer promotes';
  end if;
end;
$test$;

rollback;
