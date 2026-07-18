# Android and Capacitor

Dear Diary uses Capacitor to package the Vite React client. Android is the maintained native target. The iOS dependency and scripts are present, but the iOS project must be generated and validated on macOS.

## Development workflow

```bash
npm ci
npm run mobile:sync
npm run android:studio
```

Run on a connected target with `npm run android`. On Windows systems that block PowerShell package-manager shims, use `npm.cmd` and `npx.cmd`.

The checked-in Android project loads the built client from `android/app/src/main/assets/public` after `cap sync`. Those generated assets are ignored and must not be committed.

Useful commands:

```bash
npm run assets:generate
npm run android:test
npm run android:lint
npm run android:release
npm run android:bundle
```

Native WebView inspection is off by default. Set `CAPACITOR_WEBVIEW_DEBUG=true` only for local debug builds. Keep `CAPACITOR_BRIDGE_LOGGING` off during sync and recovery validation so logs cannot accidentally expose sensitive context.

## Native storage and services

- SQLCipher-backed SQLite is authoritative for journal, settings, security metadata, repository indexes, sync state, and the durable outbox.
- The SQLite encryption secret is generated on device and held in OS-backed secure storage.
- Capacitor Preferences is migration input and stores a small UI-only preference mirror; it is not the journal database.
- Photos, covers, and audio move to app-private files. Startup migration retries incomplete legacy data-URI moves.
- Media garbage collection protects active drafts and removes unreferenced app-owned files.
- Android biometric unlock uses the app PIN as its required fallback.
- Native voice recording and speech recognition use separate microphone sessions.
- Local notifications implement the configured reminder preference.
- The native Drive bridge remains for compatibility and portable-backup internals; current user-facing cloud behavior is encrypted account sync.

Android OS backup and device transfer are disabled because restoring encrypted SQLite without its secure-storage key would make the database unusable. Clearing app storage or uninstalling the app removes local data and security material.

## Local Sync V2 networking

The local stack uses the web host on port 3000, the Spring API on port 8080, and MinIO on ports 9000 and 9001. The helper script configures `adb reverse` for the API and object store when an emulator is attached. See [local-sync-v2.md](local-sync-v2.md).

The cleartext localhost exception exists only in `android/app/src/debug/AndroidManifest.xml`; release builds do not opt into cleartext traffic.

## iOS

On macOS:

```bash
npm run cap:add:ios
npm run cap:sync
```

Then open the generated project in Xcode. Treat iOS as unvalidated until storage, authentication, biometrics, media, reminders, background behavior, and release signing pass on real devices.

## Release validation

Use the physical-device checklist in [testing.md](testing.md). In particular, validate interrupted storage/media migration, low-storage behavior, real permissions and biometrics, clear-storage recovery, production OAuth fingerprints, generated assets at target densities, production signing, and release WebView settings.
