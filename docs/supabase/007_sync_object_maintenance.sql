-- Dear Diary snapshot retention and Drive object maintenance metadata.
-- Apply after 006_key_package_retirement.sql.

create or replace function public.list_sync_objects_for_maintenance(
  p_primary_device_id uuid,
  p_after_sequence bigint default 0,
  p_limit integer default 500
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
    select * from public.sync_objects
    where account_id = v_primary.account_id
      and sequence > p_after_sequence
    order by sequence asc
    limit least(greatest(p_limit, 1), 500);
end;
$$;

create or replace function public.retire_snapshots(
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
      and object_kind = 'snapshot'
      and drive_file_id = any(coalesce(p_drive_file_ids, array[]::text[]))
    returning *;
end;
$$;
