-- Dear Diary Phase D: atomic companion approval and key provisioning.
-- Apply after 001_multi_device_sync.sql.

alter table public.pairing_sessions
  add column if not exists requested_display_name text;
update public.pairing_sessions
set requested_display_name = coalesce(requested_display_name, requested_platform || ' companion');
alter table public.pairing_sessions
  alter column requested_display_name set not null;

alter table public.pairing_sessions
  add column if not exists approved_device_id uuid null references public.devices(id),
  add column if not exists key_package_drive_file_id text null,
  add column if not exists key_package_sha256 text null,
  add column if not exists key_package_size_bytes bigint null check (key_package_size_bytes >= 0);

create unique index if not exists pairing_sessions_approved_device_idx
  on public.pairing_sessions(approved_device_id)
  where approved_device_id is not null;

drop function if exists public.create_pairing_session(text, text, text, timestamptz);
create or replace function public.create_pairing_session(
  p_requested_device_public_key text,
  p_requested_display_name text,
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
  if v_account_id is null then raise exception 'account_not_found'; end if;
  if p_requested_platform not in ('web', 'desktop') then raise exception 'unsupported_companion_platform'; end if;
  if nullif(trim(p_requested_display_name), '') is null then raise exception 'device_display_name_required'; end if;
  if char_length(p_requested_device_public_key) > 16384 then raise exception 'device_public_key_too_large'; end if;
  if p_pairing_code_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_pairing_code_hash'; end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '15 minutes' then
    raise exception 'invalid_pairing_expiry';
  end if;

  delete from public.pairing_sessions
  where account_id = v_account_id
    and approved_at is null
    and expires_at <= now();

  insert into public.pairing_sessions (
    account_id,
    requested_device_public_key,
    requested_display_name,
    requested_platform,
    pairing_code_hash,
    expires_at
  ) values (
    v_account_id,
    p_requested_device_public_key,
    trim(p_requested_display_name),
    p_requested_platform,
    p_pairing_code_hash,
    p_expires_at
  ) returning * into v_session;
  return v_session;
end;
$$;

create or replace function public.get_pairing_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account_id uuid := public.require_current_account_id();
  v_session public.pairing_sessions%rowtype;
  v_device public.devices%rowtype;
  v_key_object public.sync_objects%rowtype;
begin
  select * into v_session
  from public.pairing_sessions
  where id = p_session_id and account_id = v_account_id;
  if not found then raise exception 'pairing_session_not_found'; end if;

  if v_session.approved_device_id is not null then
    select * into v_device from public.devices where id = v_session.approved_device_id;
  end if;
  if v_session.key_package_drive_file_id is not null then
    select * into v_key_object
    from public.sync_objects
    where account_id = v_account_id
      and drive_file_id = v_session.key_package_drive_file_id;
  end if;

  return jsonb_build_object(
    'session', to_jsonb(v_session),
    'device', case when v_device.id is null then null else to_jsonb(v_device) end,
    'key_object', case when v_key_object.id is null then null else to_jsonb(v_key_object) end
  );
end;
$$;

create or replace function public.list_pending_pairing_sessions(p_primary_device_id uuid)
returns setof public.pairing_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.devices%rowtype := public.assert_active_primary_device(p_primary_device_id);
begin
  return query
    select * from public.pairing_sessions
    where account_id = v_primary.account_id
      and approved_at is null
      and expires_at > now()
    order by expires_at asc;
end;
$$;

drop function if exists public.approve_pairing_session(uuid, uuid);
create or replace function public.approve_pairing_session(
  p_session_id uuid,
  p_primary_device_id uuid,
  p_pairing_code text,
  p_after_sequence bigint,
  p_drive_file_id text,
  p_sha256 text,
  p_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_primary public.devices%rowtype := public.assert_active_primary_device(p_primary_device_id);
  v_session public.pairing_sessions%rowtype;
  v_device public.devices%rowtype;
  v_key_object public.sync_objects%rowtype;
  v_role text;
begin
  select * into v_session
  from public.pairing_sessions
  where id = p_session_id and account_id = v_primary.account_id
  for update;
  if not found then raise exception 'pairing_session_not_found'; end if;
  if v_session.approved_at is not null then raise exception 'pairing_session_already_approved'; end if;
  if v_session.expires_at <= now() then raise exception 'pairing_session_expired'; end if;
  if encode(digest(p_pairing_code, 'sha256'), 'hex') <> v_session.pairing_code_hash then
    raise exception 'pairing_code_invalid';
  end if;

  v_role := case
    when v_session.requested_platform = 'web' then 'web_companion'
    else 'desktop_companion'
  end;

  insert into public.devices (account_id, role, public_key, display_name, platform)
  values (
    v_primary.account_id,
    v_role,
    v_session.requested_device_public_key,
    v_session.requested_display_name,
    v_session.requested_platform
  ) returning * into v_device;

  v_key_object := public.commit_sync_object(
    v_primary.id,
    p_after_sequence,
    p_drive_file_id,
    'key_package',
    p_sha256,
    p_size_bytes,
    null,
    null,
    null
  );

  update public.pairing_sessions
  set approved_by_primary_device_id = v_primary.id,
      approved_device_id = v_device.id,
      approved_at = now(),
      key_package_drive_file_id = p_drive_file_id,
      key_package_sha256 = p_sha256,
      key_package_size_bytes = p_size_bytes
  where id = v_session.id
  returning * into v_session;

  insert into public.device_cursors (account_id, device_id, last_applied_sequence)
  values (v_primary.account_id, v_device.id, 0);

  return jsonb_build_object(
    'session', to_jsonb(v_session),
    'device', to_jsonb(v_device),
    'key_object', to_jsonb(v_key_object)
  );
end;
$$;
