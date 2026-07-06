-- Dear Diary linked-device management.
-- Apply after 004_atomic_cascade_events.sql.

create or replace function public.list_account_devices(p_requesting_device_id uuid)
returns setof public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_active_device(p_requesting_device_id);
begin
  return query
    select * from public.devices
    where account_id = v_device.account_id
    order by revoked_at nulls first, created_at desc;
end;
$$;
