# Seeded Device State For MD-021 And MD-022

This runbook prepares repeatable Android/emulator state for the manual force-stop tests:

- MD-021: force-stop during primary recovery.
- MD-022: force-stop during companion revocation and device key rotation.

Use only a test Google account, test Supabase project, and disposable devices/emulators. Do not paste OAuth tokens, passphrases, root keys, or recovery answers into logs, screenshots, issues, or chat.

## Test Build

Build a debug-inspectable APK with manual force-stop hooks enabled:

```powershell
$env:CAPACITOR_WEBVIEW_DEBUG='true'
$env:VITE_ENABLE_MD_FLOW_HOOKS='true'
npm.cmd run mobile:sync
npm.cmd run android
```

The hooks are inert unless both of these are true:

- the app was built with `VITE_ENABLE_MD_FLOW_HOOKS=true`;
- the WebView localStorage key `deardiary.manualTest.pauseAt` equals one checkpoint ID from [md021-md022-checkpoints.json](./md021-md022-checkpoints.json).

Do not set `CAPACITOR_BRIDGE_LOGGING=true` for these runs. Capacitor bridge debug logging can echo native plugin payloads, including secure-storage values, into logcat.

When a checkpoint is reached, the app removes `deardiary.manualTest.pauseAt`, writes `deardiary.manualTest.lastCheckpoint`, logs the checkpoint name, and intentionally waits forever. At that moment, force-stop the app with adb.

## Common Commands

```powershell
adb devices
adb shell am force-stop com.deardiary.app
adb shell monkey -p com.deardiary.app -c android.intent.category.LAUNCHER 1
adb logcat -c
adb logcat -s chromium Console DearDiary
```

Set a checkpoint through Chrome DevTools:

1. Open `chrome://inspect/#devices`.
2. Inspect the `com.deardiary.app` WebView.
3. In the Console, run:

```js
localStorage.setItem('deardiary.manualTest.pauseAt', 'md021:after-cursor-updated')
```

Confirm the hook hit after the app pauses:

```js
localStorage.getItem('deardiary.manualTest.lastCheckpoint')
```

Clear a stale target before retrying:

```js
localStorage.removeItem('deardiary.manualTest.pauseAt')
```

## Baseline Seed State

Use the same test account for both scenarios.

1. Clean the target app install if previous test state may leak:

```powershell
adb shell pm clear com.deardiary.app
```

2. On Device A, create a fresh Dear Diary mobile account.

- Google account: disposable test account.
- Recovery passphrase: record privately in the local test notebook only.
- Local PIN/recovery answer: disposable values.
- Content seed: at least one diary, one entry, and one note.

3. Wait for encrypted sync to finish.

- Confirm no sync authorization banner is visible.
- Confirm Google Drive authorization completed.
- Confirm the account has at least one recovery `key_package`, one snapshot or partition manifest, and a nonzero `accounts.current_sync_sequence`.

4. Pair at least one companion device.

- Use a browser companion for the target of MD-022.
- Prefer pairing a second companion as the survivor so MD-022 also verifies package publication for remaining companions.
- Record display names only, not secrets.

5. Keep Device A available and online.

- Device A remains the old primary during MD-021 until recovery finalizes.
- Device A initiates companion revocation during MD-022.

## MD-021: Primary Recovery Seed And Force-Stop

Device roles:

- Device A: existing active primary.
- Device B: clean Android/emulator install that will recover the account.

For each checkpoint, reset Device B with `adb shell pm clear com.deardiary.app`, install/open the hooked build, set the checkpoint in Device B's WebView localStorage, then start account recovery on Device B with the same Google account and recovery passphrase.

| Checkpoint | Force-stop moment | Expected resume |
| --- | --- | --- |
| `md021:after-recovery-registered` | Server created pending primary and local pending journal exists. | Relaunch resumes without starting a second recovery attempt; Device A remains active until finalize. |
| `md021:after-local-empty-state` | Local security, Drive settings, and pending primary local sync state were saved. | Relaunch continues secret save and restore. |
| `md021:after-sync-secrets-saved` | Recovered account key and new device private key were saved. | Relaunch restores data without asking for passphrase again. |
| `md021:after-restore-completed` | Partition/snapshot restore completed before cursor/finalize. | Relaunch updates cursor and finalizes; optional stale tail is replayed. |
| `md021:after-cursor-updated` | Cursor updated before finalize. | Relaunch finalizes; if Device A writes a new note while paused, stale-tail replay catches up before finalize. |
| `md021:after-server-finalized` | Server promoted Device B before local cleanup. | Relaunch treats recovery as already finalized, promotes local state, and clears the journal. |

