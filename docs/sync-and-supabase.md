# Dear Diary Sync and Supabase Runbook

This is the current source-of-truth for encrypted multi-device sync operations.

Dear Diary keeps journal plaintext on trusted devices only. Supabase stores account/device metadata, cursors, object hashes, and Drive object pointers. Google Drive `appDataFolder` stores encrypted sync objects.

## Required Migrations

Apply every file in `docs/supabase` in numeric order:

```text
001_multi_device_sync.sql
002_add_sync_object_versions.sql
003_fix_sync_object_ambiguity.sql
004_account_recovery_objects.sql
005_affected_record_versions.sql
006_pairing_provisioning.sql
007_key_epoch_rotation.sql
008_pairing_lookup_digest.sql
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

## Device Revocation and Key Rotation

Companion revocation is two-phase:

1. Client preflights Google Drive authorization.
2. `begin_device_key_rotation` reserves the next key epoch.
3. Client creates the next root key.
4. Client uploads and commits key packages for remaining active companions.
5. `finalize_device_key_rotation` revokes the target device and advances `current_key_epoch`.
6. Local primary secrets/state are updated only after finalize succeeds.

If package upload/commit fails, the client aborts the rotation and the target device remains active on the existing epoch.

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
npm run build
```

Staging smoke tests should cover:

- applying migrations `001` through `014` in order;
- new account setup;
- companion pairing;
- partitioned restore;
- primary recovery success and restore failure;
- stale recovery finalize followed by tail replay;
- companion revocation with package failure and success;
- old direct RPCs rejecting with the expected two-phase errors.
