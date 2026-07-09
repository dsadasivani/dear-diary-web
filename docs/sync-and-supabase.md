# Dear Diary Sync and Supabase Runbook

This is the current source-of-truth for encrypted multi-device sync operations.

Dear Diary keeps journal plaintext on trusted devices only. Supabase stores account/device metadata, cursors, object hashes, and Drive object pointers. Google Drive `appDataFolder` stores encrypted sync objects.

## Required Migrations

Apply every file in `docs/supabase` in numeric order:

```text
001_multi_device_sync.sql
002_companion_pairing.sql
003_portable_state_events.sql
004_atomic_cascade_events.sql
005_device_management.sql
006_key_package_retirement.sql
007_sync_object_maintenance.sql
008_safe_primary_recovery.sql
009_partitioned_latest_first_sync.sql
010_sync_gc_retention.sql
011_fix_pairing_digest.sql
012_sync_object_kind_constraint.sql
013_sync_media_gc.sql
014_two_phase_recovery_and_rotation.sql
```

`014` intentionally blocks legacy direct primary transfer, direct device revocation, and direct key-epoch rotation RPCs. New clients must use the two-phase flows.

## Data Plane

- `event`: encrypted domain mutation.
- `media`: encrypted attached media.
- `thumbnail`: encrypted generated image thumbnail.
- `snapshot`: legacy full encrypted snapshot.
- `partition_snapshot`: encrypted partition snapshot.
- `manifest`: encrypted partition manifest.
- `key_package`: encrypted root-key package for recovery or companion devices.

Drive object bytes are authenticated by SHA-256 metadata stored in Supabase. Clients reject hash mismatches before decrypting/applying objects.

## Restore Model

Current restore is latest-first:

1. Read the encrypted manifest.
2. Restore `core`, current month, and previous month first.
3. Mark older monthly partitions as available.
4. Hydrate old months on demand or through background hydration when policy allows.

If no manifest exists, clients may fall back to the latest valid legacy full snapshot. If a manifest exists but partition restore fails, clients surface retry instead of doing a legacy full restore.

## Primary Mobile Recovery

Primary replacement is two-phase:

1. `begin_primary_mobile_recovery` creates a `pending_recovery` primary candidate.
2. The pending device may read restore metadata and restore encrypted data.
3. User writes remain disabled while pending.
4. Client updates its cursor after restore.
5. `finalize_primary_mobile_recovery` verifies the restored sequence equals the current account sequence.
6. If stale, the client replays the tail, updates cursor, and retries finalize.
7. Only finalize activates the new primary and revokes old devices.

On restore failure, the client calls `abort_primary_mobile_recovery`, clears local pending state, and does not revoke the old primary.

After `begin_primary_mobile_recovery` succeeds, the client stores a pending-primary-recovery journal in encrypted sync secret storage. The journal stores derived local security config, device key material, Supabase/Google sessions, and the recovered account root key, but never the recovery passphrase, local PIN, or recovery-answer plaintext. On app unlock or account-link retry, the client resumes restore, cursor update, stale-tail replay, or cleanup of an already-finalized recovery before normal sync polling starts.

## Device Revocation and Key Rotation

Companion revocation is two-phase:

1. Client preflights Google Drive authorization.
2. Client verifies the current recovery passphrase against the latest recovery package.
3. `begin_device_key_rotation` reserves the next key epoch.
4. Client creates the next root key.
5. Client uploads and commits a recovery package plus key packages for all remaining active companions.
6. Client durably stores the new epoch key locally before finalization.
7. `finalize_device_key_rotation` verifies the recovery package and remaining-device package operations, revokes the target device, and advances `current_key_epoch`.
8. Local primary state is promoted to the finalized key epoch.

The primary stores a pending-rotation journal in encrypted sync secret storage as soon as `begin_device_key_rotation` succeeds. The journal stores the future root key and package progress, but not the recovery passphrase. On app unlock or companion-device refresh, the client resumes missing package commits, promotes a rotation that already finalized server-side, or aborts a begun rotation if no recovery package was committed.

If package upload/commit fails before a recovery package commit, the client can abort the rotation and the target device remains active on the existing epoch. Once a recovery package is committed, resume continues the rotation instead of discarding the pending future key.

## Durable User-Write Outbox

User writes are staged locally before Drive/Supabase work:

- `prepared`
- `media_uploading`
- `media_uploaded`
- `event_uploading`
- `event_uploaded`
- `metadata_committing`
- `committed`
- `applied`
- `failed`

Startup and new writes resume pending/failed user-write operations before accepting the next mutation. Snapshots, partition migration, key packages, and maintenance remain best-effort maintenance paths rather than durable user-write outbox operations.

## Security Boundaries

- Rich-text HTML is sanitized with a strict allowlist before editing, persistence, import, sync replay, and display.
- Web repository writes use encrypted IndexedDB and multi-key transactions.
- Native runtime storage fails closed if encrypted SQLite cannot open; Preferences are migration input only.
- Pending recovery devices may read restore metadata but cannot commit sync objects.
- Active-device RPCs reject revoked, aborted, or pending-recovery devices.

## Validation

Normal local validation:

```bash
npm run lint
npm run test:storage
npm run test:supabase
npm run build
```

`npm run test:supabase` requires Docker. It starts a disposable PostgreSQL container, installs a Supabase Auth compatibility shim, applies migrations `001` through `014`, and runs real RLS/RPC/concurrency assertions.

Staging smoke tests should cover:

- applying migrations `001` through `014` in order;
- new account setup;
- companion pairing;
- partitioned restore;
- primary recovery success, restore failure, and crash-resume;
- stale recovery finalize followed by tail replay;
- companion revocation with package failure, crash-resume, and success;
- old direct RPCs rejecting with the expected two-phase errors.
