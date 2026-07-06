# Partitioned Latest-First Multi-Device Sync: Implementation Summary

Date: 2026-07-06

This document summarizes the implementation work completed for the partitioned latest-first multi-device sync redesign discussed in this thread.

## Goal

Dear Diary sync was redesigned for long-lived accounts with many years of data.

The core behavior now targets:

- Recent data first on fresh login.
- Monthly encrypted partitions for old diary content.
- On-demand archive restore.
- Background archive hydration when conditions are safe.
- Partition-aware incremental pull.
- Idempotent, conflict-safe writes.
- Stronger encrypted-device lifecycle handling through key epochs.

## High-level behavior implemented

- Diary data is partitioned by month using `month:YYYY-MM`.
- Account-level data uses the `core` partition.
- Fresh restore prioritizes:
  - `core`
  - current month
  - previous month
- Older months are represented in an encrypted manifest and marked available locally.
- Opening an old month hydrates that month on demand.
- Background hydration can restore old months later when policy allows.
- Search makes it clear when older archives are not fully restored yet.
- Realtime remains a wake-up signal; correctness comes from cursor-based pull.

## Supabase and control-plane changes

Added partitioned sync metadata and RPC support.

Implemented/added:

- `docs/supabase/009_partitioned_latest_first_sync.sql`
  - `sync_objects.partition_key`
  - `sync_objects.affected_partition_keys`
  - `sync_objects.operation_id`
  - `sync_objects.key_epoch`
  - partition head tracking
  - per-device partition cursors
  - partitioned restore RPCs
  - server-side sequence allocation support
  - idempotent operation handling
  - key epoch rotation support

- `docs/supabase/010_sync_gc_retention.sql`
  - retention/retirement RPC support for sync objects
  - cleanup helpers for old manifests, snapshots, partition snapshots, events, and key packages

Control-plane client updates include:

- Batch commit support through `commitSyncBatch`.
- Partition restore APIs.
- Partition cursor APIs.
- Key epoch rotation APIs.
- Sync object retirement APIs.
- Mapping support for new metadata fields.

## Partitioning, manifests, restore, and migration

Added partition-focused sync modules:

- `src/sync/syncPartitioning.ts`
  - derives partition keys
  - builds encrypted manifest payload input
  - encodes/decodes partition snapshots
  - filters repository snapshots by partition

- `src/sync/partitionedRestore.ts`
  - restores manifest-based accounts
  - imports core/recent partitions first
  - hydrates archive partitions on demand
  - falls back to legacy restore when no manifest exists

- `src/sync/partitionedMigration.ts`
  - lazily migrates existing local canonical data into core/monthly partition snapshots
  - uploads encrypted partition snapshots
  - uploads encrypted manifest
  - marks account partitioned only after successful manifest commit

## Sync engine changes

Updated `src/sync/eventSyncEngine.ts` for partitioned latest-first sync.

Implemented:

- Partition-aware write path.
- Partition-aware pull path.
- Hydrated partition cursors instead of relying only on one global cursor.
- Recent-first restore support.
- Archive month hydration.
- Background archive hydration.
- Background archive hydration retry/backoff for failed archive months.
- Migration trigger for primary devices when no manifest exists.
- Batch media/event commit support.
- Stable media reference support.
- Encrypted thumbnail upload support.
- Safe maintenance/GC invocation.
- Multi-epoch encryption support for event/media/snapshot objects.
- Key-package processing before replaying objects encrypted with a newer epoch.
- Global key-package scan for partitioned clients, since key packages are not monthly partition objects.

## Repository/cache changes

Repository APIs were extended for partition-aware local state.

Added/updated support for:

- Exporting/importing partition snapshots.
- Partition hydration state.
- Available archive month listing.
- Marking partitions as available, hydrating, hydrated, or failed.
- Failed archive hydration metadata:
  - `failedAt`
  - `failureCount`
  - `nextRetryAt`
