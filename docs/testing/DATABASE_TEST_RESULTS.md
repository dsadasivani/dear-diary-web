# Database Test Results

Command: `npm.cmd run test:supabase`  
Exit code: 0  
Result: Supabase integration tests passed.

## Migration Behavior

The suite starts a real PostgreSQL 16 Docker container and applies the exact ordered migration set:

1. `001_multi_device_sync.sql`
2. `002_companion_pairing.sql`
3. `003_portable_state_events.sql`
4. `004_atomic_cascade_events.sql`
5. `005_device_management.sql`
6. `006_key_package_retirement.sql`
7. `007_sync_object_maintenance.sql`
8. `008_safe_primary_recovery.sql`
9. `009_partitioned_latest_first_sync.sql`
10. `010_sync_gc_retention.sql`
11. `011_fix_pairing_digest.sql`
12. `012_sync_object_kind_constraint.sql`
13. `013_sync_media_gc.sql`
14. `014_two_phase_recovery_and_rotation.sql`
15. `015_fix_partition_restore_bundle_ambiguity.sql`
16. `016_idempotent_key_rotation_finalize.sql`
17. `017_guard_key_rotation_abort_race.sql`

## Covered Scenarios

- Clean installation of all migrations.
- Exact migration filename/order assertion.
- Basic RLS isolation for accounts and sync objects across two users.
- RLS rejects cross-user account inserts.
- Two-phase key rotation requires recovery and surviving companion key packages.
- Key rotation finalization advances the account epoch and revokes the target device.
- Key rotation finalization is retry-safe after server-side completion.
- Key rotation finalization can repair an aborted-after-package state when committed packages are present.
- Key rotation abort rejects attempts once next-epoch key packages have already committed.
- Concurrent key rotations allow only one pending rotation.
- Concurrent primary recoveries allow only one pending recovery.
- Pending recovery devices cannot commit normal sync objects.
- Aborted primary recovery allows a later recovery attempt.

## Schema Fixes Added

- Migration `014` now creates `primary_recovery_attempts_one_pending_per_account`, a partial unique index on `primary_recovery_attempts(account_id)` where `status = 'pending'`.
- Migration `015` disambiguates `get_partition_restore_bundle` return/internal column names to avoid `partition_key` ambiguity after companion pairing restore.
- Migration `016` makes `finalize_device_key_rotation` retry-safe after a force-stop between server commit and client persistence.
- Migration `017` prevents aborting rotations after next-epoch packages have committed and lets finalize repair that race state.

## Remaining Database Gaps

The suite is stronger but not exhaustive. It does not yet cover every table/policy combination listed in the audit request, all stale-schema upgrade paths, repeated finalize idempotency for every RPC, pairing-code expiry/digest replay in real HTTP mode, or full retention/garbage-collection object matrices. These gaps remain release blockers for the requested production-readiness standard.
