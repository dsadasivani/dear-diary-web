# Database Test Results

- Command: `npm.cmd run test:supabase`
- Exit code: 0
- Date: 2026-07-12
- Branch: `feature/local-first-performance`
- Commit SHA: `34f74c0ccc270b6e245a1328cc6effd399e1bfbf` plus the uncommitted audit fixes in this working tree
- Docker: Client `29.4.3`, Server `29.4.3`, Docker Desktop `4.74.0 (227015)`

## Result

Passed against a disposable Docker/PostgreSQL database.

The suite installed the Supabase Auth compatibility shim, applied the real ordered migrations `001` through `018`, reapplied the same migrations to verify idempotency, installed authenticated-role grants, and completed all RLS/RPC/integrity assertions.

## Migration Set

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
18. `018_idempotent_primary_recovery_finalize.sql`

## Coverage Verified

- Ordered migration application and idempotent reapplication.
- Required RLS-enabled tables, RPC capability presence, and sync-object capability columns for stale-schema detection.
- Cross-account RLS isolation for account and sync-object reads plus cross-user account insert denial.
- Duplicate operation ID idempotency, stale record-version rejection, and future sequence rejection.
- Pairing wrong-code digest rejection, approval success, approval replay rejection, and expired pairing rejection.
- Key rotation begin/finalize guards, missing package rejection, abort-after-package rejection, aborted-then-finalized repair, finalized retry, target revocation, and revocation record creation.
- Concurrent key-rotation and primary-recovery pending-slot protection.
- Pending recovery devices cannot commit normal sync objects; aborted recovery allows a replacement pending recovery.
- Primary recovery finalize retry returns the already-finalized state after server-side completion.
- GC retirement retires event/media objects while preserving key packages and excluding retired objects from restore listings.

## Remaining Database Notes

No local Docker/PostgreSQL release blocker remains. Production Supabase project validation still needs the normal staging smoke path before release, but the repository integration suite now passes locally.
