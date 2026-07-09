-- Fix ambiguous PL/pgSQL column references in partition restore bundle RPC.
-- Existing projects that already applied 014 should apply this migration.

create or replace function public.get_partition_restore_bundle(
  p_device_id uuid,
  p_partition_keys text[]
)
returns table(partition_key text, snapshot_object jsonb, tail_objects jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_restore_read_device(p_device_id);
begin
  return query
    with requested as (
      select unnest(coalesce(p_partition_keys, array[]::text[])) as requested_partition_key
    ),
    latest_snapshots as (
      select distinct on (o.partition_key)
        o.partition_key as snapshot_partition_key,
        o.*
      from public.sync_objects o
      join requested r on r.requested_partition_key = o.partition_key
      where o.account_id = v_device.account_id
        and o.object_kind = 'partition_snapshot'
        and o.retired_at is null
      order by o.partition_key, o.sequence desc
    )
    select
      r.requested_partition_key as partition_key,
      case when s.id is null then null else to_jsonb(s) end as snapshot_object,
      coalesce((
        select jsonb_agg(to_jsonb(o) order by o.sequence asc)
        from public.sync_objects o
        where o.account_id = v_device.account_id
          and o.retired_at is null
          and o.sequence > coalesce(s.sequence, 0)
          and (
            o.partition_key = r.requested_partition_key
            or r.requested_partition_key = any(o.affected_partition_keys)
            or o.object_kind = 'manifest'
          )
      ), '[]'::jsonb) as tail_objects
    from requested r
    left join latest_snapshots s on s.snapshot_partition_key = r.requested_partition_key;
end;
$$;
