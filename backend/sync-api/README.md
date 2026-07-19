# Dear Diary Sync API

Spring Boot modular-monolith foundation for the Sync V2 control plane.

Requirements:

- Java 21
- PostgreSQL 16 or newer for local integration tests and runtime

From the repository root:

```text
npm run backend:test
npm run backend:bootRun
```

Runtime database configuration is supplied through `SYNC_DB_URL`, `SYNC_DB_USERNAME`, and `SYNC_DB_PASSWORD`.
No production credentials are committed or required for unit tests.

## Container

Build the same Java 21 image used by the hosted service from this directory:

```text
docker build -t dear-diary-sync-api .
```

The container listens on `PORT` (default `8080`), runs as a non-root user, and exposes
`/actuator/health` for startup and liveness checks. Supply database, JWT, object-store,
and CORS settings at runtime; never add credentials to the image.

The API exposes `/actuator/health` without authentication. All `/api/v2/**` routes fail closed unless
`SYNC_JWT_ENABLED=true` and a valid Supabase issuer/JWKS configuration is supplied. Only tokens with a
non-empty subject and the `authenticated` role are accepted; anonymous and service-role tokens are rejected.

Flyway owns the PostgreSQL schema through 27 ordered migrations in `src/main/resources/db/migration`.
The migration integration test uses PostgreSQL 16 through Testcontainers and skips only when Docker is unavailable.

The authenticated Sync V2 API provides device registration and protocol negotiation, operation initiation,
atomic idempotent commit and reconciliation, gap-checked ordered event pull, monotonic per-device cursor
acknowledgement under `/api/v2/sync/**`. Encrypted payloads remain in the configured object store; the database
contains synchronization metadata and immutable object references.

Account-wide Sync V2 snapshots use a two-step upload and registration flow. A snapshot is discoverable only
after object size and SHA-256 verification and an atomic database activation. Restore clients verify size,
hash, encrypted object kind, key epoch, schema, account, partition, and through-sequence before atomically
replacing an empty V2 state and its cursor. Partial partition restore is intentionally unavailable while V2
uses a single global event cursor.

Advanced workflows expose durable server state machines for controlled V1-to-V2 migration, trusted-device
companion pairing, passphrase-wrapped primary recovery, and account-key rotation. Pairing uses short-lived
challenge/response requests and target-bound encrypted packages. Recovery activates the replacement primary
only after a local-key possession proof, verified snapshot restore, and cursor acknowledgment. Rotation advances
the server epoch atomically only after packages exist for every remaining active device plus recovery, revokes the
selected companion in the same transaction, and lets remaining devices prove application of their new package.
Key rotation and secure device revocation are enabled by migration V25 and retain independent emergency kill switches.

Remote object deletion is server-authoritative. The optional garbage-collection worker requires its own process
switch, the runtime protocol flag, and the global kill switch to be open. It defaults to dry-run, considers only
committed retired objects without live/pending/snapshot/key-package references, blocks accounts in safety stop or
active recovery/rotation, quarantines for a configurable delay, processes bounded batches, retries failures, and
records every destructive transition in `sync_gc_audit`.

Committed operations enqueue notification hints in the same database transaction. The optional notification
worker claims bounded batches with expiring leases, retries transient publishing failures with backoff, and
dead-letters exhausted or non-retryable messages. Enable it only after configuring both
`SYNC_NOTIFICATION_PUBLISHER_*` and `SYNC_NOTIFICATION_WORKER_*`; it is disabled by default.

Production observability uses structured JSON logs, correlation/trace/span identifiers, Micrometer
Prometheus metrics, and environment-configured OTLP trace export. Runtime flags, emergency mode,
minimum versions, and deterministic canary percentage are returned by the protocol endpoint and are
stored in PostgreSQL so an audited operator change takes effect without a client release. See
`docs/production-operations.md` for dashboards, alerts, emergency controls, and rollout procedure.
