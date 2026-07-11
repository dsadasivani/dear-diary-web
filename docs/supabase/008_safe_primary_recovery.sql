-- Allow recovery material to be verified before replacing an active primary.
-- Apply after 007_sync_object_maintenance.sql.

create or replace function public.list_account_recovery_objects()
returns setof public.sync_objects
language sql
stable
security definer
set search_path = public
as $$
  select o.*
  from public.sync_objects o
  join public.accounts a on a.id = o.account_id
  where a.supabase_user_id = public.require_supabase_user_id()
    and o.object_kind in ('key_package', 'snapshot')
    and o.retired_at is null
  order by o.sequence asc
$$;
