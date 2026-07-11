-- Dear Diary recovery key-package retirement.
-- Apply after 005_device_management.sql.

alter table public.sync_objects
  add column if not exists retired_at timestamptz null,
  add column if not exists retired_by_device_id uuid null references public.devices(id);

create or replace function public.list_sync_objects_after(
  p_device_id uuid,
  p_after_sequence bigint,
  p_limit integer default 100
)
returns setof public.sync_objects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
begin
  return query
    select * from public.sync_objects
    where account_id = v_device.account_id
      and sequence > p_after_sequence
      and retired_at is null
    order by sequence asc
    limit least(greatest(p_limit, 1), 500);
end;
$$;

create or replace function public.retire_key_packages(
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
      and object_kind = 'key_package'
      and drive_file_id = any(coalesce(p_drive_file_ids, array[]::text[]))
    returning *;
end;
$$;
