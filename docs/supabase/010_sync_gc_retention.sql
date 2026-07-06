-- Generic retirement RPC for partitioned sync garbage collection.
-- Migration 009 only retired snapshots/manifests. Event-tail GC also needs
-- to retire old encrypted event objects once retained partition snapshots
-- fully cover them.

create or replace function public.retire_sync_objects(
  p_primary_device_id uuid,
  p_drive_file_ids text[]
)
returns setof public.sync_objects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.devices%rowtype := public.assert_active_primary_device(p_primary_device_id);
begin
  return query
    update public.sync_objects
    set retired_at = coalesce(retired_at, now()),
        retired_by_device_id = v_primary.id
    where account_id = v_primary.account_id
      and object_kind in ('event', 'snapshot', 'partition_snapshot', 'manifest', 'thumbnail')
      and drive_file_id = any(coalesce(p_drive_file_ids, array[]::text[]))
    returning *;
end;
$$;
