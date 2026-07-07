-- Allow encrypted media objects to be retired by sync maintenance once no current
-- diary, entry, note, or profile reference needs them.
-- Apply after 012_sync_object_kind_constraint.sql.

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
      and object_kind in ('event', 'snapshot', 'partition_snapshot', 'manifest', 'media', 'thumbnail')
      and drive_file_id = any(coalesce(p_drive_file_ids, array[]::text[]))
    returning *;
end;
$$;
