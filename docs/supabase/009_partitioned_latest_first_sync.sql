-- Dear Diary partitioned latest-first sync foundation.
-- Apply after 008_safe_primary_recovery.sql.

alter table public.accounts
  add column if not exists current_key_epoch integer not null default 1,
  add column if not exists partitioned_sync_enabled boolean not null default false;

alter table public.sync_objects
  add column if not exists partition_key text null,
  add column if not exists affected_partition_keys text[] not null default array[]::text[],
  add column if not exists operation_id text null,
  add column if not exists key_epoch integer not null default 1;

drop index if exists sync_objects_account_operation_idx;
create index if not exists sync_objects_account_operation_idx
  on public.sync_objects(account_id, operation_id)
  where operation_id is not null;

create index if not exists sync_objects_account_partition_sequence_idx
  on public.sync_objects(account_id, partition_key, sequence)
  where retired_at is null;

create table if not exists public.partition_heads (
  account_id uuid not null references public.accounts(id) on delete cascade,
  partition_key text not null,
  latest_snapshot_sequence bigint not null default 0,
  latest_event_sequence bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, partition_key)
);

create table if not exists public.device_partition_cursors (
  account_id uuid not null references public.accounts(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  partition_key text not null,
  last_applied_sequence bigint not null default 0,
  hydrated_at timestamptz null,
  updated_at timestamptz not null default now(),
  primary key (account_id, device_id, partition_key)
);

create table if not exists public.sync_operations (
  account_id uuid not null references public.accounts(id) on delete cascade,
  operation_id text not null,
  created_by_device_id uuid not null references public.devices(id),
  created_at timestamptz not null default now(),
  primary key (account_id, operation_id)
);

alter table public.partition_heads enable row level security;
alter table public.device_partition_cursors enable row level security;
alter table public.sync_operations enable row level security;

drop policy if exists partition_heads_select_own on public.partition_heads;
create policy partition_heads_select_own
  on public.partition_heads
  for select
  using (account_id = public.current_account_id());

drop policy if exists partition_cursors_select_own on public.device_partition_cursors;
create policy partition_cursors_select_own
  on public.device_partition_cursors
  for select
  using (account_id = public.current_account_id());

drop policy if exists sync_operations_select_own on public.sync_operations;
create policy sync_operations_select_own
  on public.sync_operations
  for select
  using (account_id = public.current_account_id());

create or replace function public.upsert_partition_head(
  p_account_id uuid,
  p_partition_key text,
  p_object_kind text,
  p_sequence bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(p_partition_key, '') is null then
    return;
  end if;

  insert into public.partition_heads (
    account_id,
    partition_key,
    latest_snapshot_sequence,
    latest_event_sequence,
    updated_at
  )
  values (
    p_account_id,
    p_partition_key,
    case when p_object_kind in ('partition_snapshot', 'snapshot') then p_sequence else 0 end,
    case when p_object_kind = 'event' then p_sequence else 0 end,
    now()
  )
  on conflict (account_id, partition_key)
  do update set
    latest_snapshot_sequence = greatest(
      public.partition_heads.latest_snapshot_sequence,
      case when p_object_kind in ('partition_snapshot', 'snapshot') then p_sequence else public.partition_heads.latest_snapshot_sequence end
    ),
    latest_event_sequence = greatest(
      public.partition_heads.latest_event_sequence,
      case when p_object_kind = 'event' then p_sequence else public.partition_heads.latest_event_sequence end
    ),
    updated_at = now();
end;
$$;

drop function if exists public.commit_sync_object(uuid, bigint, text, text, text, bigint, text, text, bigint, jsonb);

create or replace function public.commit_sync_object(
  p_device_id uuid,
  p_after_sequence bigint,
  p_drive_file_id text,
  p_object_kind text,
  p_sha256 text,
  p_size_bytes bigint,
  p_record_type text default null,
  p_record_id text default null,
  p_base_record_version bigint default null,
  p_affected_records jsonb default '[]'::jsonb,
  p_partition_key text default null,
  p_affected_partition_keys text[] default array[]::text[],
  p_operation_id text default null,
  p_key_epoch integer default 1
)
returns public.sync_objects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
  v_account public.accounts%rowtype;
  v_existing public.sync_objects%rowtype;
  v_object public.sync_objects%rowtype;
  v_next_sequence bigint;
  v_current_record_version bigint;
  v_next_record_version bigint;
  v_affected jsonb;
  v_affected_type text;
  v_affected_id text;
  v_affected_base bigint;
  v_affected_version bigint;
begin
  select * into v_account from public.accounts
  where id = v_device.account_id for update;

  if p_operation_id is not null then
    select * into v_existing
    from public.sync_objects
    where account_id = v_account.id
      and operation_id = p_operation_id
    order by sequence asc
    limit 1;
    if found then
      return v_existing;
    end if;
    insert into public.sync_operations (account_id, operation_id, created_by_device_id)
    values (v_account.id, p_operation_id, v_device.id)
    on conflict (account_id, operation_id) do nothing;
  end if;

  if p_after_sequence is not null and p_after_sequence > v_account.current_sync_sequence then
    raise exception 'future_sync_sequence';
  end if;

  if p_object_kind not in ('event', 'media', 'snapshot', 'key_package', 'manifest', 'partition_snapshot', 'thumbnail') then
    raise exception 'unsupported_sync_object_kind';
  end if;
  if jsonb_typeof(coalesce(p_affected_records, '[]'::jsonb)) <> 'array' then
    raise exception 'invalid_affected_records';
  end if;

  if p_object_kind = 'event' then
    if p_record_type not in ('diary', 'entry', 'note', 'settings', 'profile')
       or nullif(p_record_id, '') is null
       or p_base_record_version is null
       or p_base_record_version < 0 then
      raise exception 'invalid_event_record_metadata';
    end if;
    if (p_record_type = 'settings' and p_record_id <> 'settings')
       or (p_record_type = 'profile' and p_record_id <> 'profile') then
      raise exception 'invalid_singleton_record_id';
    end if;

    select version into v_current_record_version from public.record_versions
    where account_id = v_account.id and record_type = p_record_type and record_id = p_record_id
    for update;
    v_current_record_version := coalesce(v_current_record_version, 0);
    if p_base_record_version <> v_current_record_version then raise exception 'stale_record_version'; end if;
    v_next_record_version := v_current_record_version + 1;
    insert into public.record_versions (account_id, record_type, record_id, version)
    values (v_account.id, p_record_type, p_record_id, v_next_record_version)
    on conflict (account_id, record_type, record_id)
    do update set version = excluded.version, updated_at = now();

    for v_affected in select value from jsonb_array_elements(coalesce(p_affected_records, '[]'::jsonb)) loop
      v_affected_type := v_affected ->> 'record_type';
      v_affected_id := v_affected ->> 'record_id';
      v_affected_base := (v_affected ->> 'base_record_version')::bigint;
      v_affected_version := (v_affected ->> 'record_version')::bigint;
      if v_affected_type not in ('diary', 'entry', 'note')
         or nullif(v_affected_id, '') is null
         or v_affected_version <> v_affected_base + 1
         or (v_affected_type = p_record_type and v_affected_id = p_record_id) then
        raise exception 'invalid_affected_record';
      end if;
      select version into v_current_record_version from public.record_versions
      where account_id = v_account.id and record_type = v_affected_type and record_id = v_affected_id
      for update;
      v_current_record_version := coalesce(v_current_record_version, 0);
      if v_affected_base <> v_current_record_version then raise exception 'stale_record_version'; end if;
      insert into public.record_versions (account_id, record_type, record_id, version)
      values (v_account.id, v_affected_type, v_affected_id, v_affected_version)
      on conflict (account_id, record_type, record_id)
      do update set version = excluded.version, updated_at = now();
    end loop;
  else
    p_record_type := null;
    p_record_id := null;
    p_base_record_version := null;
    p_affected_records := '[]'::jsonb;
    v_next_record_version := null;
  end if;

  v_next_sequence := v_account.current_sync_sequence + 1;

  insert into public.sync_objects (
    account_id, sequence, drive_file_id, object_kind, sha256, size_bytes,
    created_by_device_id, record_type, record_id, base_record_version, record_version,
    affected_records, partition_key, affected_partition_keys, operation_id, key_epoch
  ) values (
    v_account.id, v_next_sequence, p_drive_file_id, p_object_kind, p_sha256, p_size_bytes,
    v_device.id, p_record_type, p_record_id, p_base_record_version, v_next_record_version,
    coalesce(p_affected_records, '[]'::jsonb), p_partition_key, coalesce(p_affected_partition_keys, array[]::text[]),
    p_operation_id, coalesce(p_key_epoch, v_account.current_key_epoch)
  ) returning * into v_object;

  update public.accounts
  set current_sync_sequence = v_next_sequence,
      current_snapshot_sequence = case when p_object_kind in ('snapshot', 'partition_snapshot') then v_next_sequence else current_snapshot_sequence end,
      partitioned_sync_enabled = case when p_object_kind = 'manifest' then true else partitioned_sync_enabled end
  where id = v_account.id;

  perform public.upsert_partition_head(v_account.id, p_partition_key, p_object_kind, v_next_sequence);
  return v_object;
end;
$$;

create or replace function public.commit_sync_batch(
  p_device_id uuid,
  p_operation_id text,
  p_objects jsonb,
  p_record_type text default null,
  p_record_id text default null,
  p_base_record_version bigint default null,
  p_affected_records jsonb default '[]'::jsonb,
  p_partition_key text default null,
  p_affected_partition_keys text[] default array[]::text[],
  p_key_epoch integer default 1
)
returns setof public.sync_objects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
  v_account public.accounts%rowtype;
  v_existing_count integer;
  v_object jsonb;
  v_kind text;
  v_committed public.sync_objects%rowtype;
  v_after bigint;
  v_event_seen boolean := false;
begin
  if nullif(p_operation_id, '') is null then raise exception 'operation_id_required'; end if;
  if jsonb_typeof(coalesce(p_objects, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_objects, '[]'::jsonb)) = 0 then
    raise exception 'batch_objects_required';
  end if;

  select * into v_account from public.accounts
  where id = v_device.account_id for update;

  select count(*) into v_existing_count
  from public.sync_objects
  where account_id = v_account.id and operation_id = p_operation_id;
  if v_existing_count > 0 then
    return query
      select * from public.sync_objects
      where account_id = v_account.id and operation_id = p_operation_id
      order by sequence asc;
    return;
  end if;

  insert into public.sync_operations (account_id, operation_id, created_by_device_id)
  values (v_account.id, p_operation_id, v_device.id);

  v_after := v_account.current_sync_sequence;
  for v_object in select value from jsonb_array_elements(p_objects) loop
    v_kind := v_object ->> 'object_kind';
    v_committed := public.commit_sync_object(
      p_device_id,
      v_after,
      v_object ->> 'drive_file_id',
      v_kind,
      v_object ->> 'sha256',
      (v_object ->> 'size_bytes')::bigint,
      case when v_kind = 'event' and not v_event_seen then p_record_type else null end,
      case when v_kind = 'event' and not v_event_seen then p_record_id else null end,
      case when v_kind = 'event' and not v_event_seen then p_base_record_version else null end,
      case when v_kind = 'event' and not v_event_seen then p_affected_records else '[]'::jsonb end,
      coalesce(v_object ->> 'partition_key', p_partition_key),
      p_affected_partition_keys,
      null,
      p_key_epoch
    );
    update public.sync_objects
    set operation_id = p_operation_id
    where id = v_committed.id
    returning * into v_committed;
    if v_kind = 'event' then v_event_seen := true; end if;
    v_after := v_committed.sequence;
  end loop;

  return query
    select * from public.sync_objects
    where account_id = v_account.id and operation_id = p_operation_id
    order by sequence asc;
end;
$$;

create or replace function public.list_partition_objects_after(
  p_device_id uuid,
  p_partition_key text,
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
      and retired_at is null
      and sequence > p_after_sequence
      and (
        partition_key = p_partition_key
        or p_partition_key = any(affected_partition_keys)
        or object_kind = 'manifest'
      )
    order by sequence asc
    limit least(greatest(p_limit, 1), 500);
end;
$$;

create or replace function public.update_partition_cursor(
  p_device_id uuid,
  p_partition_key text,
  p_last_applied_sequence bigint,
  p_hydrated_at timestamptz default null
)
returns public.device_partition_cursors
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
  v_cursor public.device_partition_cursors%rowtype;
begin
  insert into public.device_partition_cursors (
    account_id, device_id, partition_key, last_applied_sequence, hydrated_at, updated_at
  )
  values (
    v_device.account_id, v_device.id, p_partition_key, p_last_applied_sequence, p_hydrated_at, now()
  )
  on conflict (account_id, device_id, partition_key)
  do update set
    last_applied_sequence = excluded.last_applied_sequence,
    hydrated_at = coalesce(excluded.hydrated_at, public.device_partition_cursors.hydrated_at),
    updated_at = now()
  returning * into v_cursor;

  return v_cursor;
end;
$$;

create or replace function public.list_partition_heads(p_device_id uuid)
returns setof public.partition_heads
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
begin
  return query
    select * from public.partition_heads
    where account_id = v_device.account_id
    order by partition_key asc;
end;
$$;

create or replace function public.get_latest_restore_manifest(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
  v_account public.accounts%rowtype;
  v_manifest public.sync_objects%rowtype;
  v_core public.sync_objects%rowtype;
begin
  select * into v_account from public.accounts where id = v_device.account_id;

  select * into v_manifest
  from public.sync_objects
  where account_id = v_device.account_id
    and object_kind = 'manifest'
    and retired_at is null
  order by sequence desc
  limit 1;

  select * into v_core
  from public.sync_objects
  where account_id = v_device.account_id
    and object_kind = 'partition_snapshot'
    and partition_key = 'core'
    and retired_at is null
  order by sequence desc
  limit 1;

  return jsonb_build_object(
    'manifest_object', case when v_manifest.id is null then null else to_jsonb(v_manifest) end,
    'core_snapshot_object', case when v_core.id is null then null else to_jsonb(v_core) end,
    'current_sync_sequence', v_account.current_sync_sequence,
    'key_epoch', v_account.current_key_epoch
  );
end;
$$;

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
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
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

create or replace function public.rotate_account_key_epoch(
  p_primary_device_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.devices%rowtype := public.assert_active_primary_device(p_primary_device_id);
  v_epoch integer;
begin
  update public.accounts
  set current_key_epoch = current_key_epoch + 1
  where id = v_primary.account_id
  returning current_key_epoch into v_epoch;
  return v_epoch;
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
      and object_kind in ('snapshot', 'partition_snapshot', 'manifest')
      and drive_file_id = any(coalesce(p_drive_file_ids, array[]::text[]))
    returning *;
end;
$$;
