# Manual Device Tests

Use this checklist on a real Android device and, where applicable, an emulator. Do not paste secrets into logs or chat.

| ID | Scenario | Expected outcome | Pass/Fail | Notes |
| --- | --- | --- | --- | --- |
| MD-001 | Fresh Android install | App launches locked, encrypted SQLite initializes, no plaintext database is exposed. |  |  |
| MD-002 | Upgrade from older app version | Preferences and encrypted content migrate without data loss. |  |  |
| MD-003 | Missing SQLite encryption secret | App fails safely without silently falling back to plaintext storage. |  |  |
| MD-004 | Changed SQLite encryption secret | Existing database is not opened as plaintext; user sees safe recovery path. |  |  |
| MD-005 | Process death during local write | On restart, content is either fully committed or unchanged. |  |  |
| MD-006 | PIN unlock | Correct PIN unlocks; incorrect PIN rejects; sensitive state clears on lock. |  |  |
| MD-007 | Biometric success/cancel/failure | Success unlocks when enabled; cancel/failure falls back to PIN without leaking content. |  |  |
| MD-008 | Background/resume under 5 minutes | Transient permission dialogs do not lock the app. |  |  |
| MD-009 | Background/resume over 5 minutes | App locks and per-diary unlocks clear. |  |  |
| MD-010 | Camera permission grant/denial | Grant attaches photo; denial leaves entry stable and recoverable. |  |  |
| MD-011 | Photo picker cancellation | No broken media pointer is created. |  |  |
| MD-012 | Microphone denial | Recording fails safely and entry remains editable. |  |  |
| MD-013 | Audio recording interruption | Partial recording is either saved deliberately or discarded clearly. |  |  |
| MD-014 | Speech recognition denial | No crash; user can continue typing. |  |  |
| MD-015 | Notifications denial | Reminder UI reports denial and does not loop prompts. |  |  |
| MD-016 | Google sign-in | User completes consent in app; tokens are not logged. |  |  |
| MD-017 | Google Drive authorization | Encrypted recovery/snapshot objects appear in appDataFolder only. |  |  |
| MD-018 | Offline start | App opens local encrypted data and shows sync paused state. |  |  |
| MD-019 | Network transition | Returning online resumes pending outbox operations after backoff. |  |  |
| MD-020 | Force-stop during outbox media upload | Restart resumes or safely retries without duplicate visible content. |  |  |
| MD-021 | Force-stop during primary recovery | Restart resumes local restore, stale-tail replay, finalize cleanup, or safe retry without revoking old primary prematurely. |  | Seed with `SEEDED_DEVICE_STATE_MD021_MD022.md`. |
| MD-022 | Force-stop during key rotation | Restart resumes committed package work, promotes already-finalized rotation, or aborts pre-recovery-package rotation; target is not revoked before finalize. | Pass | Passed on `emulator-5554` with browser companion target. Fixed and retested partition restore ambiguity, finalize/abort race, panel refresh race, web pairing auto-load, locked web revocation routing, and approved-pairing restoring UX. |
| MD-023 | Revoked device restart | Device clears sync secrets/local sync state and requires recovery or pairing. |  |  |
| MD-024 | Android back navigation | Back exits/navigates consistently without bypassing locks. |  |  |
| MD-025 | Keyboard resizing | Editor remains usable and controls are not obscured. |  |  |
| MD-026 | Status-bar theme | Light/dark status bar updates with app theme. |  |  |
