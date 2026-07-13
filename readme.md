# Dear Diary

Dear Diary is a private journaling app for Android and linked web companions. It keeps readable journal content on trusted devices, uses a local PIN for day-to-day access, and can sync encrypted diary data across devices through Supabase metadata plus encrypted Google Drive `appDataFolder` objects.

Android is the primary standalone target. The web app currently opens as a companion-link surface when no encrypted sync account is stored locally; create or recover the primary account on Android first, then approve the browser from the primary device.

## Contents

- [Current Functionality](#current-functionality)
- [Core Flows](#core-flows)
- [Architecture](#architecture)
- [Performance and Local-First Data Flow](#performance-and-local-first-data-flow)
- [Storage and Privacy](#storage-and-privacy)
- [Encrypted Sync](#encrypted-sync)
- [Local Development](#local-development)
- [Android Development](#android-development)
- [Environment Variables](#environment-variables)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Known Limitations](#known-limitations)

## Current Functionality

### Journals and Entries

- Create multiple diaries with name, emoji, color, cover image, decorative icons, and optional diary lock.
- Create, edit, and delete dated entries with title, time, rich text, mood, tags, photos, and voice notes.
- Use single-entry writing or a timeline-style entry made from ordered time-stamped blocks.
- Format rich text with headings, emphasis, quotes, lists, and font controls.
- Use local reflection suggestions for mood, tags, and a short empathetic response. This is heuristic and local; journal text is not sent to an AI service.
- Record audio notes and dictate text when the platform microphone and speech services allow it.

### Reading, Search, and Reflections

- Browse entries newest-first with page navigation and swipe gestures. Common entry and note page queries use storage-backed filtering/paging where available.
- Open diary entries from table of contents or calendar views.
- Search entries and notes by title/body, tags, date range, mood, and photo presence.
- Keep locked-diary content out of Home, Search, and Reflections until that diary is unlocked for the current app session.
- View streaks, entry counts, mood distribution, tag usage, 30-day writing heatmap, photo memories, and year/month mood calendars.
- Restore older encrypted archive months on demand from diary calendar/search flows when a linked account has partitioned archive data that is not downloaded locally yet.

### Notes and Home

- Capture quick notes, pin them, tag them, edit them with rich text, and convert them into diary entries.
- Use the Home screen for greeting/profile context, daily word goal, writing streak, recent diaries, common tags, rotating prompts, and Quick Jot.

### Security and Settings

The Settings screen has four tabs:

| Tab | Current capabilities |
| --- | --- |
| Profile | Reconnect encrypted sync, approve pending web companions, revoke linked companions, and edit profile/avatar/daily target. |
| Security | Change the 4- or 8-digit app PIN, update the recovery question, inspect Google recovery identity, rotate the encrypted account recovery passphrase, and enable Android biometric unlock when available. |
| Backup | Inspect encrypted cloud storage usage, sync queue counts, failed/conflict state, network state, last cloud save time, recovery readiness, manually retry encrypted sync, and reset local journal content while keeping local security/account configuration. |
| Customize | Configure Android reminder preference/time, switch light/dark theme, and manage custom tags and moods. |

The old Settings controls for manual Drive backup scheduling and "Back up now" are no longer exposed in the React UI. The active cloud path is encrypted multi-device sync. Portable backup bundle utilities remain in code and tests, but the current user-facing Settings screen does not provide a manual local export/import flow.

## Core Flows

### First Android Launch

1. The bootstrap layer opens local storage, migrates legacy native media when needed, starts media cleanup, and loads settings/security/profile/sync state.
2. The user creates a 4- or 8-digit app PIN.
3. A local recovery question is required.
4. The user signs in with Google and creates or recovers an encrypted account using a recovery passphrase.
5. New accounts upload a recovery key package and initial encrypted snapshot. Existing accounts use the recovery passphrase to recover the account root key and perform two-phase primary recovery.
6. After setup, the app opens locked and starts normal local-first operation with encrypted sync available.

### Web Companion Link

1. The browser asks the user to continue with the Google account already linked to the primary mobile account.
2. The browser creates a companion pairing request and displays an 8-digit code.
3. The primary mobile device approves the code in Settings > Profile > Companion Devices.
4. The browser receives an encrypted key package, restores the encrypted diary state, and then opens as a linked companion.

### Unlocking and Relocking

- Every app mount starts locked.
- Unlock uses the app PIN, or Android biometric unlock when enabled.
- The navigation-bar lock button ends the authenticated session and clears diary-level unlocks.
- On native app resume, Dear Diary locks after being in the background for the configured privacy interval, currently five minutes.

### Forgotten PIN

- The lock screen can reset the PIN with the local recovery answer.
- A linked Google account can also verify recovery identity when available.
- Resetting the PIN disables enrolled biometric/passkey state; it can be enrolled again from Settings.

### Locked Diaries

- A locked diary uses the same app PIN or enabled biometric identity.
- Unlock is session-local; relocking the app forgets unlocked diary IDs.
- Diary locks are application access controls. They do not create a separate encrypted database or a separate diary-specific PIN.

### Companion Revocation

Only the primary mobile device can revoke a linked companion. Revocation requires the recovery passphrase because the primary rotates the encrypted account key epoch, writes a new recovery package, distributes key packages to remaining active companions, and only then finalizes revocation. A local PIN or biometric check proves local presence, but it does not prove the user can preserve account recovery after the key rotation.

## Architecture

```mermaid
flowchart TD
    UI[React screens] --> APP[App navigation and auth session]
    APP --> REPO[DiaryRepository]
    REPO --> STORE{Platform storage}
    STORE -->|Web companion| IDB[Encrypted IndexedDB]
    STORE -->|Android| SQL[Encrypted SQLite / SQLCipher]
    UI --> MEDIA[File/audio/security services]
    MEDIA -->|Web| WEBAPI[Browser APIs]
    MEDIA -->|Android| NATIVE[Capacitor plugins and app-private files]
    REPO --> SYNC[EventSyncEngine]
    SYNC --> SUPA[Supabase control plane]
    SYNC --> DRIVE[Google Drive appDataFolder encrypted objects]
```

`App.tsx` owns in-memory navigation instead of React Router. Top-level tabs are Home, Diaries, Notes, Search, Reflections, and Settings. Nested screens include diary detail, diary settings, entry editor, app settings, and lock state.

All application writes go through the async `DiaryRepository`. Local writes are serialized to avoid overlapping update loss. When encrypted sync is configured, `syncingDiaryRepository` applies normal diary, entry, note, settings, and profile changes locally first, enqueues a durable sync outbox operation in the same local batch, emits typed repository change events, returns to the UI, and then requests background sync.

`App.tsx` still owns global auth/navigation/theme/toast/sync state, but normal navigation no longer triggers a full repository reload. Screens use targeted repository queries and typed change events to patch or requery the affected diary, entry, note, or settings data.

The Express server is intentionally small:

- `npm run dev` starts Express with Vite middleware.
- Production serves the built `dist` directory with SPA fallback.
- `GET /api/health` returns `{ "status": "ok", "offline": true }`.
- There are no journal CRUD, auth, AI, or backup APIs on the server.

## Performance and Local-First Data Flow

Dear Diary is being refactored toward local-first performance while preserving the existing encrypted sync and recovery model.

Current local-first behavior:

- Normal synced writes commit to encrypted local storage plus a durable outbox row before returning to the UI.
- Cloud work runs in background flush/pull/ack flows. Local save paths do not wait for Supabase, Google Drive, remote pulls, snapshot compaction, media upload, or online checks.
- Successful remote acknowledgement updates local record versions, cursors, media pointers, and sync status without rewriting the already-applied user record.
- Conflict recovery preserves the original outbox payload, pulls the latest remote state, creates recovered entry/note copies when needed, queues those copies as local-first operations, and surfaces non-blocking warnings.
- Entry lists no longer eagerly hydrate every encrypted sync media reference. `SyncedImage` and rendered audio controls resolve media lazily, dedupe in-flight work, and use bounded memory caches.

Structured local storage:

- Android mirrors diary, entry, block, note, media, settings/profile, sync account, record version, media pointer, partition hydration, and outbox data into typed encrypted SQLite tables. Common diary/entry/note reads and simple entry/note page queries can use SQL rows instead of rebuilding whole arrays.
- Web writes diaries, entries, notes, settings/profile/security metadata, sync account metadata, record versions, media pointers, partition hydration state, and outbox rows into dedicated encrypted IndexedDB record stores. Compatibility key-value rows are still written for rollback/import/export, but structured stores are preferred once ready.
- Full-text/tag entry and note search still materializes local encrypted records so sanitizer-aware plain-text matching remains unchanged.

Development-only instrumentation is available through `measureAsync` and `measureSync`. In a development browser session, inspect:

```js
window.dearDiaryPerformance.aggregates()
window.dearDiaryPerformance.samples()
```

Use `window.dearDiaryPerformance.reset()` between scenarios. Measurement metadata must stay redacted: never pass diary body text, note text, titles, tokens, keys, PINs, passphrases, recovery answers, raw media bytes, or raw media URIs.

Generate benchmark-scale local data with:

```bash
npm run benchmark:seed
```

See [docs/performance.md](docs/performance.md) and [docs/local-first-performance.md](docs/local-first-performance.md) for measurement workflow, current implementation notes, rollback notes, and remaining risks.

## Storage and Privacy

| Concern | Web companion | Android |
| --- | --- | --- |
| Journal/settings/security records | Encrypted IndexedDB with record-level repository stores | Encrypted SQLite / SQLCipher with typed repository tables |
| Photos, covers, audio | Browser storage/data references | App-private files under Capacitor `Directory.Data` |
| SQLite secret | Not applicable | Random secret in OS-backed Capacitor Secure Storage |
| Legacy Preferences | Not applicable | Migration input only; SQLite is authoritative after migration |
| UI-only diary layout | `localStorage` | Mirrored through Preferences, then hydrated into `localStorage` |

PINs are stored as salted SHA-256 hashes. Recovery answers are normalized, salted, and stored with PBKDF2 using 120,000 iterations. Rich text is sanitized before persistence, import, sync replay, and display.

Clearing browser site data or Android app storage deletes local diary data and security material. Android clear storage or uninstall is destructive unless the encrypted account can be recovered from cloud sync or another trusted device.

## Encrypted Sync

Encrypted sync uses:

- Supabase for account/device metadata, cursors, object hashes, and Drive file pointers.
- Google Drive `appDataFolder` for encrypted events, media, thumbnails, snapshots, partition snapshots, manifests, and key packages.
- Client-side account root keys; plaintext journal data is not stored in Supabase or Google Drive by application code.

Important sync behavior:

- User writes are staged locally first with durable outbox operations, then uploaded as encrypted events and media by background sync.
- Background fallback polling runs periodically, while local saves, reconnect, unlock, realtime, and manual retry request immediate/coalesced outbox flushes.
- Drive object bytes are checked against Supabase SHA-256 metadata before decrypting/applying.
- Latest-first restore loads core data and recent months first, then marks older monthly partitions as available for on-demand hydration.
- Primary mobile recovery and companion revocation are two-phase flows so old devices are not revoked until restore/package distribution succeeds.
- See [docs/sync-and-supabase.md](docs/sync-and-supabase.md) for the operational runbook.

The controlled Sync V2 client runtime lives under `src/sync/v2`. It provides protocol bootstrap,
leased operation processing, bounded and verified object transfer, lost-response reconciliation,
ordered atomic replay, persistent safety stops, and stable conflict records. Configure its Spring
Boot endpoint with `VITE_SYNC_V2_API_URL`. The existing Supabase/Drive engine remains available while
the explicit V1-to-V2 account migration workflow is still disabled.

Google Drive integration uses the scope:

```text
https://www.googleapis.com/auth/drive.appdata
```

## Local Development

Prerequisites:

- Node.js and npm compatible with the checked-in lockfile.
- A modern browser.
- Docker only when running Supabase integration tests.
- Android Studio/JDK only when building or testing Android.

Install and run:

```bash
npm ci
npm run dev
```

Open `http://localhost:3000`.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Express with Vite middleware. |
| `npm run lint` | Run TypeScript checks with unused-code guardrails. |
| `npm run test:storage` | Run repository, domain, security, sync, and backup utility tests. |
| `npm run test:component` | Run Vitest component tests. |
| `npm run test:server` | Run Express server tests. |
| `npm run test:supabase` | Run Docker-backed Supabase/RPC integration tests. |
| `npm run test:e2e` | Run Playwright end-to-end tests. |
| `npm run scan:secrets` | Scan for committed secrets/generated artifacts. |
| `npm run benchmark:seed` | Generate a large local benchmark fixture for timing captures. |
| `npm run build` | Build the Vite client and bundled Node server. |
| `npm run start` | Start `dist/server.cjs`; set `NODE_ENV=production` for static serving. |

## Android Development

The Android project is already present; do not run `cap add android` for a normal checkout.

Common workflow:

```bash
npm ci
npm run mobile:sync
npm run android:studio
```

Run on a connected target:

```bash
npm run android
```

Create a debug APK from PowerShell:

```powershell
npm run mobile:sync
Set-Location android
.\gradlew.bat assembleDebug
```

Native debug inspection is disabled by default. For local inspection only:

```powershell
$env:CAPACITOR_WEBVIEW_DEBUG='true'
npm run mobile:sync
```

Release helpers:

```bash
npm run assets:generate
npm run android:lint
npm run android:test
npm run android:release
npm run android:bundle
```

## Environment Variables

Copy `.env.example` to `.env` for Google/Supabase-backed sync. Vite only exposes `VITE_` variables to client code.

| Variable | Required for | Notes |
| --- | --- | --- |
| `VITE_GOOGLE_WEB_CLIENT_ID` | Google sign-in and Drive `appDataFolder` access | Use the OAuth Web application client ID, not the Android client ID. |
| `VITE_SUPABASE_URL` | Encrypted sync | Supabase project URL. Apply `docs/supabase/001` through `docs/supabase/018` first. |
| `VITE_SUPABASE_ANON_KEY` | Encrypted sync | Supabase anon key. |
| `VITE_ENABLE_MD_FLOW_HOOKS` | Manual MD-021/MD-022 force-stop testing only | Never enable in release builds. |
| `VITE_APP_VERSION` | Optional | Version recorded in backup/sync metadata where used. |
| `CAPACITOR_WEBVIEW_DEBUG` | Optional Android build-time setting | Enables Android WebView inspection when exactly `true`. |
| `CAPACITOR_BRIDGE_LOGGING` | Optional Android build-time setting | Enables verbose bridge logging; keep off for sync/recovery tests. |
| `CAPACITOR_DEBUG` | Optional legacy build-time setting | Also enables WebView inspection when exactly `true`; prefer `CAPACITOR_WEBVIEW_DEBUG`. |
| `DISABLE_HMR` | Optional development setting | Disables Vite HMR/file watching when exactly `true`. |
| `NODE_ENV` | Production server | Set to `production` when serving built assets through `npm run start`. |

Never commit `.env`; the repository ignores `.env*` files except `.env.example`.

## Testing

Recommended local validation:

```bash
npm run lint
npm run test:storage
npm run test:component
npm run test:server
npm run scan:secrets
npm run build
```

Additional suites:

- `npm run test:supabase` requires Docker and applies every SQL migration in `docs/supabase` in numeric order.
- `npm run test:e2e` and `npm run test:accessibility` require Playwright browser setup.
- `npm run android:test` and `npm run android:lint` require the Android toolchain.
- `npm run benchmark:seed` creates `benchmarks/dear-diary-seed.json` by default for repeatable performance captures.

The automated suite covers repository semantics, local-first mutation/outbox atomicity, storage-backed query behavior, security hashing/recovery, rich-text sanitization, encrypted sync events, snapshots, partitioned restore, companion pairing, key rotation/revocation, media handling, backup utility validation, component behavior, and server API boundaries.

Latest audit status is recorded in [docs/testing/TEST_RESULTS.md](docs/testing/TEST_RESULTS.md), [docs/testing/BASELINE.md](docs/testing/BASELINE.md), and [docs/testing/KNOWN_RISKS.md](docs/testing/KNOWN_RISKS.md). As of 2026-07-12, `npm.cmd run test:all`, `benchmark:seed`, and `benchmark:run` passed locally; Docker-backed Supabase coverage applies migrations `001` through `018`; Android unit/lint passed; and emulator evidence covers the feasible non-secret native paths documented in [docs/testing/MANUAL_DEVICE_TESTS.md](docs/testing/MANUAL_DEVICE_TESTS.md).

Physical-device QA remains necessary for full Google consent/Drive breadth, Android biometric success/cancel/failure, visible camera/microphone/speech/notification permission prompts, SQLCipher/legacy-media migration under interruption and low storage, real elapsed-time app background privacy lock, Android clear-storage recovery, real pending-outbox/media-upload resume, remaining primary-recovery permutations, and real multi-device sync conflict/recovery scenarios.

## Project Structure

```text
.
|-- src/
|   |-- AppBootstrap.tsx              # storage/migration startup gate and web companion routing
|   |-- App.tsx                       # auth session, navigation, lock state, sync resume
|   |-- components/                   # lock, home, diary, editor, notes, search, stats, settings
|   |-- domain/                       # security, catalog, rich-text, locks, merge/storage calculations
|   |-- repositories/                 # async repository, syncing wrapper, defaults
|   |-- sync/                         # encrypted sync, Supabase control plane, pairing, recovery, key rotation
|   |-- platform/
|   |   |-- storage/                  # encrypted IndexedDB, Preferences migration, encrypted SQLite
|   |   |-- filesystem/               # web/native file storage
|   |   |-- audio/                    # recording abstractions
|   |   |-- security/                 # native biometric / WebAuthn abstractions
|   |   `-- drive/                    # Capacitor bridge type for native Drive plugin
|   |-- mobile/                       # Capacitor bootstrap, reminders, media persistence/cleanup
|   `-- utils/                        # backup bundle utilities, Google auth/profile, WebAuthn helpers
|-- android/                          # Android Studio project and native Drive/biometric/storage integration
|-- docs/
|   |-- performance.md               # performance measurement and benchmark fixture workflow
|   |-- local-first-performance.md   # current local-first refactor notes and remaining risks
|   |-- mobile-capacitor.md           # native implementation notes
|   |-- sync-and-supabase.md          # encrypted sync runbook
|   `-- supabase/                     # ordered SQL migrations 001-018
|-- server.ts                         # Express/Vite development and static production server
|-- vite.config.ts                    # Vite, React, Tailwind, alias, HMR config
|-- capacitor.config.ts               # Capacitor app/native settings
`-- package.json                      # scripts and dependencies
```

Important entry points:

- `src/main.tsx` renders React and starts Capacitor bootstrap behavior.
- `src/AppBootstrap.tsx` prevents the UI from opening before local state is usable.
- `src/repositories/localDiaryRepository.ts` owns local CRUD, snapshots, migrations, and reset behavior.
- `src/repositories/syncingDiaryRepository.ts` wraps normal writes with local-first durable outbox behavior.
- `src/sync/eventSyncEngine.ts` owns encrypted event upload, pull, restore, archive hydration, and maintenance.
- `src/sync/accountBootstrap.ts` owns encrypted account creation and primary mobile recovery.
- `src/components/CompanionApprovalPanel.tsx` owns companion approval and revocation UI.
- `src/platform/storage/nativeSQLiteDataStore.ts` owns native encrypted SQLite schema and Preferences migration.
- `src/platform/storage/webLocalDataStore.ts` owns encrypted IndexedDB record stores and web compatibility rows.
- `src/utils/performance.ts` owns redacted development timing instrumentation.

## Known Limitations

- Android is the complete primary native target. The repository has Capacitor iOS dependencies/scripts, but no committed `ios/` native project and no iOS-specific Drive background scheduler.
- Web is currently a linked companion experience. A standalone web-only first-run diary is not the active flow.
- The Settings UI currently exposes encrypted sync status and recovery readiness, not manual Drive backup scheduling/export controls.
- Legacy Android Drive backup worker/plugin code still exists, but the current React app path uses encrypted event sync as the user-facing cloud feature.
- Web storage is protected by browser-origin encrypted storage, not by a hardware-backed OS secret.
- Compatibility key-value rows are still written for rollback/import/export while record-level storage continues to mature.
- Native write-side mutation logic still serializes collection payloads before mirroring into typed SQL tables; a fully native CRUD repository is remaining work.
- Full-text/tag search still scans local encrypted records in memory to preserve sanitizer-aware matching.
- Diary cover images still hydrate eagerly in book-cover backgrounds; visible-image lazy loading is already used for entry/media images.
- Browser speech recognition varies by browser and may depend on browser-provided services. Android dictation requires an installed speech-recognition service.
- Media cleanup is eventual; newly unreferenced files get a grace period to protect unsaved drafts.
- Android Settings > Apps > Dear Diary > Clear storage is destructive. Recovery depends on another trusted synced device or successful encrypted account recovery.
