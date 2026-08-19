-- Keep the original, deliberately quarantine-only writer as a private helper.
-- The public wrapper below owns the trust policy without duplicating the
-- document/revision write implementation.
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
) rename to upsert_lyrics_document_quarantine_v1;

revoke all on function private.upsert_lyrics_document_quarantine_v1(
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

comment on function private.upsert_lyrics_document_quarantine_v1(
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
  'Private v1 document/revision writer retained as the quarantine-safe implementation behind the public exact-trust policy.';

-- Reserve selection_version 0 for the automatic provider Exact tier. Human
-- selections remain strictly newer (> 0), and an automatic provider can
-- never make a Work binding active even if the RPC input is malformed.
alter table public.lyrics_bindings
  add constraint lyrics_bindings_active_trust_tier
  check (
    status <> 'active'
    or (
      selection_method = 'provider'
      and binding_kind = 'exact'
      and selection_version = 0
    )
    or (
      selection_method in ('manual', 'candidate')
      and selection_version > 0
    )
  );

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
  v_exact_key text := nullif(btrim(p_exact_key), '');
  v_work_key text := nullif(btrim(p_work_key), '');
  v_input_selection_version bigint := nullif(
    coalesce(
      coalesce(p_provenance, '{}'::jsonb) ->> 'selection_version',
      coalesce(p_provenance, '{}'::jsonb) ->> 'selectionVersion'
    ),
    ''
  )::bigint;
  v_requested_status public.lyrics_status := coalesce(
    p_requested_status,
    'quarantine'::public.lyrics_status
  );
  v_auto_exact boolean := false;
  v_result jsonb;
  v_document_id uuid;
  v_binding_id uuid;
  v_binding_status public.lyrics_status;
  v_binding_method public.lyrics_acquisition;
  v_binding_selection_version bigint;
  v_has_protected_binding boolean := false;
  v_promoted boolean := false;
  v_block_reason text;
  v_bindings jsonb;
begin
  if p_acquisition in ('manual', 'candidate')
    and v_requested_status = 'active'
    and coalesce(v_input_selection_version, 0) <= 0 then
    raise exception 'active manual/candidate writes require a positive selection_version'
      using errcode = '22023';
  end if;

  -- Only an automatic provider write for an exact key, with no work alias in
  -- the same request, enters the automatic trust tier. Treat both the old
  -- client's quarantine request and the new client's active request alike so
  -- a rolling deploy cannot leave exact rows stranded in quarantine.
  v_auto_exact := p_acquisition = 'provider'
    and v_exact_key is not null
    and v_work_key is null
    and v_requested_status in ('quarantine', 'active');

  v_result := private.upsert_lyrics_document_quarantine_v1(
    p_library_id,
    p_exact_key,
    p_work_key,
    p_key_version,
    p_raw_metadata,
    p_payload,
    p_provenance,
    p_acquisition,
    case
      when v_auto_exact then 'quarantine'::public.lyrics_status
      else p_requested_status
    end
  );

  if not v_auto_exact then
    return v_result;
  end if;

  v_document_id := nullif(v_result ->> 'document_id', '')::uuid;
  if v_document_id is null then
    return v_result || jsonb_build_object(
      'effective_status', 'quarantine',
      'promotion_blocked', true,
      'promotion_block_reason', 'document-write-not-applied'
    );
  end if;

  select
    binding.id,
    binding.status,
    binding.selection_method,
    binding.selection_version
  into
    v_binding_id,
    v_binding_status,
    v_binding_method,
    v_binding_selection_version
  from public.lyrics_bindings as binding
  where binding.library_id = p_library_id
    and binding.document_id = v_document_id
    and binding.binding_kind = 'exact'
    and binding.key_version = p_key_version
    and binding.lookup_key = v_exact_key
  for update;

  if not found then
    v_block_reason := 'exact-binding-not-written';
  elsif v_binding_status = 'active'
    and v_binding_method = 'provider'
    and v_binding_selection_version = 0 then
    -- The private helper deliberately writes as quarantine. Its conflict
    -- policy preserves an existing active provider binding while still
    -- allowing a same-document provider revision to refresh.
    v_promoted := true;
  elsif v_binding_status not in ('quarantine', 'superseded')
    or v_binding_method <> 'provider'
    or (
      v_binding_selection_version is not null
      and v_binding_selection_version <> 0
    ) then
    -- Never resurrect a rejected binding or overwrite a binding that has
    -- acquired a manual/candidate trust identity. A provider v0 superseded by
    -- another provider remains eligible below when no protected row exists.
    v_block_reason := 'binding-state-protected';
  else
    select exists (
      select 1
      from public.lyrics_bindings as other_binding
      where other_binding.library_id = p_library_id
        and other_binding.binding_kind = 'exact'
        and other_binding.key_version = p_key_version
        and other_binding.lookup_key = v_exact_key
        and other_binding.id <> v_binding_id
        and (
          (
            other_binding.status = 'active'
            and other_binding.selection_method <> 'provider'
          )
          or other_binding.status = 'rejected'
        )
    )
    into v_has_protected_binding;

    if v_has_protected_binding then
      v_block_reason := 'exact-key-has-protected-binding';
    else
      -- A newer exact result from a different automatic provider document is
      -- allowed to replace the previous automatic result. The private helper
      -- still holds the per-key advisory transaction lock here, so the
      -- supersede-and-promote sequence cannot race another writer.
      update public.lyrics_bindings as old_binding
      set
        status = 'superseded',
        superseded_at = transaction_timestamp(),
        superseded_by_binding_id = v_binding_id,
        updated_at = transaction_timestamp(),
        status_reason = 'automatic-provider-exact-replaced:v1'
      where old_binding.library_id = p_library_id
        and old_binding.binding_kind = 'exact'
        and old_binding.key_version = p_key_version
        and old_binding.lookup_key = v_exact_key
        and old_binding.id <> v_binding_id
        and old_binding.status = 'active'
        and old_binding.selection_method = 'provider'
        and old_binding.selection_version = 0;

      update public.lyrics_bindings as binding
      set
        status = 'active',
        selection_version = 0,
        status_reason = 'automatic-provider-exact-active:v1',
        updated_at = transaction_timestamp(),
        superseded_at = null,
        superseded_by_binding_id = null
      where binding.id = v_binding_id
        and binding.status in ('quarantine', 'superseded')
        and binding.selection_method = 'provider'
        and (
          binding.selection_version is null
          or binding.selection_version = 0
        )
        and not exists (
          select 1
          from public.lyrics_bindings as concurrent_binding
          where concurrent_binding.library_id = binding.library_id
            and concurrent_binding.binding_kind = binding.binding_kind
            and concurrent_binding.key_version = binding.key_version
            and concurrent_binding.lookup_key = binding.lookup_key
            and concurrent_binding.id <> binding.id
            and concurrent_binding.status = 'active'
        )
      returning
        binding.status,
        binding.selection_version
      into
        v_binding_status,
        v_binding_selection_version;

      if found then
        v_promoted := true;
      else
        raise exception 'automatic exact promotion lost its protected key lock'
          using errcode = '40001';
      end if;
    end if;
  end if;

  if v_promoted then
    select coalesce(
      jsonb_agg(
        case
          when item ->> 'binding_id' = v_binding_id::text then
            item || jsonb_build_object(
              'status', 'active',
              'selection_version', 0
            )
          else item
        end
      ),
      '[]'::jsonb
    )
    into v_bindings
    from jsonb_array_elements(coalesce(v_result -> 'bindings', '[]'::jsonb)) as item;

    return v_result || jsonb_build_object(
      'requested_status', p_requested_status,
      'effective_status', 'active',
      'selection_version', 0,
      'promotion_blocked', false,
      'promotion_block_reason', null,
      'bindings', v_bindings
    );
  end if;

  return v_result || jsonb_build_object(
    'requested_status', p_requested_status,
    'effective_status', coalesce(v_binding_status::text, 'quarantine'),
    'selection_version', v_binding_selection_version,
    'promotion_blocked', true,
    'promotion_block_reason', v_block_reason
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
  'Idempotent server-only write. Automatic provider exact-only results use active selection_version 0 and may replace prior provider v0 results; automatic Work remains quarantined; manual/candidate active selections and explicit rejection keep priority.';

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

-- Backfill only truly unambiguous automatic exact bindings. Requiring the
-- binding to be the sole identity ever recorded for its exact key avoids
-- reviving rejected/superseded history or displacing a manual/candidate row.
with eligible_exact as (
  select binding.id
  from public.lyrics_bindings as binding
  join public.lyrics_documents as document
    on document.library_id = binding.library_id
    and document.id = binding.document_id
  where binding.binding_kind = 'exact'
    and binding.status = 'quarantine'
    and binding.selection_method = 'provider'
    and binding.selection_version is null
    and document.initial_acquisition = 'provider'
    and exists (
      select 1
      from public.lyrics_revisions as revision
      where revision.document_id = binding.document_id
        and revision.is_current
        and revision.provider_name is not null
    )
    and not exists (
      select 1
      from public.lyrics_bindings as other_binding
      where other_binding.library_id = binding.library_id
        and other_binding.binding_kind = binding.binding_kind
        and other_binding.key_version = binding.key_version
        and other_binding.lookup_key = binding.lookup_key
        and other_binding.id <> binding.id
    )
)
update public.lyrics_bindings as binding
set
  status = 'active',
  selection_version = 0,
  status_reason = 'automatic-provider-exact-active:v1-backfill',
  updated_at = transaction_timestamp(),
  superseded_at = null,
  superseded_by_binding_id = null
from eligible_exact
where binding.id = eligible_exact.id
  and binding.status = 'quarantine'
  and binding.selection_method = 'provider'
  and binding.selection_version is null;

comment on table public.lyrics_bindings is
  'Versioned exact/work lookup aliases. Unambiguous automatic provider Exact bindings may be active at selection_version 0; Work remains quarantined unless explicitly curated by a future policy.';
