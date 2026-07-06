# Dear Diary Multi-Device Sync Design

This document captures the proposed account-first, WhatsApp-like multi-device design for Dear Diary. It is a design artifact only; it does not describe the current implementation.

Related diagram: [dear-diary-multi-device.drawio](dear-diary-multi-device.drawio)

## 1. Product Direction

Dear Diary moves from local-first backup/restore to account-first encrypted sync.

Core decisions:

- Google Sign-In is the only identity provider for v1.
- A user must sign in on mobile first.
- Mobile is the primary device class.
- Only one active mobile primary is allowed at a time.
- Web and future desktop are companion clients only.
- Web/desktop login is allowed only for an existing Dear Diary account.
- Web/desktop must be online to use/edit the app.
- Mobile edits also require online sync in v1; no offline write queue.
- Google Drive stores the user's encrypted diary data.
- Supabase stores metadata/control-plane state only.
- Journal content is true end-to-end encrypted.
- A 12+ character recovery passphrase is mandatory and cannot be reset.
- Local-only mode, local import/export, Drive restore review, Safe Merge, and Keep Local are removed from the future account-first product.

## 2. System Architecture

The design separates identity, coordination, and encrypted content storage.

| Layer | Owner | Stores | Must never store |
| --- | --- | --- | --- |
| Google Sign-In | Google | User identity proof | Dear Diary plaintext |
| Supabase | Dear Diary | Account/device metadata, sync cursors, Drive object pointers, revocation state | Plaintext journal content, decrypted keys |
| Google Drive `appDataFolder` | User Google account | Encrypted event chunks, encrypted media, encrypted snapshots, encrypted root-key package | Plaintext journal content |
| Client devices | User devices | Plaintext while unlocked, local encrypted cache, device keys | Other users' data |

High-level shape:

```text
Google Sign-In = identity
Supabase       = metadata/control plane
Google Drive   = encrypted content/data plane
Clients        = encryption/decryption and UX
```

## 3. Device Model

### Mobile Primary

The active mobile primary is the account authority for:

- first account creation;
- companion-device approval;
- device revocation;
- normal recovery-passphrase setup;
- local PIN setup;
- encrypted key provisioning to companions.

Only one mobile primary can be active.

If a user signs in on a new mobile and completes recovery, the new mobile becomes primary. The previous mobile and all existing companions are revoked.

### Web/Desktop Companions

Web and desktop clients:

- require Google Sign-In;
- must find an existing Supabase account;
- cannot create a new account;
- require primary-mobile approval through QR/pairing code;
- receive a wrapped device key from the primary mobile;
- must be online to edit or use synced journal data;
- are revoked when primary mobile ownership transfers.

## 4. End-to-End Encryption Model

Dear Diary content is encrypted before it reaches Drive.

### Keys

- `accountRootKey`: random high-entropy key generated on first mobile signup.
- `deviceKeyPair`: per-device signing/encryption identity.
- `recoveryKeyWrap`: encrypted package that wraps the `accountRootKey` using the recovery passphrase.
- `mediaKey`: per-media or per-object encryption key, wrapped by account-level key material.

### Recovery Passphrase

The recovery passphrase:

- is mandatory during account creation;
- must be at least 12 characters;
- is never stored;
- wraps/unwraps the `accountRootKey`;
- is required when the primary mobile is lost or replaced;
- cannot be reset without access to an already trusted device.

Important consequence:

If the user loses all trusted devices and forgets the recovery passphrase, existing encrypted Drive data cannot be decrypted.

## 5. Supabase Metadata Model

Supabase is the coordination plane. Suggested tables:

### `accounts`

- `id`
- `google_user_id`
- `google_email`
- `created_at`
- `active_primary_device_id`
- `current_sync_sequence`
- `current_snapshot_sequence`
- `recovery_configured`

### `devices`

- `id`
- `account_id`
- `role`: `primary_mobile`, `web_companion`, `desktop_companion`
- `public_key`
- `display_name`
- `platform`
- `created_at`
- `last_seen_at`
- `revoked_at`
- `replaced_by_device_id`

### `sync_objects`

- `id`
- `account_id`
- `sequence`
- `drive_file_id`
- `object_kind`: `event`, `media`, `snapshot`, `key_package`
- `sha256`
- `size_bytes`
- `created_by_device_id`
- `created_at`

### `device_cursors`

- `account_id`
- `device_id`
- `last_applied_sequence`
- `updated_at`

### `pairing_sessions`

- `id`
- `account_id`
- `requested_device_public_key`
- `requested_platform`
- `pairing_code_hash`
- `expires_at`
- `approved_by_primary_device_id`
- `approved_at`

### `device_revocations`

- `account_id`
- `device_id`
- `reason`
- `created_at`

Supabase Row Level Security should ensure a signed-in Google user can access only their account metadata. Server-side checks still validate active device status before accepting sync commits.

## 6. Google Drive Object Layout

Use Drive `appDataFolder` so files are hidden from normal Drive UI but still count against the user's storage.

Suggested logical object names:

```text
/key-packages/root-key-v<version>.ddkey
/events/<sequence>.ddevent
/media/<mediaId>.ddmedia
/snapshots/<sequence>.ddsnapshot
```

Each Drive object is encrypted and authenticated locally before upload.

Supabase stores the Drive file ID, sequence, kind, hash, and size so clients can discover objects without listing/parsing all Drive files.

## 7. Core Flows

### 7.1 New Mobile Signup

1. User opens mobile app.
2. App requires Google Sign-In.
3. App checks Supabase for `google_user_id`.
4. If no account exists:
   - create Supabase account;
   - generate `accountRootKey`;
   - require 12+ character recovery passphrase;
   - create encrypted root-key package in Drive;
   - create active primary mobile device row;
   - create empty encrypted snapshot/event baseline in Drive;
   - create local PIN.
