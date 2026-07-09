-- Guard against companion-panel refresh racing an in-progress key rotation.
-- Once any next-epoch key package is committed, abort is no longer safe.
-- If an older client already aborted after package commit, finalize can repair it.

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
      finalized_at = coalesce(finalized_at, now()),
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
