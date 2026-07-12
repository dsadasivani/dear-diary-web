-- Make primary recovery finalization retry-safe after server-side completion.
-- A mobile process can stop after the server commits recovery but before the
-- client persists the response. Retrying the finalize RPC should return the
-- finalized state instead of surfacing recovery_attempt_not_pending.
-- Apply after 017_guard_key_rotation_abort_race.sql.

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

  select * into v_account
  from public.accounts
  where id = v_device.account_id
  for update;

  if v_attempt.status = 'finalized' then
    if v_account.active_primary_device_id <> v_device.id then
      raise exception 'recovery_attempt_not_pending';
    end if;
    if v_attempt.restored_sequence is not null and p_restored_sequence <> v_attempt.restored_sequence then
      raise exception 'stale_recovery_sequence';
    end if;

    return jsonb_build_object(
      'account', to_jsonb(v_account),
      'device', to_jsonb(v_device),
      'attempt', to_jsonb(v_attempt),
      'revoked_devices', v_revoked
    );
  end if;

  if v_attempt.status <> 'pending' then raise exception 'recovery_attempt_not_pending'; end if;

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
