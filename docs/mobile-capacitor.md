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

- Dear Diary is local-first. Device storage is the source of truth; Google Drive is used only for user-initiated backup and restore.
- Drive backups use the `https://www.googleapis.com/auth/drive.appdata` scope and are stored in the hidden Google Drive `appDataFolder`.
- Drive backups are Drive-protected, not end-to-end encrypted. Restoring on a new device requires the same Google account and app access.
- Existing Firestore data from older builds is left untouched, but the app no longer reads or writes Firestore.

## Phase 2 Progress

- Native builds load all journal, settings, profile, security, and backup metadata through the async repository. Diary data is no longer hydrated into `localStorage`; only the non-sensitive diary view preference is mirrored for the UI.
- Native storage is now backed by encrypted SQLite through `@capacitor-community/sqlite` with SQLCipher enabled in Capacitor config.
- The SQLite encryption secret is generated on device and stored through `@aparajita/capacitor-secure-storage`; the SQLite plugin also receives the secret for encrypted database access.
- On first migrated native launch, existing Capacitor Preferences values are copied into SQLite, collection counts are verified, and only then is migration marked complete. Preferences are retained as a one-release fallback.
- All diary, entry, note, settings, profile, security, Drive metadata, manual export, and Drive restore operations use the serialized async repository.
- SQLite maintains normalized tables for `diaries`, `entries`, `entry_blocks`, `notes`, `media_assets`, `app_settings`, `user_profile`, and `storage_meta`. Its internal `kv_store` is retained only as a migration/format compatibility record, not as a UI data source.
- Multi-record snapshot restores use one native SQLite transaction, preventing partially restored application state.
- PIN verification and recovery cryptography are pure in-memory operations; only completed security state is persisted. Google PIN recovery binding is explicit and separate from Drive backup connection.
- Legacy native cover, photo, and audio data URIs are moved to app-private files on startup. The migration records counts and retries on the next launch if any file could not be written.
- Google Drive backup creates zipped snapshots with manifest, JSON data, and media files in Drive `appDataFolder`.
- Native reminder settings schedule or cancel a daily Local Notifications reminder when app settings are saved.
- New diary cover images, diary settings cover updates, entry photos, and entry audio are written through Capacitor Filesystem on native and remain data URIs on web.
- Android biometric unlock uses `@capgo/capacitor-native-biometric` and requires an enrolled strong biometric, such as fingerprint, plus an app PIN fallback.
- Android voice notes use `@independo/capacitor-voice-recorder`; toolbar voice-to-text uses native speech recognition without starting the recorder so it does not compete for the microphone. Android cannot reliably run `MediaRecorder` and `SpeechRecognizer` on the same microphone session, so native voice notes save audio only while the separate voice-to-text control inserts dictated text.

## Known Limitations

- The legacy media migration needs physical-device QA with large photo/audio libraries and interrupted launches before the fallback can be retired.
- Android Settings > Apps > Dear Diary > Clear storage is destructive. It deletes local diary data, encrypted SQLite, secure storage secrets, Preferences, Google backup link metadata, and the app PIN hash/salt. Restore from a Drive backup when data should be recovered.
- Native speech recognition depends on Android speech services and microphone permission. If unavailable, the app shows a graceful message; audio recording still works through the native recorder.
- Default Capacitor splash/icon assets are used. Replace native assets before store release.

## Release Checklist

- Complete physical-device upgrade QA for Preferences-to-SQLite and data-URI-to-file migrations, including interruption and low-storage cases.
- Remove legacy Capacitor Preferences fallback after one stable release with successful SQLite migration.
- Add cloud/device recovery education for users who intentionally clear OS app storage.
- Add production icons, splash assets, signing config, and release build documentation.
