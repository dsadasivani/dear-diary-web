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

- Native SQLite still receives compatibility key-value payloads from `LocalDiaryRepository`, but table mirroring is now incremental and record-level mutation APIs can write entry, note, diary, version, media, partition, and outbox rows without serializing full collections for normal CRUD paths. Diary, entry, block, note, media, settings/profile, sync account, sync record version, sync media pointer, partition hydration, and sync outbox data are mirrored into typed SQLCipher tables and read back from those tables when present. Repository list/get paths can read typed diary, entry, and note SQL rows directly, and entry/note page and search queries can filter, sort, count, and page through SQL/FTS without rebuilding full collections.
- Native SQLite now enables foreign-key enforcement on initialization, migrates entries and entry blocks into FK-backed tables, verifies `PRAGMA foreign_key_check`, and uses triggers/checks to reject invalid media owners and invalid sync record/outbox record types.
- Web IndexedDB now writes diaries, entries, notes, settings/profile/security metadata, sync account metadata, record versions, media pointers, partition hydration state, and sync outbox rows into dedicated encrypted record stores in the same IndexedDB transaction as the compatibility key-value row. Repository list/get paths prefer the structured record API once readiness metadata is present; direct diary, entry, and note lookups can read one encrypted record without rebuilding the compatibility array. Entry/note filters and pagination use IndexedDB metadata index stores, with keyed blind tokens for tags, mood, title/body search terms, and note search terms so sensitive searchable text is not stored as readable index data.
- Existing full snapshot import/export APIs remain available for backup, restore, and partition flows.
- The 10k-entry/10k-note benchmark baseline is recorded in `docs/benchmarks/local-first-10k-baseline-2026-07-11.md`.

## Rollback Notes

- The compatibility key-value records are still written, so rollback to the previous repository implementation can read existing data.
- Native migration remains fail-closed: SQLite initialization/encryption failures must not fall back to plaintext runtime writes.
- Do not delete legacy key-value records until record-level native and web repositories have shipped and rollback is no longer required.

## Remaining Risks

- Compatibility key-value records are still written for rollback and snapshot flows, so full replace/import/export paths can still parse large JSON payloads even though normal screen queries and local mutation paths use structured storage where available.
- Web IndexedDB range/sort metadata such as dates, update timestamps, booleans, and opaque record IDs remains queryable metadata by design. Sensitive search/tag/mood terms are stored as keyed blind tokens, but physical browser-profile compromise should still be treated as high risk until OS/device protections are included in release validation.
- Conflict handling for already-uploading local-first operations preserves the latest outbox state, but multi-device stale-write flows still need physical-device validation.
- Diary cover images still hydrate eagerly because the existing book-cover UI paints them as CSS backgrounds. Converting those covers to media-aware image components is part of the remaining UI data-flow cleanup.
- Real Google Drive OAuth, Supabase realtime, force-stop recovery, media upload crash recovery, SQLCipher migration, biometrics, and low-storage paths require Android emulator or physical-device validation.
