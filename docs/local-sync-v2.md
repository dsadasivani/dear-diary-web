# Local secure-sync setup

## Prerequisites

- Node.js and `npm.cmd`
- Java 21
- Docker Desktop
- A configured Supabase Auth project and Google OAuth values in `.env`

PowerShell may block `npm.ps1`; use `npm.cmd` or the provided scripts instead of changing the machine execution policy.

## Start

From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-local-sync-v2.ps1
```

This starts PostgreSQL 16, MinIO, the authenticated Spring Boot sync backend, and the web app. New mobile accounts use this sync service directly.

The backend allows the browser development origins plus the Capacitor Android/iOS origins (`https://localhost` and `capacitor://localhost`) so installed emulator builds can connect to local sync.

Open `http://localhost:3000`. To exercise a clean setup:

1. Create the local PIN and recovery question on the Android primary device.
2. Connect Google and create the 8-digit recovery passphrase.
3. Wait for encrypted account setup to finish.
4. Create or edit a note and confirm **Settings -> Sync & Backup** reports that sync is up to date.
5. Open the browser companion page, approve its pairing code on mobile, and unlock it with the mobile PIN.

The browser build is a companion device. The initial account must be created on Android. With an emulator running:

```powershell
npm.cmd run mobile:sync
android\gradlew.bat -p android installDebug
adb shell am start -n com.deardiary.app/.MainActivity
```

`scripts/start-local-sync-v2.ps1` configures `adb reverse tcp:8080 tcp:8080` and `adb reverse tcp:9000 tcp:9000` automatically when an emulator is attached. Re-run the script, or run those two `adb reverse` commands manually, after restarting the emulator.

The cleartext localhost exception exists only in `android/app/src/debug/AndroidManifest.xml`; release builds remain unchanged.

Useful endpoints:

- App: `http://localhost:3000`
- Backend health: `http://localhost:8080/actuator/health`
- MinIO console: `http://localhost:9001`

Local MinIO credentials are intentionally development-only and are declared in `dev/local-sync-v2.compose.yml`.

## Stop or reset

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-local-sync-v2.ps1
```

The stop script retains PostgreSQL and MinIO volumes. To delete all local server data:

```powershell
docker compose -f dev/local-sync-v2.compose.yml down -v
```
