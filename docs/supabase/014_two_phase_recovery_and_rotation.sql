-- Two-phase primary recovery and device key rotation.
-- Apply after 013_sync_media_gc.sql.

alter table public.devices
  add column if not exists activation_state text not null default 'active';

alter table public.devices
  drop constraint if exists devices_activation_state_check;

alter table public.devices
  add constraint devices_activation_state_check
  check (activation_state in ('active', 'pending_recovery', 'aborted'));

create table if not exists public.primary_recovery_attempts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  previous_primary_device_id uuid null references public.devices(id),
  google_user_id text not null,
  google_email text not null,
  display_name text not null,
  platform text not null,
  status text not null default 'pending' check (status in ('pending', 'finalized', 'aborted')),
  started_at timestamptz not null default now(),
  finalized_at timestamptz null,
  restored_sequence bigint null check (restored_sequence is null or restored_sequence >= 0)
);

create table if not exists public.key_epoch_rotations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  primary_device_id uuid not null references public.devices(id),
  revoked_device_id uuid not null references public.devices(id),
  reason text not null,
  next_key_epoch integer not null check (next_key_epoch > 1),
  starting_sequence bigint not null check (starting_sequence >= 0),
  key_package_sequence bigint null check (key_package_sequence is null or key_package_sequence >= 0),
  status text not null default 'pending' check (status in ('pending', 'finalized', 'aborted')),
  created_at timestamptz not null default now(),
  finalized_at timestamptz null
);

create unique index if not exists key_epoch_rotations_one_pending_per_account
  on public.key_epoch_rotations(account_id)
  where status = 'pending';

create unique index if not exists primary_recovery_attempts_one_pending_per_account
  on public.primary_recovery_attempts(account_id)
  where status = 'pending';

alter table public.primary_recovery_attempts enable row level security;
alter table public.key_epoch_rotations enable row level security;

drop policy if exists primary_recovery_attempts_select_own on public.primary_recovery_attempts;
create policy primary_recovery_attempts_select_own
  on public.primary_recovery_attempts
  for select
  using (account_id = public.current_account_id());

drop policy if exists key_epoch_rotations_select_own on public.key_epoch_rotations;
create policy key_epoch_rotations_select_own
  on public.key_epoch_rotations
  for select
  using (account_id = public.current_account_id());

create or replace function public.assert_active_device(p_device_id uuid)
returns public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_user_id uuid := public.require_supabase_user_id();
  v_device public.devices%rowtype;
begin
  select d.*
  into v_device
  from public.devices d
  join public.accounts a on a.id = d.account_id
  where d.id = p_device_id
    and a.supabase_user_id = v_supabase_user_id;

  if not found then raise exception 'device_not_found'; end if;
  if v_device.revoked_at is not null then raise exception 'device_revoked'; end if;
  if v_device.activation_state <> 'active' then raise exception 'device_not_active'; end if;

  update public.devices set last_seen_at = now() where id = p_device_id;
  return v_device;
end;
$$;

create or replace function public.assert_restore_read_device(p_device_id uuid)
returns public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_user_id uuid := public.require_supabase_user_id();
  v_device public.devices%rowtype;
begin
  select d.*
  into v_device
  from public.devices d
  join public.accounts a on a.id = d.account_id
  where d.id = p_device_id
    and a.supabase_user_id = v_supabase_user_id;

  if not found then raise exception 'device_not_found'; end if;
  if v_device.revoked_at is not null then raise exception 'device_revoked'; end if;
  if v_device.activation_state not in ('active', 'pending_recovery') then raise exception 'device_not_active'; end if;

  update public.devices set last_seen_at = now() where id = p_device_id;
  return v_device;
end;
$$;

