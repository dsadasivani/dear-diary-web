# Dear Diary Mobile - Capacitor

Dear Diary now runs inside a Capacitor native shell while keeping the existing Vite React app as the UI. Android is the first supported native target. iOS support is dependency and script ready, but the iOS native project should be generated on macOS.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the web bundle:
   ```bash
   npm run build
   ```
3. Sync native assets and plugins:
   ```bash
   npm run cap:sync
   ```

On Windows PowerShell, use `npm.cmd` and `npx.cmd` if script execution policy blocks `npm.ps1`.

## Android

Open Android Studio:

```bash
npm run android:studio
```

Run on a connected emulator/device:

```bash
npm run android
```

The Android app uses the built `dist` bundle copied into `android/app/src/main/assets/public`. It does not require the Vite dev server for production builds.

## iOS

iOS dependencies are installed, but the native iOS project is not generated in this Windows-first phase. On macOS, run:

```bash
npm run cap:add:ios
npm run cap:sync
```

Then open the generated iOS project with Xcode.

## Google Drive Backup Notes

- Dear Diary is local-first. Device storage is the source of truth; Google Drive is used only for scheduled/on-demand backup and restore, never record synchronization.
- Drive backups use the `https://www.googleapis.com/auth/drive.appdata` scope and are stored in the hidden Google Drive `appDataFolder`.
- Drive backups can optionally be end-to-end encrypted with a separate passphrase. The random master key is cached in Android secure storage for background work; the passphrase is never stored and cannot be reset. Legacy/plaintext backups remain supported.
- The linked Google identity is persisted in Android Keystore-protected storage and SQLite. OAuth access tokens are never persisted; `AuthorizationClient` obtains fresh account-specific authorization before Drive work.
- Automatic backup supports Off, Daily, or Weekly with a preferred local time and Wi-Fi-only or any-network policy. Android WorkManager may delay the preferred time for Doze or unmet constraints.
- Backups are atomically staged in app-private storage before upload. The worker uses resumable Drive uploads, exponential retry, and retention of the five newest successful bundles.
- Backup lineage records the device, portable content revision, and parent backup. After restore, the new device creates a checkpoint; an older device cannot silently replace that lineage through automatic backup.
- Backup discovery offers Replace, Safe Merge, or Keep Local. Safe Merge never deletes local content and preserves divergent records as recovered copies; snapshot deletions are not synchronized.
- Choosing Continue Local after discovering an existing cloud backup blocks cloud writes until the user explicitly chooses Start Fresh From This Device.
- Existing Firestore data from older builds is left untouched, but the app no longer reads or writes Firestore.

### Google Cloud Configuration

1. Enable Google Drive API in the same Google Cloud project as the OAuth clients.
2. Configure the OAuth consent screen and add development accounts as test users until the app is published/verified.
3. Create an Android OAuth client for package `com.deardiary.app` and every signing SHA-1 used for debug or release builds.
4. Set `VITE_GOOGLE_WEB_CLIENT_ID` to the project's Web application OAuth client ID, then rebuild and run `npm run cap:sync`.

Missing Drive API enablement produces a clear API-disabled backup error. Revoked consent or a removed account moves the connection to reauthorization-required state; ordinary navigation and process restarts do not require reconnection.

## Phase 2 Progress

