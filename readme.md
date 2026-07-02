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
