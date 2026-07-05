# Dear Diary

Dear Diary is a private, local-first journaling app built with React, TypeScript, Vite, and Capacitor. The mobile app treats device storage as the source of truth; Google Drive is used only for manual backup and restore.

## Current Storage Architecture

```text
+---------------------------+
| Capacitor mobile app      |
|---------------------------|
| React UI                  |
| Async repository          |
| Encrypted SQLite          |
| App-private media files   |
+-------------+-------------+
              |
              | optional manual backup/restore
              v
+---------------------------+
| Google Drive appDataFolder|
|---------------------------|
| Hidden backup zip bundle  |
| manifest.json             |
| data.json                 |
| media/*                   |
+---------------------------+
```

The app no longer reads or writes Firestore. Existing Firebase/Firestore data from older builds is left untouched outside the app.

## Key Features

- Multiple diaries, entries, rich text blocks, photos, and audio notes.
- Notes, search, tags, moods, reminders, and profile settings.
- Local PIN, recovery question, and optional biometric unlock on mobile.
- Hidden Google Drive `appDataFolder` backups with no separate backup password.
- Optional password-protected local export/import for manual safekeeping.

## Tech Stack

- React, TypeScript, Vite
- Tailwind CSS
- Capacitor for Android/iOS shell
- `@capacitor-community/sqlite` with SQLCipher for native mobile persistence
- `@aparajita/capacitor-secure-storage` for the local SQLite encryption secret
- Capacitor Preferences as a one-release migration fallback
- Capacitor Filesystem for app-private media files
- `@capawesome/capacitor-google-sign-in` for Drive backup access
- Google Drive REST API with `https://www.googleapis.com/auth/drive.appdata`
- `fflate` for zipped backup bundles

## Development

Install dependencies:

```bash
npm install
```

Run the web development server:

```bash
npm run dev
```

Build the app:

```bash
npm run build
```

Sync Capacitor assets and plugins:

```bash
npm run cap:sync
```

## Mobile Notes

Android is the primary native target in this repo. All journal, settings, profile, security, manual backup, and Drive restore workflows use an async repository whose native reads come from encrypted normalized SQLite tables. Existing Capacitor Preferences values are migrated with count verification and retained as a one-release fallback.

Legacy inline cover, photo, and audio data is migrated into app-private files on native startup. Phase 2 implementation is complete in code; physical-device upgrade, interrupted migration, and low-storage QA remain before retiring the Preferences fallback.

See [docs/mobile-capacitor.md](docs/mobile-capacitor.md) for native setup and current mobile limitations.