- Native builds load all journal, settings, profile, security, and backup metadata through the async repository. Diary data is no longer hydrated into `localStorage`; only the non-sensitive diary view preference is mirrored for the UI.
- Native storage is now backed by encrypted SQLite through `@capacitor-community/sqlite` with SQLCipher enabled in Capacitor config.
- The SQLite encryption secret is generated on device and stored through `@aparajita/capacitor-secure-storage`; the SQLite plugin also receives the secret for encrypted database access.
- On first migrated native launch, existing Capacitor Preferences values are copied into SQLite, collection counts are verified, and only then is migration marked complete. Preferences are retained as a one-release fallback.
- All diary, entry, note, settings, profile, security, Drive metadata, manual export, and Drive restore operations use the serialized async repository.
- SQLite maintains normalized tables for `diaries`, `entries`, `entry_blocks`, `notes`, `media_assets`, `app_settings`, `user_profile`, and `storage_meta`. Its internal `kv_store` is retained only as a migration/format compatibility record, not as a UI data source.
- Multi-record snapshot restores use one native SQLite transaction, preventing partially restored application state.
- PIN verification and recovery cryptography are pure in-memory operations; only completed security state is persisted. One linked Google account is used for both hidden Drive backup and Google PIN verification; the local recovery question remains available.
- Legacy native cover, photo, and audio data URIs are moved to app-private files on startup. The migration records counts and retries on the next launch if any file could not be written.
- Google Drive backup creates portable schema-v2 zipped snapshots with manifest, JSON data, and media files in Drive `appDataFolder`. PIN hashes, recovery answers, biometric state, OAuth state, runtime metadata, and SQLite secrets are excluded.
- The first-run security flow is PIN, mandatory local recovery question, and then Link Google Account or Stay Local. Linking checks for the latest compatible hidden backup and offers restore using only its date and size.
- Restoring uses repository `replace-portable`: journal data, profile, portable appearance/catalog settings, and media are restored while the new device's PIN, recovery question, biometrics, permissions, and account link are retained. Schema-v1 bundles remain accepted with their old security/Drive metadata ignored.
- Native reminder settings schedule or cancel a daily Local Notifications reminder when app settings are saved.
- New diary cover images, diary settings cover updates, entry photos, and entry audio are written through Capacitor Filesystem on native and remain data URIs on web.
- Native media garbage collection scans repository references after changes, protects unsaved drafts with a 24-hour grace period, and removes unreferenced app-owned files immediately after reset/replacement restore.
- Android biometric unlock uses `@capgo/capacitor-native-biometric` and requires an enrolled strong biometric, such as fingerprint, plus an app PIN fallback.
- Android voice notes use `@independo/capacitor-voice-recorder`; toolbar voice-to-text uses native speech recognition without starting the recorder so it does not compete for the microphone. Android cannot reliably run `MediaRecorder` and `SpeechRecognizer` on the same microphone session, so native voice notes save audio only while the separate voice-to-text control inserts dictated text.

## Known Limitations

- The legacy media migration needs physical-device QA with large photo/audio libraries and interrupted launches before the fallback can be retired.
- Android is the complete background-backup target. iOS still uses local export/import until an equivalent native scheduler and authorization bridge are implemented.
- Android Settings > Apps > Dear Diary > Clear storage is destructive. It deletes local diary data, encrypted SQLite, secure storage secrets, Preferences, Google backup link metadata, and the app PIN hash/salt. Android OS backup/device transfer is disabled to avoid restoring encrypted SQLite without its key; use Drive or a `.ddbackup` archive.
- Native speech recognition depends on Android speech services and microphone permission. If unavailable, the app shows a graceful message; audio recording still works through the native recorder.
- Branded adaptive launcher icons, round icons, and light/dark splash assets are generated from the gold book-and-quill artwork. Verify the rendered assets on physical target densities before store release.

## Release Checklist

- Complete physical-device upgrade QA for Preferences-to-SQLite and data-URI-to-file migrations, including interruption and low-storage cases.
- Verify backup scheduling, interrupted resumable upload, token revocation, and two-device ownership transfer with production-signed physical devices.
- Remove legacy Capacitor Preferences fallback after one stable release with successful SQLite migration.
- Add cloud/device recovery education for users who intentionally clear OS app storage.
- Verify the generated production icons/splash on target densities and configure external signing credentials from `android/keystore.properties.example`.

## Release Validation Matrix

- Preferences-to-SQLite and data-URI-to-file migration with a large library, interrupted launch, retry, and low storage.
- Encrypted Drive/local archive restore with correct, wrong, changed, and lost passphrases; verify legacy plaintext and legacy `.txt` compatibility.
- Scheduled WorkManager execution under Doze, Wi-Fi/cellular policy, battery/storage constraints, revoked consent, expired upload sessions, and transient Drive failures.
- Two-device lineage: replacement restore, safe merge with diary/entry/note conflicts, Keep Local cloud-write block, and explicit ownership transfer.
- Audio Note and Dictate Text with permissions denied, browser support absent, Android speech services disabled, and network loss during dictation.
- Android Clear Storage followed by recovery from Drive and `.ddbackup`.
- Production-signed OAuth SHA-1, release APK/AAB installation, adaptive/round launcher icons, light/dark splash rendering, and WebView debugging disabled.
