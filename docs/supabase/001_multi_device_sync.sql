-- Dear Diary Phase A: account/device metadata control plane.
--
-- Supabase stores coordination metadata only. Journal plaintext, decrypted keys,
-- and accountRootKey material must never be inserted into these tables.
--
-- Expected auth shape:
-- - Google is the only v1 identity provider.
-- - RLS uses Supabase Auth's verified user id from auth.uid().
-- - google_user_id remains metadata for client/device checks and display.

create extension if not exists pgcrypto;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  supabase_user_id uuid not null default auth.uid() unique,
  google_user_id text not null unique,
  google_email text not null,
  created_at timestamptz not null default now(),
  active_primary_device_id uuid null,
  current_sync_sequence bigint not null default 0,
  current_snapshot_sequence bigint not null default 0,
  recovery_configured boolean not null default false
);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  role text not null check (role in ('primary_mobile', 'web_companion', 'desktop_companion')),
  public_key text not null,
  display_name text not null,
  platform text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz null,
  replaced_by_device_id uuid null references public.devices(id)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'accounts_active_primary_device_id_fkey'
  ) then
    alter table public.accounts
      add constraint accounts_active_primary_device_id_fkey
      foreign key (active_primary_device_id) references public.devices(id);
  end if;
end $$;

create table if not exists public.sync_objects (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  sequence bigint not null,
  drive_file_id text not null,
  object_kind text not null check (object_kind in ('event', 'media', 'snapshot', 'key_package')),
  sha256 text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  created_by_device_id uuid not null references public.devices(id),
  created_at timestamptz not null default now(),
  record_type text null check (record_type in ('diary', 'entry', 'note', 'settings', 'profile')),
  record_id text null,
  base_record_version bigint null check (base_record_version >= 0),
  record_version bigint null check (record_version > 0),
  unique (account_id, sequence),
  unique (account_id, drive_file_id)
);

alter table public.sync_objects add column if not exists record_type text null;
alter table public.sync_objects add column if not exists record_id text null;
alter table public.sync_objects add column if not exists base_record_version bigint null;
alter table public.sync_objects add column if not exists record_version bigint null;

create table if not exists public.record_versions (
  account_id uuid not null references public.accounts(id) on delete cascade,
  record_type text not null check (record_type in ('diary', 'entry', 'note', 'settings', 'profile')),
  record_id text not null,
  version bigint not null check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (account_id, record_type, record_id)
);

create table if not exists public.device_cursors (
  account_id uuid not null references public.accounts(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  last_applied_sequence bigint not null default 0 check (last_applied_sequence >= 0),
  updated_at timestamptz not null default now(),
  primary key (account_id, device_id)
);

create table if not exists public.pairing_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  requested_device_public_key text not null,
  requested_platform text not null,
  pairing_code_hash text not null,
  expires_at timestamptz not null,
  approved_by_primary_device_id uuid null references public.devices(id),
  approved_at timestamptz null
);

