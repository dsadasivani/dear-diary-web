# Dear Diary Mobile - Capacitor

Dear Diary now runs inside a Capacitor native shell while keeping the existing Vite React app as the UI. Android is the first supported native target. iOS support is dependency and script ready, but the iOS native project should be generated on macOS.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a local `.env` from `.env.example` and fill the Firebase values:
   ```bash
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=...
   VITE_FIREBASE_PROJECT_ID=...
   VITE_FIREBASE_STORAGE_BUCKET=...
   VITE_FIREBASE_MESSAGING_SENDER_ID=...
   VITE_FIREBASE_APP_ID=...
   VITE_FIRESTORE_DATABASE_ID=...
   ```
3. Build the web bundle:
   ```bash
   npm run build
   ```
4. Sync native assets and plugins:
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

## Firebase Security Notes

- Firebase client keys must live in local environment variables, not source files.
- Firestore Security Rules must restrict users to their own data, for example `users/{uid}/...`.
- App Check is not configured in this phase because provider keys are not available. Add App Check before a public mobile release.

## Phase 2 Progress

- Native builds hydrate Dear Diary's existing localStorage keys from Capacitor Preferences on app startup.
- Existing storage writes now mirror diary data, entries, notes, settings, profile, security, last sync, and diary view mode into Capacitor Preferences on native.
- Native reminder settings schedule or cancel a daily Local Notifications reminder when app settings are saved.
- New diary cover images, diary settings cover updates, entry photos, and entry audio are written through Capacitor Filesystem on native and remain data URIs on web.
- Android biometric unlock uses `@capgo/capacitor-native-biometric` and requires an enrolled strong biometric, such as fingerprint, plus an app PIN fallback.
- Android voice notes use `@independo/capacitor-voice-recorder`; toolbar voice-to-text uses native speech recognition without starting the recorder so it does not compete for the microphone.

## Known Limitations

- The app still exposes synchronous storage APIs to screens; Capacitor Preferences is currently a native mirror/hydration layer rather than a full async rewrite.
- Existing legacy media already stored as data URIs is not migrated automatically; only newly added media uses native file storage.
- Android Settings > Apps > Dear Diary > Clear storage is destructive. It deletes local diary data, Preferences, Firebase auth state, and the app PIN hash/salt. Use in-app reset, encrypted backup, or cloud sync when data should be preserved.
- Native speech recognition depends on Android speech services and microphone permission. If unavailable, the app shows a graceful message; audio recording still works through the native recorder.
- Default Capacitor splash/icon assets are used. Replace native assets before store release.

## Phase 2 Checklist

- Complete the async storage rewrite screen by screen, replacing the current native Preferences mirror.
- Add an explicit migration for existing data URI media if needed for long-time users.
- Add cloud/device recovery options for users who intentionally clear OS app storage.
- Add production icons, splash assets, signing config, and release build documentation.