5. App opens synced journal.

Local-only entry is not allowed.

### 7.2 Existing Account on New Mobile

1. User installs mobile app.
2. User signs in with Google.
3. Supabase finds existing account.
4. App asks for recovery passphrase.
5. App downloads encrypted root-key package from Drive.
6. Recovery passphrase unwraps `accountRootKey`.
7. New mobile becomes active primary.
8. Old mobile and all companions are revoked.
9. App downloads latest encrypted snapshot and event tail.
10. Local encrypted cache is rebuilt from cloud.
11. User creates local PIN on the new device.

Cloud is authoritative. Existing local-only data on the new device is deleted during this process.

### 7.3 Web/Desktop Companion Login

1. User opens web/desktop app.
2. App requires Google Sign-In.
3. Supabase must find an existing account.
4. Companion creates a device key pair and pairing request.
5. Web/desktop displays QR/pairing code.
6. Primary mobile scans/approves.
7. Primary mobile wraps the account key for the companion device.
8. Companion downloads encrypted snapshot and event tail from Drive.
9. Companion opens journal.

If no primary mobile is available, companion linking cannot complete.

### 7.4 Write Sync

For create/update/delete operations:

1. Client validates it is online and not revoked.
2. Client reads latest record version/cursor.
3. Client creates a canonical domain event.
4. Client encrypts the event locally.
5. Client uploads encrypted event object to Drive.
6. Client sends Supabase metadata commit:
   - account ID;
   - sequence request;
   - Drive file ID;
   - hash;
   - object kind;
   - base record version;
   - device ID.
7. Supabase validates active device and sequence ordering.
8. Supabase advances account sync head.
9. Supabase Realtime notifies other devices.
10. Other devices fetch encrypted Drive object, verify hash, decrypt locally, and apply.

### 7.5 Stale Write Handling

No silent last-writer-wins for journal text.

If a client attempts to save a stale record version:

- Supabase rejects the metadata commit;
- client fetches latest event tail;
- UI shows the latest version;
- user's pending text can be saved as a recovered copy if needed.

Because v1 requires online edits, stale writes should be rare and usually limited to two active clients editing the same entry at the same time.

### 7.6 Snapshot Compaction

Periodic snapshots reduce restore time and provide recovery checkpoints.

1. Active primary mobile or trusted client reaches snapshot interval.
2. Client exports current canonical state.
3. Client encrypts snapshot locally.
4. Client uploads snapshot to Drive.
5. Client commits snapshot metadata to Supabase.
6. Future restores start from latest valid snapshot and replay later events.

Events remain the source of latest changes; snapshots are compaction/recovery artifacts.

## 8. Online and Cache Policy

V1 does not support offline writes.

Allowed:

- local encrypted cache for faster startup;
- read-only cached view after a successful recent device-status check;
- short-lived UI state while a save is in progress.

Not allowed:

- creating entries offline;
- editing entries offline;
- deleting records offline;
- companion access before device status is verified;
- using stale companion credentials after primary transfer.

If network or sync service is unavailable:

- edits are disabled;
- app shows a sync-required message;
- user can retry once connectivity returns.

## 9. Backup and Recovery Semantics

The old backup/restore model is replaced by encrypted sync plus encrypted snapshots.

Remove from the future UI:

- local-only onboarding;
- local encrypted export/import;
- per-diary archive import/export as backup;
- Review Restore;
- Safe Merge;
- Keep Local;
- Start Fresh From This Device.

Keep conceptually:

- scheduled encrypted snapshots to Drive;
- restore from latest valid snapshot plus event tail;
- media integrity checks;
- corruption fallback to older snapshot where possible.

## 10. Failure Modes

### Lost Primary Mobile

User signs in on new mobile with Google and enters recovery passphrase. New mobile becomes primary. Old mobile and companions are revoked.

### Lost Recovery Passphrase

If at least one trusted primary mobile is still available, user can rotate/reset recovery passphrase after local authentication.

If no trusted device remains and recovery passphrase is lost, encrypted cloud data is unrecoverable.

### Drive Upload Succeeds, Supabase Commit Fails

Drive object becomes orphaned. A cleanup job can delete unreferenced encrypted Drive objects after a grace period.

### Supabase Commit Succeeds, Device Fetch Fails

Other devices retry fetching the Drive object by file ID. Hash mismatch rejects the object.

### Device Revoked While Open

Next Supabase check/realtime event forces logout, local cache lock, and companion re-link requirement.

## 11. Phased Rollout

### Phase A — Design and Backend Foundation

- Add Supabase project/schema/RLS.
- Add account/device metadata APIs.
- Add Google-only account lookup.
- Add E2EE key package design.

### Phase B — Mobile Account-First Bootstrap

- Remove local-first onboarding.
- Require Google signup.
- Create account root key and recovery passphrase flow.
- Upload first encrypted key package/snapshot to Drive.

### Phase C — Encrypted Event Sync

- Add event model.
- Add Drive encrypted event upload.
- Add Supabase metadata commit.
- Add realtime pull/apply loop.
- Disable writes when offline.

### Phase D — Companion Web

- Add Google login for web.
- Add QR pairing flow.
- Add primary-mobile approval.
- Add online-only web sync client.

### Phase E — Snapshot Compaction and Recovery

- Add scheduled encrypted snapshots.
- Add new-mobile restore from snapshot + event tail.
- Add primary transfer and device revocation.

## 12. Explicit Non-Goals for V1

- No offline writes.
- No multiple mobile primary devices.
- No non-Google identity provider.
- No plaintext server-side search.
- No server-readable journal content.
- No local-only mode.
- No manual merge UX.
- No visible user-managed Drive folder for sync internals.
