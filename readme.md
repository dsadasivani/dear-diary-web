# 📔 Dear Diary — Private, Secure, Local-First Journaling Sanctuary

**Dear Diary** is an elegant, secure journaling application designed to capture personal memories, organize thoughts, and reflect deeply on growth. Built with React and TypeScript, the app combines a warm, highly polished tactile design with secure cloud synchronization via Firebase and privacy features like WebAuthn.

---

## 🗺️ Architectural & Functional Roadmap

```
                                  +-----------------------+
                                  |     Browser Client     |
                                  |-----------------------|
                                  | - React UI Components |
                                  | - Firestore Syncing   |
                                  | - WebAuthn Security   |
                                  | - MediaRecorder audio |
                                  +-----------+-----------+
                                              |
                                     (Firebase Firestore)
                                              |
                                              v
                                  +-----------+-----------+
                                  |   Firebase Backend    |
                                  |-----------------------|
                                  | - Real-time Database  |
                                  | - Secure Auth         |
                                  +-----------------------+
```

---

## 🌟 Key Features

- **Personal Journaling**: Create and manage multiple diaries and entries.
- **Rich Media**: Integrated audio recording and playback for voice notes.
- **Secure Access**: WebAuthn support for secure authentication.
- **Insights & Stats**: Track your journaling habits and emotional journey.
- **Searchable Notes**: Easily find past entries and notes.
- **Privacy First**: Designed for private, personal reflection.

---

## 💻 Tech Stack & Environment Setup

### Tech Stack
- **Frontend Framework**: React 18+ (Functional Components, Hooks)
- **Styling Utility**: Tailwind CSS
- **Bundler & Tooling**: Vite + TypeScript
- **Icons**: Lucide React
- **Animations**: `motion` (AnimatePresence transitions)
- **Backend Server**: Node.js + Express (serving static files)
- **Database**: Firebase Firestore

### Environment Setup
The application uses Firebase for storage and authentication. Ensure your environment is configured according to the Firebase setup instructions.

---

## 📂 Codebase File Directory Overview

```
├── .env.example                # Example environment settings
├── .gitignore                  # Exclusion file
├── index.html                  # Core single-page canvas entry
├── metadata.json               # App identity
├── package.json                # Dependencies and run scripts
├── server.ts                   # Express server
├── tsconfig.json               # TypeScript configuration
├── vite.config.ts              # Vite configuration
├── src/
│   ├── main.tsx                # Client launcher
│   ├── index.css               # Global CSS
│   ├── types.ts                # Type declarations
│   ├── components/             # Reusable UI Screen Modules
│   ├── utils/
│       └── firebase.ts         # Firebase initialization
│       └── storage.ts          # Storage utilities
│       └── sync.ts             # Syncing logic
│       └── webauthn.ts         # WebAuthn logic
```

---

## 🚀 Quick Start & Development

### Local Installation
1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the development server:
   ```bash
   npm run dev
   ```

---

## Mobile App - Capacitor Native Shell

Dear Diary uses Capacitor to package the existing Vite React app as a native mobile app. This keeps the current screens, styling, local-first behavior, PIN lock, WebAuthn browser flow, editor, audio, and Firebase sync logic intact while adding Android/iOS native shell support.

Android is the first runnable target. iOS support is prepared through dependencies and scripts, but generate the iOS project on macOS.

### Commands

```bash
npm install
npm run build
npm run cap:sync
npm run android:studio
```

Useful scripts:

- `npm run cap:add:android` - generate the Android native project.
- `npm run cap:add:ios` - generate the iOS native project on macOS.
- `npm run cap:copy` - copy the latest web bundle into native projects.
- `npm run android` - run the Android app on an emulator/device.
- `npm run mobile:sync` - build the web app and sync Capacitor.

On Windows PowerShell, use `npm.cmd` or `npx.cmd` if execution policy blocks `npm.ps1`.

### Environment

Copy `.env.example` to `.env` and provide:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIRESTORE_DATABASE_ID`

Do not commit real Firebase values. See `docs/mobile-capacitor.md` for Android setup, Firebase security notes, known limitations, and Phase 2 mobile work.

### Phase 2 Mobile Notes

Native builds now hydrate Dear Diary data from Capacitor Preferences before React renders, mirror existing local-first writes into Preferences, schedule reminder notifications from app settings, store newly added diary covers, entry photos, and entry audio in Capacitor Filesystem, and use native Android plugins for biometric unlock, voice notes, and toolbar voice-to-text.

Android OS-level Clear storage is destructive: it removes local diary data, Firebase auth state, and the app PIN hash/salt. Use in-app reset, encrypted backup, or cloud sync when data should be preserved.
