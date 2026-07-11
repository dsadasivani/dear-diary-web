-- Dear Diary portable settings/profile event support.
-- Apply after 002_companion_pairing.sql.

alter table public.sync_objects
  drop constraint if exists sync_objects_record_type_check;
alter table public.sync_objects
  add constraint sync_objects_record_type_check
  check (record_type in ('diary', 'entry', 'note', 'settings', 'profile'));

alter table public.record_versions
  drop constraint if exists record_versions_record_type_check;
alter table public.record_versions
  add constraint record_versions_record_type_check
  check (record_type in ('diary', 'entry', 'note', 'settings', 'profile'));

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
  select * into v_account
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
    if (p_record_type = 'settings' and p_record_id <> 'settings')
       or (p_record_type = 'profile' and p_record_id <> 'profile') then
      raise exception 'invalid_singleton_record_id';
    end if;

    select version into v_current_record_version
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
    account_id, sequence, drive_file_id, object_kind, sha256, size_bytes,
    created_by_device_id, record_type, record_id, base_record_version, record_version
  ) values (
    v_account.id, v_next_sequence, p_drive_file_id, p_object_kind, p_sha256, p_size_bytes,
    v_device.id, p_record_type, p_record_id, p_base_record_version, v_next_record_version
  ) returning * into v_object;

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
