# Local-First Performance Refactor Notes

## Current Implementation

- Normal synced diary, entry, note, settings, and profile writes now apply to the encrypted local repository first and enqueue a durable sync outbox operation in the same serialized stored batch.
- The UI-facing syncing repository schedules background outbox flushing and does not await Google Drive, Supabase, remote pulls, media upload, snapshot compaction, or network availability before returning from normal saves.
- Successful background sync acknowledgements update local record versions and account cursors without replaying the already-applied user record.
- Repository change notifications include typed events so screens can patch affected state. Legacy revision listeners remain supported during migration.
- `App.tsx` no longer reloads all repository data on navigation. Legacy refresh callbacks have been narrowed to entries, diaries, or notes where practical.
- Native SQLite mirroring no longer deletes and reinserts all diary, entry, block, note, and media rows for each collection write. It diffs by ID and updates only changed rows plus affected child rows.
- `SyncedImage` lazily hydrates sync media references when visible, dedupes in-flight requests, and keeps a bounded memory cache.
- Entry list reads no longer hydrate every attached sync media reference. Visible images and rendered audio controls resolve encrypted media references on demand with bounded in-memory caches.
- The Backup settings tab shows local sync queue counts, failed/conflict counts, network state, and a manual encrypted sync retry action without exposing operation IDs or payload contents.
- Background fallback polling runs every 90 seconds; local saves, reconnect, unlock, realtime, and manual retry still request immediate/coalesced outbox flushes.
- New encrypted account setup returns after the recovery key, initial encrypted snapshot, local account state, and local secrets are durable. Partitioned-sync migration is left to the existing background retry path instead of blocking the passphrase screen.
- Development performance instrumentation is available through `window.dearDiaryPerformance` for repository, SQLite, app bootstrap, screen mounts, sync outbox, Supabase RPC, Drive operations, crypto, media reads/cache, and thumbnail generation.

## Data And Migration Direction

- Native SQLite still receives compatibility key-value payloads from `LocalDiaryRepository`, but table mirroring is now incremental. Diary, entry, block, note, media, settings/profile, sync account, sync record version, sync media pointer, partition hydration, and sync outbox data are mirrored into typed SQLCipher tables and read back from those tables when present. Repository list/get paths can read typed diary, entry, and note SQL rows directly, and simple entry/note page queries can filter, sort, count, and page through SQL without rebuilding full collections. The next step is moving normal CRUD execution fully into a native repository implementation.
- Web IndexedDB now writes diaries, entries, notes, settings/profile/security metadata, sync account metadata, record versions, media pointers, partition hydration state, and sync outbox rows into dedicated encrypted record stores in the same IndexedDB transaction as the compatibility key-value row. Repository list/get paths prefer the structured record API once readiness metadata is present; direct diary, entry, and note lookups can read one encrypted record without rebuilding the compatibility array, and simple entry/note page queries run over encrypted record-store collections instead of the compatibility row.
- Existing full snapshot import/export APIs remain available for backup, restore, and partition flows.

## Rollback Notes

- The compatibility key-value records are still written, so rollback to the previous repository implementation can read existing data.
- Native migration remains fail-closed: SQLite initialization/encryption failures must not fall back to plaintext runtime writes.
- Do not delete legacy key-value records until record-level native and web repositories have shipped and rollback is no longer required.

## Remaining Risks

- Native SQLite still parses full collection JSON for write-side compatibility and unsupported metadata reads. Direct diary, entry, and note lookups now use SQL rows, but write-side mutation logic still runs through collection payloads until a native repository implementation lands.
- Full-text/tag entry and note search still materializes encrypted record collections so it can preserve sanitizer-aware plain-text matching. More selective cursor/index-backed search remains future work.
- Conflict handling for already-uploading local-first operations preserves the latest outbox state, but multi-device stale-write flows still need physical-device validation.
- Diary cover images still hydrate eagerly because the existing book-cover UI paints them as CSS backgrounds. Converting those covers to media-aware image components is part of the remaining UI data-flow cleanup.
- Real Google Drive OAuth, Supabase realtime, force-stop recovery, media upload crash recovery, SQLCipher migration, biometrics, and low-storage paths require Android emulator or physical-device validation.