Stale-tail variant:

1. Use `md021:after-cursor-updated`.
2. When Device B is paused, create a new note on Device A and wait for sync.
3. Force-stop Device B and relaunch.
4. Device B should replay the new note, update its cursor again, then finalize.

MD-021 Supabase verification:

```sql
select id, active_primary_device_id, current_sync_sequence
from public.accounts
where google_email = '<test-google-email>';

select id, role, display_name, activation_state, revoked_at, replaced_by_device_id
from public.devices
where account_id = '<account-id>'
order by created_at;

select id, device_id, previous_primary_device_id, status, restored_sequence, finalized_at
from public.primary_recovery_attempts
where account_id = '<account-id>'
order by started_at desc;

select device_id, last_applied_sequence, updated_at
from public.device_cursors
where account_id = '<account-id>'
order by updated_at desc;
```

Pass criteria:

- No plaintext secret values appear in logs.
- A pending recovery never revokes Device A before finalize.
- On resume completion, Device B is the active primary and Device A is revoked/replaced.
- The pending-primary-recovery journal is cleared; subsequent relaunch does not repeat recovery.

## MD-022: Key Rotation Seed And Force-Stop

Device roles:

- Device A: active primary mobile.
- Companion B: target device to revoke.
- Companion C: optional survivor device that should receive a next-epoch package.

For each checkpoint, keep Device A signed in and unlocked, set the checkpoint in Device A's WebView localStorage, then revoke Companion B from Settings. Enter the recovery passphrase only through the in-app passphrase dialog.

| Checkpoint | Force-stop moment | Expected resume |
| --- | --- | --- |
| `md022:after-rotation-begun` | `begin_device_key_rotation` reserved the next epoch, before any recovery package commit. | Relaunch aborts the pending rotation because no recovery package was committed; Companion B remains active. |
| `md022:after-recovery-package-committed` | Next-epoch recovery key package committed. | Relaunch continues packages, stages local future key, finalizes, and revokes Companion B. |
| `md022:after-companion-packages-committed` | Remaining companion packages committed. | Relaunch stages future key, finalizes, and revokes Companion B. |
| `md022:after-future-key-staged` | Device A locally stored the future epoch key. | Relaunch finalizes server rotation and promotes local key epoch. |
| `md022:after-server-finalized` | Server finalized and revoked Companion B before local cleanup. | Relaunch promotes local key epoch, updates cursor if needed, and clears the journal. |

MD-022 Supabase verification:

```sql
select id, active_primary_device_id, current_sync_sequence, current_key_epoch
from public.accounts
where google_email = '<test-google-email>';

select id, role, display_name, revoked_at
from public.devices
where account_id = '<account-id>'
order by created_at;

select id, primary_device_id, revoked_device_id, next_key_epoch, starting_sequence,
       key_package_sequence, status, finalized_at
from public.key_epoch_rotations
where account_id = '<account-id>'
order by created_at desc;

select sequence, object_kind, key_epoch, operation_id, created_by_device_id
from public.sync_objects
where account_id = '<account-id>'
  and object_kind = 'key_package'
order by sequence desc
limit 20;

select device_id, reason, created_at
from public.device_revocations
where account_id = '<account-id>'
order by created_at desc;
```

Pass criteria:

- `md022:after-rotation-begun` aborts safely, leaves `accounts.current_key_epoch` unchanged, and does not revoke Companion B.
- Later checkpoints finalize exactly one rotation, advance `accounts.current_key_epoch`, and revoke only Companion B.
- If Companion C exists, `sync_objects.operation_id` includes a `key-epoch:<account>:<epoch>:<rotation>:<companion-c>` package.
- The pending-rotation journal is cleared; subsequent relaunch does not repeat revocation.

## Result Log Template

| Field | Value |
| --- | --- |
| Date/time |  |
| Tester |  |
| Device/emulator IDs |  |
| App build SHA |  |
| Supabase project |  |
| Google test account alias |  |
| Scenario | MD-021 / MD-022 |
| Checkpoint |  |
| Force-stop command timestamp |  |
| Relaunch result | Pass / Fail |
| Supabase verification notes |  |
| Logs attached | Yes / No |

## Cleanup

After the manual pass:

```powershell
adb shell am force-stop com.deardiary.app
adb shell pm clear com.deardiary.app
```

In the test Supabase project, delete the disposable account rows or reset the local database. In the test Google account, delete appDataFolder artifacts if the environment allows it. Do not reuse the recovery passphrase outside this test account.
