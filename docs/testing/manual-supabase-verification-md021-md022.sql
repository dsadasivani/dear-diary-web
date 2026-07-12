-- Dear Diary manual Supabase verification for MD-021, MD-022, and MD-023.
--
-- Run this only in the disposable test Supabase project used for manual device
-- recovery/rotation testing. Replace the placeholder below with the test Google
-- email inside your private SQL editor session. Do not paste secrets, tokens,
-- passphrases, private keys, or raw key material into chat or issue comments.
--
-- The result intentionally returns booleans and counts rather than raw UUIDs.

with params as (
  select '__REPLACE_WITH_TEST_GOOGLE_EMAIL__'::text as google_email
), account_scope as (
  select
    a.id,
    a.active_primary_device_id,
    a.current_sync_sequence,
    coalesce(a.current_key_epoch, 1) as current_key_epoch
  from public.accounts a
  join params p on p.google_email = a.google_email
), latest_recovery as (
  select r.*
  from public.primary_recovery_attempts r
  where r.account_id in (select id from account_scope)
  order by r.started_at desc
  limit 1
), latest_finalized_rotation as (
  select r.*
  from public.key_epoch_rotations r
  where r.account_id in (select id from account_scope)
    and r.status = 'finalized'
  order by r.created_at desc
  limit 1
), summary as (
  select
    (select count(*) from account_scope) as account_count,
    (select count(*) from public.devices where account_id in (select id from account_scope)) as device_count,
    (select count(*) from public.devices where account_id in (select id from account_scope) and revoked_at is null) as active_device_count,
    (select count(*) from public.devices where account_id in (select id from account_scope) and revoked_at is not null) as revoked_device_count,
    (select count(*) from public.primary_recovery_attempts where account_id in (select id from account_scope) and status = 'pending') as pending_recovery_count,
    (select count(*) from public.key_epoch_rotations where account_id in (select id from account_scope) and status = 'pending') as pending_rotation_count,
    (select count(*) from public.key_epoch_rotations where account_id in (select id from account_scope) and status = 'finalized') as finalized_rotation_count,
    (select count(*) from public.device_revocations where account_id in (select id from account_scope)) as revocation_count,
    coalesce((select max(current_sync_sequence) from account_scope), 0) as current_sync_sequence,
    coalesce((select max(current_key_epoch) from account_scope), 0) as current_key_epoch
)
select
  'account_count_is_one' as check_name,
  account_count::text as observed,
  account_count = 1 as passed,
  'Exactly one disposable test account matched the private Google email.' as notes
from summary
union all
select
  'active_primary_device_is_active',
  exists (
    select 1
    from account_scope a
    join public.devices d on d.id = a.active_primary_device_id
    where d.account_id = a.id
      and d.activation_state = 'active'
      and d.revoked_at is null
  )::text,
  exists (
    select 1
    from account_scope a
    join public.devices d on d.id = a.active_primary_device_id
    where d.account_id = a.id
      and d.activation_state = 'active'
      and d.revoked_at is null
  ),
  'MD-021 should leave the recovered device as the only active primary.'
from summary
union all
select
  'sync_sequence_nonzero',
  current_sync_sequence::text,
  current_sync_sequence > 0,
  'Seeded account should have synced at least one object.'
from summary
union all
select
  'latest_primary_recovery_finalized',
  coalesce((select status from latest_recovery), '<none>'),
  coalesce((select status from latest_recovery), '') = 'finalized',
  'MD-021 server-finalized checkpoint should have a finalized recovery attempt.'
from summary
union all
select
  'no_pending_primary_recovery',
  pending_recovery_count::text,
  pending_recovery_count = 0,
  'No pending primary recovery should remain after resume/local cleanup.'
from summary
union all
select
  'recovery_sequence_matches_account',
  coalesce((select restored_sequence::text from latest_recovery), '<none>') || ' / ' || current_sync_sequence::text,
  exists (
    select 1
    from latest_recovery r
    join account_scope a on a.id = r.account_id
    where r.status = 'finalized'
      and r.restored_sequence = a.current_sync_sequence
  ),
  'Finalized recovery should record the sequence restored by the recovered device.'