create table if not exists public.device_revocations (
  account_id uuid not null references public.accounts(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now()
);

create index if not exists devices_account_active_idx
  on public.devices(account_id, role)
  where revoked_at is null;
create index if not exists sync_objects_account_sequence_idx
  on public.sync_objects(account_id, sequence);
create index if not exists record_versions_account_record_idx
  on public.record_versions(account_id, record_type, record_id);
create index if not exists pairing_sessions_account_expires_idx
  on public.pairing_sessions(account_id, expires_at);

do $$
begin
  alter publication supabase_realtime add table public.sync_objects;
exception
  when duplicate_object then null;
end $$;

alter table public.accounts enable row level security;
alter table public.devices enable row level security;
alter table public.sync_objects enable row level security;
alter table public.record_versions enable row level security;
alter table public.device_cursors enable row level security;
alter table public.pairing_sessions enable row level security;
alter table public.device_revocations enable row level security;

create or replace function public.require_supabase_user_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'supabase_auth_required';
  end if;
  return v_user_id;
end;
$$;

create or replace function public.current_google_email()
returns text
language sql
stable
as $$
  select nullif(coalesce(
    auth.jwt() ->> 'email',
    auth.jwt() #>> '{user_metadata,email}'
  ), '')
$$;

create or replace function public.current_account_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.accounts
  where supabase_user_id = auth.uid()
  limit 1
$$;

create or replace function public.require_current_account_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_account_id uuid := public.current_account_id();
begin
  if v_account_id is null then
    raise exception 'account_not_found';
  end if;
  return v_account_id;
end;
$$;

drop policy if exists accounts_select_own on public.accounts;
create policy accounts_select_own
  on public.accounts
  for select
  using (supabase_user_id = auth.uid());

drop policy if exists accounts_insert_own on public.accounts;
create policy accounts_insert_own
  on public.accounts
  for insert
  with check (supabase_user_id = auth.uid());

drop policy if exists devices_select_own on public.devices;
create policy devices_select_own
  on public.devices
  for select
  using (account_id = public.current_account_id());

drop policy if exists sync_objects_select_own on public.sync_objects;
create policy sync_objects_select_own
  on public.sync_objects
  for select
  using (account_id = public.current_account_id());

drop policy if exists record_versions_select_own on public.record_versions;
create policy record_versions_select_own
  on public.record_versions
  for select
  using (account_id = public.current_account_id());

drop policy if exists cursors_select_own on public.device_cursors;
create policy cursors_select_own
  on public.device_cursors
  for select
  using (account_id = public.current_account_id());

drop policy if exists pairing_select_own on public.pairing_sessions;
create policy pairing_select_own
  on public.pairing_sessions
  for select
  using (account_id = public.current_account_id());

drop policy if exists revocations_select_own on public.device_revocations;
create policy revocations_select_own
  on public.device_revocations
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

  if not found then
    raise exception 'device_not_found';
  end if;

  if v_device.revoked_at is not null then
    raise exception 'device_revoked';
  end if;

  update public.devices
  set last_seen_at = now()
  where id = p_device_id;

  return v_device;
end;
$$;

create or replace function public.assert_active_primary_device(p_device_id uuid)
returns public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
  v_active_primary_device_id uuid;
begin
  select active_primary_device_id
  into v_active_primary_device_id
  from public.accounts
  where id = v_device.account_id;

  if v_device.role <> 'primary_mobile' or v_active_primary_device_id <> v_device.id then
    raise exception 'active_primary_mobile_required';
  end if;

  return v_device;
end;
$$;

create or replace function public.lookup_google_account()
returns setof public.accounts
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.accounts
  where supabase_user_id = public.require_supabase_user_id()
  limit 1
$$;

create or replace function public.create_primary_mobile_account(
  p_google_user_id text,
  p_google_email text,
  p_display_name text,
  p_platform text,
  p_public_key text,
  p_recovery_configured boolean
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
begin
  if coalesce(length(trim(p_google_user_id)), 0) = 0 then
    raise exception 'google_user_id_required';
  end if;

  if coalesce(length(trim(p_public_key)), 0) = 0 then
    raise exception 'device_public_key_required';
  end if;

  if p_recovery_configured is not true then
    raise exception 'recovery_passphrase_required';
  end if;

  if coalesce(nullif(p_google_email, ''), public.current_google_email()) is null then
    raise exception 'google_email_required';
  end if;

  if exists (select 1 from public.accounts where supabase_user_id = v_supabase_user_id) then
    raise exception 'account_already_exists';
  end if;

  insert into public.accounts (supabase_user_id, google_user_id, google_email, recovery_configured)
  values (v_supabase_user_id, p_google_user_id, coalesce(nullif(p_google_email, ''), public.current_google_email()), p_recovery_configured)
  returning * into v_account;

  insert into public.devices (account_id, role, public_key, display_name, platform)
  values (v_account.id, 'primary_mobile', p_public_key, p_display_name, p_platform)
  returning * into v_device;

  update public.accounts
  set active_primary_device_id = v_device.id
  where id = v_account.id
  returning * into v_account;

  insert into public.device_cursors (account_id, device_id, last_applied_sequence)
  values (v_account.id, v_device.id, 0);

  return jsonb_build_object('account', to_jsonb(v_account), 'device', to_jsonb(v_device));
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
declare
  v_supabase_user_id uuid := public.require_supabase_user_id();
  v_account public.accounts%rowtype;
  v_device public.devices%rowtype;
  v_revoked jsonb := '[]'::jsonb;
begin
  if coalesce(length(trim(p_google_user_id)), 0) = 0 then
    raise exception 'google_user_id_required';
  end if;

  if coalesce(length(trim(p_public_key)), 0) = 0 then
    raise exception 'device_public_key_required';
  end if;

  if p_recovery_configured is not true then
    raise exception 'recovery_passphrase_required';
  end if;

  select *
  into v_account
  from public.accounts
  where supabase_user_id = v_supabase_user_id
  for update;

  if not found then
    raise exception 'account_not_found';
  end if;

  if p_previous_primary_device_id is not null and v_account.active_primary_device_id <> p_previous_primary_device_id then
    raise exception 'primary_device_changed';
  end if;

  insert into public.devices (account_id, role, public_key, display_name, platform)
  values (v_account.id, 'primary_mobile', p_public_key, p_display_name, p_platform)
  returning * into v_device;

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
    select account_id, id, 'primary_mobile_transfer'
    from revoked
    returning 1
  )
  select coalesce(jsonb_agg(to_jsonb(revoked)), '[]'::jsonb)
  into v_revoked
  from revoked;

  update public.accounts
  set active_primary_device_id = v_device.id,
      google_user_id = p_google_user_id,
      google_email = coalesce(nullif(p_google_email, ''), google_email),
      recovery_configured = p_recovery_configured
  where id = v_account.id
  returning * into v_account;

  insert into public.device_cursors (account_id, device_id, last_applied_sequence)
  values (v_account.id, v_device.id, 0);

  return jsonb_build_object(
    'account', to_jsonb(v_account),
    'device', to_jsonb(v_device),
    'revoked_devices', v_revoked
  );
end;
$$;

create or replace function public.get_device_status(p_device_id uuid)
returns setof public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supabase_user_id uuid := public.require_supabase_user_id();
begin
  return query
    select d.*
    from public.devices d
    join public.accounts a on a.id = d.account_id
    where d.id = p_device_id
      and a.supabase_user_id = v_supabase_user_id
    limit 1;
end;
$$;

drop function if exists public.commit_sync_object(uuid, bigint, text, text, text, bigint);

create or replace function public.commit_sync_object(
  p_device_id uuid,
  p_after_sequence bigint,
  p_drive_file_id text,
  p_object_kind text,
  p_sha256 text,
  p_size_bytes bigint,
  p_record_type text default null,
  p_record_id text default null,
  p_base_record_version bigint default null
)
returns public.sync_objects
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
  v_account public.accounts%rowtype;
  v_object public.sync_objects%rowtype;
  v_next_sequence bigint;
  v_current_record_version bigint;
  v_next_record_version bigint;
begin
  select *
  into v_account
  from public.accounts
  where id = v_device.account_id
  for update;

  if p_after_sequence <> v_account.current_sync_sequence then
    raise exception 'stale_sync_sequence';
  end if;

  if p_object_kind not in ('event', 'media', 'snapshot', 'key_package') then
    raise exception 'unsupported_sync_object_kind';
  end if;

  if p_object_kind = 'event' then
    if p_record_type not in ('diary', 'entry', 'note', 'settings', 'profile')
       or nullif(p_record_id, '') is null
       or p_base_record_version is null
       or p_base_record_version < 0 then
      raise exception 'invalid_event_record_metadata';
    end if;

    select version
    into v_current_record_version
    from public.record_versions
    where account_id = v_account.id
      and record_type = p_record_type
      and record_id = p_record_id
    for update;

    v_current_record_version := coalesce(v_current_record_version, 0);
    if p_base_record_version <> v_current_record_version then
      raise exception 'stale_record_version';
    end if;
    v_next_record_version := v_current_record_version + 1;

    insert into public.record_versions (account_id, record_type, record_id, version)
    values (v_account.id, p_record_type, p_record_id, v_next_record_version)
    on conflict (account_id, record_type, record_id)
    do update set version = excluded.version, updated_at = now();
  else
    p_record_type := null;
    p_record_id := null;
    p_base_record_version := null;
    v_next_record_version := null;
  end if;

  v_next_sequence := v_account.current_sync_sequence + 1;

  insert into public.sync_objects (
    account_id,
    sequence,
    drive_file_id,
    object_kind,
    sha256,
    size_bytes,
    created_by_device_id,
    record_type,
    record_id,
    base_record_version,
    record_version
  )
  values (
    v_account.id,
    v_next_sequence,
    p_drive_file_id,
    p_object_kind,
    p_sha256,
    p_size_bytes,
    v_device.id,
    p_record_type,
    p_record_id,
    p_base_record_version,
    v_next_record_version
  )
  returning * into v_object;

  update public.accounts
  set current_sync_sequence = v_next_sequence,
      current_snapshot_sequence = case
        when p_object_kind = 'snapshot' then v_next_sequence
        else current_snapshot_sequence
      end
  where id = v_account.id;

  return v_object;
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
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
begin
  return query
    select *
    from public.sync_objects
    where account_id = v_device.account_id
      and sequence > p_after_sequence
    order by sequence asc
    limit least(greatest(p_limit, 1), 500);
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
  v_device public.devices%rowtype := public.assert_active_device(p_device_id);
  v_cursor public.device_cursors%rowtype;
begin
  insert into public.device_cursors (account_id, device_id, last_applied_sequence, updated_at)
  values (v_device.account_id, v_device.id, p_last_applied_sequence, now())
  on conflict (account_id, device_id)
  do update
    set last_applied_sequence = excluded.last_applied_sequence,
        updated_at = now()
  returning * into v_cursor;

  return v_cursor;
end;
$$;

create or replace function public.create_pairing_session(
  p_requested_device_public_key text,
  p_requested_platform text,
  p_pairing_code_hash text,
  p_expires_at timestamptz
)
returns public.pairing_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid := public.current_account_id();
  v_session public.pairing_sessions%rowtype;
begin
  if v_account_id is null then
    raise exception 'account_not_found';
  end if;

  if p_expires_at <= now() then
    raise exception 'pairing_session_expired';
  end if;

  insert into public.pairing_sessions (
    account_id,
    requested_device_public_key,
    requested_platform,
    pairing_code_hash,
    expires_at
  )
  values (
    v_account_id,
    p_requested_device_public_key,
    p_requested_platform,
    p_pairing_code_hash,
    p_expires_at
  )
  returning * into v_session;

  return v_session;
end;
$$;

create or replace function public.approve_pairing_session(
  p_session_id uuid,
  p_primary_device_id uuid
)
returns public.pairing_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.devices%rowtype := public.assert_active_primary_device(p_primary_device_id);
  v_session public.pairing_sessions%rowtype;
begin
  select *
  into v_session
  from public.pairing_sessions
  where id = p_session_id
    and account_id = v_primary.account_id
  for update;

  if not found then
    raise exception 'pairing_session_not_found';
  end if;

  if v_session.expires_at <= now() then
    raise exception 'pairing_session_expired';
  end if;

  update public.pairing_sessions
  set approved_by_primary_device_id = v_primary.id,
      approved_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
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
declare
  v_primary public.devices%rowtype := public.assert_active_primary_device(p_primary_device_id);
  v_revocation public.device_revocations%rowtype;
begin
  if p_device_id = p_primary_device_id then
    raise exception 'cannot_revoke_active_primary';
  end if;

  update public.devices
  set revoked_at = coalesce(revoked_at, now())
  where id = p_device_id
    and account_id = v_primary.account_id;

  if not found then
    raise exception 'device_not_found';
  end if;

  insert into public.device_revocations (account_id, device_id, reason)
  values (v_primary.account_id, p_device_id, p_reason)
  returning * into v_revocation;

  return v_revocation;
end;
$$;
