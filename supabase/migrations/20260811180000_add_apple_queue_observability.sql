-- Low-cost queue diagnostics. The function returns counters only; it never
-- exposes track metadata, lyrics, TTML, lease tokens, or worker identities.
create or replace function public.observe_apple_lyrics_queue(
  p_library_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
with jobs as (
  select
    'backfill'::text as queue,
    status,
    created_at,
    lease_expires_at
  from public.apple_lyrics_backfill_jobs
  where library_id = p_library_id
  union all
  select
    case
      when target_projection_version = 'apple-ttml-line-model-v3'
        then 'timeline-repair'
      else 'reprojection'
    end,
    status,
    created_at,
    lease_expires_at
  from public.apple_lyrics_reprojection_jobs
  where library_id = p_library_id
), grouped as (
  select
    queue,
    count(*) filter (where status in ('pending', 'retry_wait'))::integer as pending,
    count(*) filter (where status = 'processing')::integer as processing,
    count(*) filter (
      where status = 'processing'
        and lease_expires_at is not null
        and lease_expires_at <= transaction_timestamp()
    )::integer as expired_processing,
    min(created_at) filter (where status in ('pending', 'retry_wait')) as oldest_pending_at,
    min(lease_expires_at) filter (where status = 'processing') as next_lease_expiry_at
  from jobs
  group by queue
)
select coalesce(
  jsonb_object_agg(
    queue,
    jsonb_build_object(
      'pending', pending,
      'processing', processing,
      'expired_processing', expired_processing,
      'oldest_pending_at', oldest_pending_at,
      'next_lease_expiry_at', next_lease_expiry_at
    )
  ),
  '{}'::jsonb
)
from grouped;
$$;

revoke all on function public.observe_apple_lyrics_queue(uuid)
  from public, anon, authenticated;
grant execute on function public.observe_apple_lyrics_queue(uuid)
  to service_role;

comment on function public.observe_apple_lyrics_queue(uuid) is
  'Bounded operational counters for Apple lyrics queues. No user, track, lyric, TTML, lease token, or worker identity is returned.';