from summary
union all
select
  'previous_primary_revoked_and_replaced',
  exists (
    select 1
    from latest_recovery r
    join account_scope a on a.id = r.account_id
    join public.devices old_primary on old_primary.id = r.previous_primary_device_id
    where r.status = 'finalized'
      and old_primary.revoked_at is not null
      and old_primary.replaced_by_device_id = a.active_primary_device_id
  )::text,
  exists (
    select 1
    from latest_recovery r
    join account_scope a on a.id = r.account_id
    join public.devices old_primary on old_primary.id = r.previous_primary_device_id
    where r.status = 'finalized'
      and old_primary.revoked_at is not null
      and old_primary.replaced_by_device_id = a.active_primary_device_id
  ),
  'MD-023 should show the old primary revoked and replaced by the recovered primary.'
from summary
union all
select
  'active_primary_cursor_caught_up',
  exists (
    select 1
    from account_scope a
    join public.device_cursors c on c.account_id = a.id and c.device_id = a.active_primary_device_id
    where c.last_applied_sequence >= a.current_sync_sequence
  )::text,
  exists (
    select 1
    from account_scope a
    join public.device_cursors c on c.account_id = a.id and c.device_id = a.active_primary_device_id
    where c.last_applied_sequence >= a.current_sync_sequence
  ),
  'Recovered primary cursor should be caught up to the account sequence.'
from summary
union all
select
  'device_counts',
  ('total=' || device_count || ', active=' || active_device_count || ', revoked=' || revoked_device_count),
  device_count >= 2 and active_device_count >= 1 and revoked_device_count >= 1,
  'Manual run should include at least two devices and at least one revoked device.'
from summary
union all
select
  'no_pending_key_rotation',
  pending_rotation_count::text,
  pending_rotation_count = 0,
  'MD-022 resume should not leave a pending rotation.'
from summary
union all
select
  'key_rotation_finalized',
  finalized_rotation_count::text,
  finalized_rotation_count >= 1,
  'At least one MD-022 checkpoint should have finalized a key rotation.'
from summary
union all
select
  'current_key_epoch_advanced',
  current_key_epoch::text,
  current_key_epoch > 1,
  'Finalized key rotation should advance the account key epoch.'
from summary
union all
select
  'current_epoch_key_package_exists',
  exists (
    select 1
    from account_scope a
    join public.sync_objects s on s.account_id = a.id
    where s.object_kind = 'key_package'
      and s.key_epoch = a.current_key_epoch
  )::text,
  exists (
    select 1
    from account_scope a
    join public.sync_objects s on s.account_id = a.id
    where s.object_kind = 'key_package'
      and s.key_epoch = a.current_key_epoch
  ),
  'Current epoch should have at least one published key package.'
from summary
union all
select
  'rotation_revocation_recorded',
  exists (
    select 1
    from latest_finalized_rotation r
    join public.device_revocations dr on dr.account_id = r.account_id and dr.device_id = r.revoked_device_id
  )::text,
  exists (
    select 1
    from latest_finalized_rotation r
    join public.device_revocations dr on dr.account_id = r.account_id and dr.device_id = r.revoked_device_id
  ),
  'Finalized MD-022 rotation should record revocation for the target device.'
from summary
union all
select
  'primary_recovery_revocation_recorded',
  exists (
    select 1
    from public.device_revocations dr
    where dr.account_id in (select id from account_scope)
      and dr.reason = 'primary_mobile_recovery'
  )::text,
  exists (
    select 1
    from public.device_revocations dr
    where dr.account_id in (select id from account_scope)
      and dr.reason = 'primary_mobile_recovery'
  ),
  'MD-021 finalize should record primary recovery revocations.'
from summary
union all
select
  'revocations_recorded',
  revocation_count::text,
  revocation_count >= 1,
  'At least one device revocation should exist after MD-021/MD-022.'
from summary
order by check_name;
