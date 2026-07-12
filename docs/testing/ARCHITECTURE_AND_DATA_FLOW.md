# Architecture And Data Flow

## Application Bootstrap

`src/main.tsx` mounts `AppBootstrap` and runs Capacitor UI setup. `AppBootstrap` hydrates native UI preferences, initializes the repository, migrates legacy data-URI media, starts media garbage collection, and loads settings, security, profile, and local sync account state. On web, no local sync account means the first screen is `WebCompanionLink`; native/mobile proceeds into `App`.

## Lock And Unlock Lifecycle

`App` starts unauthenticated. `LockScreen` creates or unlocks the local PIN and recovery-question config stored through the repository. Unlock reloads local data, clears per-diary unlocks, marks the app authenticated, and starts encrypted sync polling if a sync account exists. Manual lock, device revocation, and native background/resume privacy lock stop polling, clear unlocked diary IDs, and return to the lock screen.

Locked individual diaries are protected by session-only `unlockedDiaryIds`. Home, search, and statistics receive `accessibleEntries`, which excludes entries belonging to still-locked diaries.

## Web And Native Storage Boundaries

Web storage uses encrypted IndexedDB through `WebEncryptedKeyValueStore`. `WebLocalDataStore` migrates legacy plaintext localStorage records into encrypted IndexedDB and removes the plaintext keys. Native storage uses encrypted SQLite through `nativeSQLiteDataStore` and native file storage for media. Native diary, entry, and note list/get reads prefer typed SQL rows when the migration mirror is available.

Web repository collection data is also mirrored into encrypted record stores for diaries, entries, notes, sync versions, media pointers, partition hydration, and outbox operations. Repository list/get methods prefer those structured stores when ready; direct diary, entry, and note lookups can read one record while compatibility key-value rows remain available for rollback and import/export. Entry and note screen page queries use optional storage-backed query methods when available, falling back to repository filtering for full-text/tag search and unsupported stores.

Allowed localStorage use remains limited to UI preferences, sync debug flags, transient Google auth intent, and test fallback when no browser storage exists.

## Repository Write Flow

UI components call `diaryRepository`, which wraps `LocalDiaryRepository` with sync-aware behavior. Normal synced writes are local-first: rich text is sanitized, the local encrypted record change and durable outbox operation are written in one serialized local batch, diary statistics are updated, typed repository change events are emitted, and the saved object is returned to the UI before cloud work starts.

## Sync Write Flow

Background sync enters `EventSyncEngine.flushPendingOutbox` or polling/realtime pull paths. The engine opens sync runtime when online, asserts active device status, resumes pending outbox operations, encrypts media/events with the active epoch root key, commits Drive object metadata to Supabase, acknowledges already-local mutations by updating versions/cursors/media pointers, and schedules snapshot compaction as best-effort work. The legacy `commitMutation` path remains for explicit sync internals and tests during the migration.

## Outbox Stages

User writes persist through:

`prepared` -> `media_uploading` -> `media_uploaded` -> `event_uploading` -> `event_uploaded` -> `metadata_committing` -> `committed` -> `applied`, with `failed` and `conflict_preserved` terminal states for retryable failures and preserved conflicts.

Failed retryable operations persist `retryCount`, `lastErrorAt`, `nextRetryAt`, and `error`. Startup, polling, reauthorization, and new writes call `resumeUserWriteOutbox`; failed operations wait for bounded exponential backoff and do not block unrelated later operations.

## Google Drive Object Flow

Drive `appDataFolder` stores encrypted recovery key packages, companion key packages, snapshots, partition manifests, partition snapshots, events, media, and thumbnails. Object bytes are hashed before Supabase metadata commit. Media and event upload paths use deterministic appProperties so some crash-after-upload cases can discover already uploaded objects.

## Supabase Metadata Flow

Supabase stores accounts, devices, device cursors, partition heads/cursors, sync object metadata, pairing sessions, recovery attempts, key rotations, and revocations. RPCs enforce active-device or restore-read-device state. Pending recovery devices may read restore metadata but cannot commit normal sync objects.

## Snapshot And Partition Restore

Primary devices can migrate to partitioned sync by uploading a manifest plus core/recent/monthly partition snapshots. Restore prefers manifest-driven core and recent partitions, marks older months available, and hydrates archives on demand or by background policy.

## Primary Recovery

Existing mobile-account recovery unwraps the latest recovery package, creates a pending primary device through `begin_primary_mobile_recovery`, restores local content, stores sync secrets, downloads latest partitions or snapshot/tail, updates cursors, and finalizes only when restored sequence matches the server sequence. Normal thrown-error rollback aborts the pending attempt and restores previous local content, settings, sync state, and secrets.

Server migration `014` now also prevents more than one pending primary recovery per account.

The client writes a pending-primary-recovery journal to encrypted sync secret storage immediately after the server registers the pending primary. The journal stores derived local security config, Drive backup metadata, device keys, sessions, and the recovered root key, but not the recovery passphrase, PIN, or recovery-answer plaintext. On retry or unlock, the client resumes local restore, cursor update, stale-tail replay, or already-finalized cleanup before normal sync polling starts.

Server migration `018` makes primary recovery finalization retry-safe after server-side completion, so a client that stops after the server commits recovery can retry finalize and receive the finalized account/device/attempt state.

## Companion Pairing

Web companions create a pairing session with an eight-digit code and public key bundle. The primary approves by creating an encrypted restore point and publishing a companion key package. The companion polls for approval, unwraps keys, restores data, and persists local sync state.

## Device Revocation And Key Rotation

Companion revocation is two-phase. The primary verifies the recovery passphrase, begins a key rotation, uploads a recovery key package and companion packages for surviving devices, stores the future key locally, finalizes the rotation, promotes local epoch state, updates cursors, and refreshes device lists. The production UX now uses an in-app masked passphrase dialog rather than `window.prompt`.

The client also writes a pending-rotation journal to the encrypted sync secret store. The journal includes the future epoch key but never the recovery passphrase. On unlock and companion-device refresh, the primary resumes committed package work, promotes an already-finalized server rotation, or safely aborts a begun rotation that has not committed a recovery package.

## Media Upload, Caching And Garbage Collection

Media is uploaded before its owning event, referenced by stable sync media references, cached locally on restore, and tracked in sync media pointers. Garbage collection keeps live media, thumbnails, and objects referenced by pending operations.

## Account And Session Reauthorization

Sync runtime refreshes Supabase sessions where refresh tokens exist and emits `deardiary-sync-auth-required` for expired or missing authorization. Native Google Drive sessions are restored through native auth; web companion sessions use web sync auth helpers.

## Trust And Plaintext Boundaries

Plaintext journal content should exist only in process memory, sanitized React state, encrypted local stores after write, and decrypted backup/sync payloads during active operations. Supabase receives metadata only, not plaintext diary content. Google Drive receives encrypted object bytes. PINs, passphrases, root keys, OAuth tokens, and recovery answers must not be logged or persisted outside their designated secure stores.