- Per-partition cursor metadata.
- Durable sync outbox state.
- Sync media pointer metadata, including thumbnail and key epoch fields.
- Record version tracking for sync conflict detection.

## UI behavior changes

Updated UI paths to support latest-first and archive-aware behavior.

Implemented:

- Archive calendar/list behavior for unloaded months.
- Opening an unloaded month triggers hydration.
- Search screen notice when older archive data may not be restored yet.
- Search restore action for older archive data.
- Companion approval/revocation UI updates for key epoch rotation.

## Media and thumbnail changes

Media sync was hardened for large/long-lived accounts.

Implemented:

- Stable media references using media id + Drive file id.
- Legacy media reference compatibility.
- Lazy media download.
- Encrypted thumbnail payload support.
- Thumbnail metadata tracking.
- Media cleanup aware of stable references.
- Resumable Drive upload path for large encrypted objects.

## Security and key epoch changes

Implemented multi-epoch encrypted sync support.

Added:

- `key_epoch` metadata on encrypted objects.
- Encrypted object headers with key epoch awareness.
- Local secret storage for multiple account root keys.
- Helpers to fetch/set account root keys by epoch.
- Replay/restore support for decrypting objects with the correct epoch key.
- Companion key packages that include key epoch metadata.
- Key package authentication tied to account id, target device fingerprint, and key epoch.

Revocation/key rotation behavior:

- Revoking a companion rotates the account key epoch.
- Primary creates a fresh account root key for the new epoch.
- Revoked device cannot decrypt future epoch objects.
- Remaining trusted companions receive encrypted key packages for the new epoch.
- Partitioned companions scan global key-package objects before pulling newer partition events.

## Garbage collection and retention

Implemented sync maintenance planning for:

- Keeping latest manifests.
- Keeping latest partition snapshots per partition.
- Keeping safe event tails.
- Avoiding deletion of cross-partition events until every affected partition is covered.
- Retiring old sync objects through Supabase RPC.
- Identifying Drive files safe to delete.

## Vital hardening added after 8-year scenario review

After reviewing the 8-year-data scenario, three vital production hardening items were added:

- Archive hydration retry backoff.
- Clear failed-archive retry UI.
- Lightweight sync observability hooks.

Problem addressed:

- If an old archive month is corrupt, temporarily unavailable, rate-limited, or repeatedly failing, the app should not retry it on every polling cycle.
- Without backoff, background hydration could waste Google Drive/Supabase quota and repeatedly wake work that cannot succeed yet.

Implemented behavior:

- A failed archive partition now records:
  - when it failed
  - how many times it has failed
  - when it is next eligible for retry
- Background archive hydration skips failed months until `nextRetryAt`.
- Retry delay uses exponential backoff:
  - starts at 5 minutes
  - caps at 24 hours
- Successful hydration clears failure metadata.
- Manual restore attempts refresh archive state after failure so the UI immediately sees the failed/backoff metadata.
- Diary calendar now distinguishes:
  - archive month not downloaded yet
  - archive restore failed and needs retry
- Search now shows how many unloaded archive months need retry and labels failed-month actions as retry.
- Search now offers a manual "Restore all on Wi-Fi" action for users who want their archive locally searchable sooner.
- Bulk archive restore refuses likely cellular/slow connections and restores eligible archive months sequentially.
- Sync telemetry events are emitted for:
  - partitioned restore start/complete/failure
  - missing-manifest fallback
  - archive hydration policy decisions
  - archive hydration skipped reasons
  - archive partition hydration start/complete/failure
  - key package read/open/apply events
  - GC/maintenance plan and completion counts
  - Drive cleanup failures
- Telemetry is dependency-free:
  - emits `deardiary-sync-telemetry` browser events
  - supports an injectable sink for tests or future production telemetry
  - console logging is opt-in via `localStorage['deardiary.sync.debug'] = '1'`

Files changed for this hardening:

- `src/App.tsx`
- `src/components/DiaryDetailScreen.tsx`
- `src/components/SearchScreen.tsx`
- `src/types.ts`
- `src/repositories/localDiaryRepository.ts`
- `src/sync/partitionedRestore.ts`
- `src/sync/eventSyncEngine.ts`
- `src/sync/syncMaintenance.ts`
- `src/sync/syncTelemetry.ts`
- `src/repositories/localDiaryRepository.test.ts`
- `src/sync/eventSyncEngine.test.ts`
- `src/sync/syncTelemetry.test.ts`

## Tests added/updated

Coverage was added across the new design.

Key test areas:

- Partition key derivation.
- Partition snapshot encode/decode.
- Manifest encode/decode.
- Recent-first restore.
- Legacy v1 fallback.
- Lazy migration.
- Partition-aware pull.
- Background archive hydration policy.
- Background archive hydration retry/backoff.
- Batch commits.
- Stable media references.
- Encrypted thumbnails.
- Multi-epoch encryption/decryption.
- Companion key package epoch handling.
- Companion key package processing before newer epoch partition events.
- GC/retention safety.
- Supabase control-plane RPC mapping.
- Sync telemetry sink emission.

## Validation completed

The following validation commands passed:

```bash
npm.cmd run lint
npx.cmd tsx --test src\sync\eventSyncEngine.test.ts src\sync\companionKeyPackage.test.ts src\sync\companionPairing.test.ts src\sync\syncSecrets.test.ts src\sync\eventReplay.test.ts
npm.cmd run test:storage
git diff --check
```

`git diff --check` reported only Git line-ending warnings where applicable; no whitespace errors were reported.

## Operational follow-ups

Remaining rollout and production-readiness items:

### Supabase rollout

- Apply Supabase migrations `010_sync_gc_retention.sql` and `011_fix_pairing_digest.sql` if they have not already been applied.
- Verify the important RPCs in Supabase:
  - `commit_sync_batch`
  - `get_latest_restore_manifest`
  - `get_partition_restore_bundle`
  - `list_partition_objects_after`
  - `rotate_account_key_epoch`
  - `retire_sync_objects`

### Real-device/manual smoke testing

Test with real Supabase and Google Drive sessions:

- New account setup.
- Fresh login on a second device.
- Restore only `core`, current month, and previous month before opening the app.
- Open an old archive month on demand.
- Background archive hydration on Wi-Fi/charging.
- Create an entry with multiple photos.
- Edit an old entry.
- Move an entry from an old month to the current month.
- Web/desktop companion pairing.
- Companion revocation and key epoch rotation.
- Remaining trusted companion decrypts future key-epoch data.
- Revoked companion cannot decrypt future key-epoch data.

### Rollout safety

- Roll out dual-read clients before marking existing accounts partitioned.
- Keep old v1 snapshots/events through the migration retention window.
- Enable GC only after migration confidence is high.

### UI polish

- Implemented:
  - retry UI for failed archive month hydration
  - clear search state explaining that search covers downloaded archive data only
  - manual "Restore all on Wi-Fi" action
- Still optional:
  - richer per-month progress UI while bulk archive restore is running

### Production observability

Lightweight local telemetry hooks are now implemented. Remaining optional production work:

- Connect `setSyncTelemetrySink` to a real telemetry provider if/when the app has one.
- Decide whether to persist a small local diagnostics ring buffer for support/debug exports.
- Review telemetry fields before release to ensure no plaintext journal content or sensitive metadata is emitted.

### Future performance enhancements

Not urgent, but useful later:

- Encrypted archive search index:
  - keep plaintext search tokens out of Supabase
  - either hydrate local partitions for full search or add encrypted local/Drive search index partitions later
  - avoid implementing remote plaintext search
- Split very large months into smaller sub-partitions if real-world data shows monthly partitions are too large:
  - possible format: `month:YYYY-MM:week:<N>` or `month:YYYY-MM:range:<start>-<end>`
  - keep monthly manifest display while allowing sub-partition restore internally
- Local database/index tuning for search and calendar views.
- Smarter background hydration ordering, such as most recent old months first.
