-- Fix companion approval when pgcrypto is installed in Supabase's extensions schema.
-- Apply after 010_sync_gc_retention.sql.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

drop function if exists public.approve_pairing_session(uuid, uuid, text, bigint, text, text, bigint);
drop function if exists public.approve_pairing_session(uuid, uuid, text, bigint, text, text, bigint, integer);

create or replace function public.approve_pairing_session(
  p_session_id uuid,
  p_primary_device_id uuid,
  p_pairing_code text,
  p_after_sequence bigint,
  p_drive_file_id text,
  p_sha256 text,
  p_size_bytes bigint,
  p_key_epoch integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = extensions, public
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
  if encode(digest(convert_to(p_pairing_code, 'UTF8'), 'sha256'::text), 'hex') <> v_session.pairing_code_hash then
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
    p_device_id := v_primary.id,
    p_after_sequence := p_after_sequence,
    p_drive_file_id := p_drive_file_id,
    p_object_kind := 'key_package',
    p_sha256 := p_sha256,
    p_size_bytes := p_size_bytes,
    p_key_epoch := p_key_epoch
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
