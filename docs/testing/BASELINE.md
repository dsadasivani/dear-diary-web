# Baseline

Date: 2026-07-08

Repository: https://github.com/dsadasivani/dear-diary-web.git  
Branch: feature/dear-diary-v2  
Commit SHA: 774e18b1c17010fbd2741cc113b1e81c4a33b5f9  
Node version: v24.15.0  
npm version: 11.12.1 via `npm.cmd`  
Operating system: Microsoft Windows 11 Home Single Language 10.0.26200  
Docker availability: Docker version 29.4.3, build 055a478  
Android SDK availability: `ANDROID_HOME` / `ANDROID_SDK_ROOT` not set; `adb` present on PATH.

PowerShell cannot execute `npm.ps1` because local execution policy blocks scripts. All npm commands were run through `npm.cmd`, which is the same npm CLI and does not require changing the user's PowerShell policy.

## Required Baseline Commands

| Command | Exit code | Result |
| --- | ---: | --- |
| `git status` | 0 | Clean working tree on `feature/dear-diary-v2`. |
| `git branch --show-current` | 0 | `feature/dear-diary-v2`. |
| `git rev-parse HEAD` | 0 | `774e18b1c17010fbd2741cc113b1e81c4a33b5f9`. |
| `npm.cmd ci` | 1 | Initial attempt failed with Windows `EPERM` unlink on `lightningcss.win32-x64-msvc.node`; a running repo `npm run start` / `node dist/server.cjs` process held files. |
| `npm.cmd ci` | 1 | Second attempt failed with `ENOTEMPTY` under generated Android dependency build output. |
| `android\\gradlew.bat --stop` | 0 | Stopped one Gradle daemon holding generated dependency output. |
| Remove generated `node_modules` | 0 | Removed only `C:\dilip\repos\dear-diary-web\node_modules` after verifying the path was inside the repo. |
| `npm.cmd ci` | 0 | Installed 351 packages, 0 vulnerabilities. |
| `npm.cmd run lint` | 0 | TypeScript passed. |
| `npm.cmd run test:storage` | 0 | Existing storage/domain/sync tests passed at baseline. |
| `npm.cmd run test:supabase` | 0 | Docker-backed Supabase integration suite passed at baseline. |
| `npm.cmd run build` | 0 | Vite and server bundle passed; Vite warned about chunks over 500 kB. |
| `npm.cmd run android:test` | 0 | Gradle `testDebugUnitTest` passed. |
| `npm.cmd run android:lint` | 0 | Gradle `lintDebug` passed; lint reported no new issues. |

## Baseline Notes

- The working tree was clean before changes.
- Docker was available and the Supabase suite used a real PostgreSQL container.
- Android unit/lint checks ran without a physical device or emulator.
- Real Google OAuth, Google Drive consent, biometric prompts, camera, microphone, notification permission, and physical-device flows were not executed at baseline.