create or replace function public.begin_primary_mobile_recovery(
  p_google_user_id text,
  p_google_email text,
  p_display_name text,
  p_platform text,
  p_public_key text,
  p_recovery_configured boolean,
  p_previous_primary_device_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_user_id uuid := public.require_supabase_user_id();
  v_account public.accounts%rowtype;
  v_device public.devices%rowtype;
  v_attempt public.primary_recovery_attempts%rowtype;
begin
  if coalesce(length(trim(p_google_user_id)), 0) = 0 then raise exception 'google_user_id_required'; end if;
  if coalesce(length(trim(p_public_key)), 0) = 0 then raise exception 'device_public_key_required'; end if;
  if p_recovery_configured is not true then raise exception 'recovery_passphrase_required'; end if;

  select * into v_account
  from public.accounts
  where supabase_user_id = v_supabase_user_id
  for update;
  if not found then raise exception 'account_not_found'; end if;
  if p_previous_primary_device_id is not null and v_account.active_primary_device_id <> p_previous_primary_device_id then
    raise exception 'primary_device_changed';
  end if;

  insert into public.devices (account_id, role, public_key, display_name, platform, activation_state)
  values (v_account.id, 'primary_mobile', p_public_key, p_display_name, p_platform, 'pending_recovery')
  returning * into v_device;

  insert into public.device_cursors (account_id, device_id, last_applied_sequence)
  values (v_account.id, v_device.id, 0);

  insert into public.primary_recovery_attempts (
    account_id, device_id, previous_primary_device_id, google_user_id, google_email, display_name, platform
  ) values (
    v_account.id, v_device.id, v_account.active_primary_device_id, p_google_user_id,
    coalesce(nullif(p_google_email, ''), v_account.google_email), p_display_name, p_platform
  ) returning * into v_attempt;

  return jsonb_build_object('account', to_jsonb(v_account), 'device', to_jsonb(v_device), 'attempt', to_jsonb(v_attempt));
end;
$$;

create or replace function public.finalize_primary_mobile_recovery(
  p_recovery_attempt_id uuid,
  p_device_id uuid,
  p_restored_sequence bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_restore_read_device(p_device_id);
  v_attempt public.primary_recovery_attempts%rowtype;
  v_account public.accounts%rowtype;
  v_revoked jsonb := '[]'::jsonb;
begin
  select * into v_attempt
  from public.primary_recovery_attempts
  where id = p_recovery_attempt_id
    and device_id = v_device.id
    and account_id = v_device.account_id
  for update;
  if not found then raise exception 'recovery_attempt_not_found'; end if;
  if v_attempt.status <> 'pending' then raise exception 'recovery_attempt_not_pending'; end if;

  select * into v_account
  from public.accounts
  where id = v_device.account_id
  for update;

  if p_restored_sequence <> v_account.current_sync_sequence then
    raise exception 'stale_recovery_sequence';
  end if;

  with revoked as (
    update public.devices
    set revoked_at = now(),
        replaced_by_device_id = v_device.id
    where account_id = v_account.id
      and id <> v_device.id
      and revoked_at is null
    returning *
  ), recorded as (
    insert into public.device_revocations (account_id, device_id, reason)
    select account_id, id, 'primary_mobile_recovery'
    from revoked
    returning 1
  )
  select coalesce(jsonb_agg(to_jsonb(revoked)), '[]'::jsonb)
  into v_revoked
  from revoked;

  update public.devices
  set activation_state = 'active',
      last_seen_at = now()
  where id = v_device.id
  returning * into v_device;

  update public.accounts
  set active_primary_device_id = v_device.id,
      google_user_id = v_attempt.google_user_id,
      google_email = v_attempt.google_email,
      recovery_configured = true
  where id = v_account.id
  returning * into v_account;

  update public.primary_recovery_attempts
  set status = 'finalized',
      finalized_at = now(),
      restored_sequence = p_restored_sequence
  where id = v_attempt.id
  returning * into v_attempt;

  return jsonb_build_object(
    'account', to_jsonb(v_account),
    'device', to_jsonb(v_device),
    'attempt', to_jsonb(v_attempt),
    'revoked_devices', v_revoked
  );
end;
$$;

create or replace function public.abort_primary_mobile_recovery(
  p_recovery_attempt_id uuid,
  p_device_id uuid
)
returns public.primary_recovery_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_restore_read_device(p_device_id);
  v_attempt public.primary_recovery_attempts%rowtype;
begin
  update public.primary_recovery_attempts
  set status = 'aborted'
  where id = p_recovery_attempt_id
    and device_id = v_device.id
    and status = 'pending'
  returning * into v_attempt;
  if not found then raise exception 'recovery_attempt_not_found'; end if;

  update public.devices
  set activation_state = 'aborted',
      revoked_at = coalesce(revoked_at, now())
  where id = v_device.id;

  return v_attempt;
end;
$$;

create or replace function public.begin_device_key_rotation(
  p_primary_device_id uuid,
  p_revoked_device_id uuid,
  p_reason text
)
returns public.key_epoch_rotations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.devices%rowtype := public.assert_active_primary_device(p_primary_device_id);
  v_account public.accounts%rowtype;
  v_target public.devices%rowtype;
  v_rotation public.key_epoch_rotations%rowtype;
begin
  if p_revoked_device_id = p_primary_device_id then raise exception 'cannot_revoke_active_primary'; end if;

  select * into v_account from public.accounts where id = v_primary.account_id for update;
  select * into v_target
  from public.devices
  where id = p_revoked_device_id and account_id = v_primary.account_id and revoked_at is null
  for update;
  if not found then raise exception 'device_not_found'; end if;

  insert into public.key_epoch_rotations (
    account_id, primary_device_id, revoked_device_id, reason, next_key_epoch, starting_sequence
  ) values (
    v_primary.account_id, v_primary.id, v_target.id, p_reason,
    coalesce(v_account.current_key_epoch, 1) + 1, v_account.current_sync_sequence
  ) returning * into v_rotation;

  return v_rotation;
end;
$$;

create or replace function public.finalize_device_key_rotation(
  p_primary_device_id uuid,
  p_rotation_id uuid,
  p_key_package_sequence bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.devices%rowtype := public.assert_active_primary_device(p_primary_device_id);
  v_account public.accounts%rowtype;
  v_rotation public.key_epoch_rotations%rowtype;
  v_revocation public.device_revocations%rowtype;
begin
  select * into v_rotation
  from public.key_epoch_rotations
  where id = p_rotation_id
    and account_id = v_primary.account_id
    and primary_device_id = v_primary.id
  for update;
  if not found then raise exception 'key_rotation_not_found'; end if;

  select * into v_account from public.accounts where id = v_primary.account_id for update;
  if v_rotation.status = 'finalized' then
    select * into v_revocation
    from public.device_revocations
    where account_id = v_primary.account_id
      and device_id = v_rotation.revoked_device_id
    order by created_at desc
    limit 1;
    return jsonb_build_object(
      'account', to_jsonb(v_account),
      'rotation', to_jsonb(v_rotation),
      'revocation', case when v_revocation.account_id is null then null else to_jsonb(v_revocation) end
    );
  end if;
  if v_rotation.status not in ('pending', 'aborted') then raise exception 'key_rotation_not_pending'; end if;

  if coalesce(v_account.current_key_epoch, 1) + 1 <> v_rotation.next_key_epoch then
    raise exception 'stale_key_rotation_epoch';
  end if;
  if p_key_package_sequence < v_rotation.starting_sequence or p_key_package_sequence > v_account.current_sync_sequence then
    raise exception 'invalid_key_package_sequence';
  end if;
  if p_key_package_sequence = v_rotation.starting_sequence then
    raise exception 'missing_key_rotation_packages';
  end if;
  if not exists (
    select 1
    from public.sync_objects o
    where o.account_id = v_primary.account_id
      and o.sequence > v_rotation.starting_sequence
      and o.sequence <= p_key_package_sequence
      and o.object_kind = 'key_package'
      and o.key_epoch = v_rotation.next_key_epoch
      and o.created_by_device_id = v_primary.id
      and o.operation_id = concat(
        'key-epoch-recovery:',
        v_primary.account_id::text,
        ':',
        v_rotation.next_key_epoch::text,
        ':',
        v_rotation.id::text
      )
  ) then
    raise exception 'missing_recovery_key_package';
  end if;
  if exists (
    select 1
    from public.devices d
    where d.account_id = v_primary.account_id
      and d.role <> 'primary_mobile'
      and d.id <> v_rotation.revoked_device_id
      and d.revoked_at is null
      and not exists (
        select 1
        from public.sync_objects o
        where o.account_id = v_primary.account_id
          and o.sequence > v_rotation.starting_sequence
          and o.sequence <= p_key_package_sequence
          and o.object_kind = 'key_package'
          and o.key_epoch = v_rotation.next_key_epoch
          and o.created_by_device_id = v_primary.id
          and o.operation_id = concat(
            'key-epoch:',
            v_primary.account_id::text,
            ':',
            v_rotation.next_key_epoch::text,
            ':',
            v_rotation.id::text,
            ':',
            d.id::text
          )
      )
  ) then
    raise exception 'missing_device_key_package';
  end if;

  update public.devices
  set revoked_at = coalesce(revoked_at, now())
  where id = v_rotation.revoked_device_id
    and account_id = v_primary.account_id;
  if not found then raise exception 'device_not_found'; end if;

  insert into public.device_revocations (account_id, device_id, reason)
  select v_primary.account_id, v_rotation.revoked_device_id, v_rotation.reason
  where not exists (
    select 1
    from public.device_revocations existing
    where existing.account_id = v_primary.account_id
      and existing.device_id = v_rotation.revoked_device_id
  );

  select * into v_revocation
  from public.device_revocations
  where account_id = v_primary.account_id
    and device_id = v_rotation.revoked_device_id
  order by created_at desc
  limit 1;

  update public.accounts
  set current_key_epoch = v_rotation.next_key_epoch
  where id = v_primary.account_id
  returning * into v_account;

  update public.key_epoch_rotations
  set status = 'finalized',
      finalized_at = now(),
      key_package_sequence = p_key_package_sequence
  where id = v_rotation.id
  returning * into v_rotation;

  return jsonb_build_object(
    'account', to_jsonb(v_account),
    'rotation', to_jsonb(v_rotation),
    'revocation', to_jsonb(v_revocation)
  );
end;
$$;

create or replace function public.abort_device_key_rotation(
  p_primary_device_id uuid,
  p_rotation_id uuid
)
returns public.key_epoch_rotations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.devices%rowtype := public.assert_active_primary_device(p_primary_device_id);
  v_rotation public.key_epoch_rotations%rowtype;
begin
  select * into v_rotation
  from public.key_epoch_rotations
  where id = p_rotation_id
    and account_id = v_primary.account_id
  for update;
  if not found then raise exception 'key_rotation_not_found'; end if;
  if v_rotation.status <> 'pending' then raise exception 'key_rotation_not_pending'; end if;
  if exists (
    select 1
    from public.sync_objects o
    where o.account_id = v_primary.account_id
      and o.sequence > v_rotation.starting_sequence
      and o.object_kind = 'key_package'
      and o.key_epoch = v_rotation.next_key_epoch
      and o.created_by_device_id = v_primary.id
      and (
        o.operation_id = concat(
          'key-epoch-recovery:',
          v_primary.account_id::text,
          ':',
          v_rotation.next_key_epoch::text,
          ':',
          v_rotation.id::text
        )
        or o.operation_id like concat(
          'key-epoch:',
          v_primary.account_id::text,
          ':',
          v_rotation.next_key_epoch::text,
          ':',
          v_rotation.id::text,
          ':%'
        )
      )
  ) then
    raise exception 'key_rotation_has_committed_packages';
  end if;

  update public.key_epoch_rotations
  set status = 'aborted'
  where id = v_rotation.id
  returning * into v_rotation;
  return v_rotation;
end;
$$;

create or replace function public.revoke_device(
  p_primary_device_id uuid,
  p_device_id uuid,
  p_reason text
)
returns public.device_revocations
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'device_key_rotation_requires_two_phase';
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
begin
  raise exception 'device_key_rotation_requires_two_phase';
end;
$$;

create or replace function public.get_latest_restore_manifest(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_restore_read_device(p_device_id);
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
  v_device public.devices%rowtype := public.assert_restore_read_device(p_device_id);
begin
  return query
    select *
    from public.sync_objects
    where account_id = v_device.account_id
      and retired_at is null
      and sequence > p_after_sequence
    order by sequence asc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

create or replace function public.update_device_cursor(
  p_device_id uuid,
  p_last_applied_sequence bigint
)
returns public.device_cursors
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_restore_read_device(p_device_id);
  v_cursor public.device_cursors%rowtype;
begin
  if p_last_applied_sequence < 0 then raise exception 'invalid_cursor_sequence'; end if;
  insert into public.device_cursors (account_id, device_id, last_applied_sequence, updated_at)
  values (v_device.account_id, v_device.id, p_last_applied_sequence, now())
  on conflict (account_id, device_id)
  do update set last_applied_sequence = excluded.last_applied_sequence,
                updated_at = now()
  returning * into v_cursor;
  return v_cursor;
end;
$$;

create or replace function public.transfer_primary_mobile(
  p_google_user_id text,
  p_google_email text,
  p_display_name text,
  p_platform text,
  p_public_key text,
  p_recovery_configured boolean,
  p_previous_primary_device_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'primary_recovery_requires_two_phase';
end;
$$;
