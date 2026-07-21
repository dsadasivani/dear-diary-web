# Encrypted sync architecture

Dear Diary currently contains two sync generations because deployed V1 accounts need a safe migration and rollback path. New accounts use Sync V2. V1 code and Supabase SQL migrations remain compatibility infrastructure until those accounts have migrated.

Journal plaintext stays on trusted devices in both generations.

## Sync V2

Sync V2 uses:

- Supabase Auth for Google-backed identity and access tokens;
- the Spring Boot service in `backend/sync-api` for accounts, devices, protocol configuration, operations, events, cursors, snapshots, recovery, pairing, rotation, notifications, and garbage-collection metadata;
- PostgreSQL managed by ordered Flyway migrations;
- an S3-compatible object store for encrypted events, media, snapshots, and key packages;
- client-held encryption keys and client-side hash verification, encryption, and decryption.

The API URL is configured with `VITE_SYNC_V2_API_URL` in the selected Vite mode. Backend settings use matching
Spring profiles selected by `SPRING_PROFILES_ACTIVE`; sensitive values remain runtime environment variables or
SSM-injected secrets. The complete variable list is in `.env.example`.

New Android primary accounts are registered directly with Sync V2. A browser companion creates a short-lived pairing request and becomes active only after approval and target-bound key-package delivery from the primary device.

## Local-first write path

A user mutation is sanitized and validated, applied to encrypted local storage, and recorded in the durable outbox before the UI save completes. Background workers then prepare encrypted objects, upload them, initiate and commit the server operation, reconcile lost responses, acknowledge the local record, and pull newer remote events.

Normal editing does not wait for network availability, object upload, remote pull, snapshot creation, or archive hydration. Replay is ordered and gap checked. Integrity, identity, version, or decryption failures engage persistent safety behavior instead of silently applying questionable data.

## Snapshots and restore

Sync V2 snapshots are account-wide canonical encrypted objects. Upload progress is restart resumable. A snapshot becomes discoverable only after object metadata is verified and its retained reference is committed atomically.

Restore is accepted only into empty V2 state. The client validates object size, SHA-256, object kind, key epoch, schema, account, partition, and through-sequence before installing state and its global cursor in one local transaction. Partial monthly V2 restore remains unavailable while the protocol uses a single global cursor.

## Recovery, pairing, and key rotation

Advanced workflows are durable server state machines with encrypted local journals:

- Pairing uses an expiring challenge, signed approval, and target-device possession proof.
- Primary recovery activates a replacement only after root-key persistence, verified snapshot restore, tail replay when necessary, and cursor acknowledgement.
- Key rotation prepares packages for every remaining active device plus recovery before advancing the epoch and revoking the selected device atomically.
- Lost responses and process restarts resume from persisted workflow state.

Emergency flags and kill switches can stop cloud writes or individual destructive workflows without preventing local reading and editing.

## V1 compatibility

V1 stores account and device metadata, cursors, hashes, and object pointers in Supabase and encrypted object bytes in Google Drive `appDataFolder`. Its latest-first restore uses a core partition, recent monthly partitions, and on-demand hydration of older months.

The compatibility schema is defined by `docs/supabase/001` through `018`, applied in numeric order. The SQL is still exercised by `npm run test:supabase`; do not remove or reorder these migrations while V1 accounts and migration code remain supported.

The V1-to-V2 migration drains pending V1 work, compares canonical state, validates a V2 snapshot through temporary restore, activates V2, and only then makes V1 read-only. V1 remote data is not automatically deleted.

## Security boundaries

- Rich text is sanitized before persistence, import, replay, editing, and display.
- Encrypted object hashes are checked before decryption and application.
- Web storage uses encrypted IndexedDB; Android storage fails closed if SQLCipher cannot open.
- Pending recovery devices cannot perform normal writes.
- Revoked, aborted, or pending devices are rejected by active-device authorization.
- Telemetry must never contain payloads, signed object URLs, tokens, recovery material, raw account identifiers, or journal content.

## Validation

```bash
npm run test:unit
npm run backend:test
npm run test:supabase
npm run test:ops
npm run build
```

The backend and Supabase integration suites require Docker for their PostgreSQL containers. Staging validation must also cover account creation, pairing, ordered replay, conflict handling, snapshot restore, restart during recovery and rotation, object-store failures, realtime or polling recovery, emergency controls, notification delivery, and garbage collection in dry-run mode.

See [production-operations.md](production-operations.md) for rollout, alerts, snapshots, advanced workflows, and garbage collection.
