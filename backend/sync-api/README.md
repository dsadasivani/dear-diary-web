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

The API exposes `/actuator/health` without authentication. All `/api/v2/**` routes fail closed unless
`SYNC_JWT_ENABLED=true` and a valid Supabase issuer/JWKS configuration is supplied. Only tokens with a
non-empty subject and the `authenticated` role are accepted; anonymous and service-role tokens are rejected.

Flyway owns the PostgreSQL schema through 20 ordered migrations in `src/main/resources/db/migration`.
The migration integration test uses PostgreSQL 16 through Testcontainers and skips only when Docker is unavailable.

The authenticated Sync V2 API provides device registration and protocol negotiation, operation initiation,
atomic idempotent commit and reconciliation, gap-checked ordered event pull, and monotonic per-device cursor
acknowledgement under `/api/v2/sync/**`. Encrypted payloads remain in the configured object store; the database
contains synchronization metadata and immutable object references.

Account-wide Sync V2 snapshots use a two-step upload and registration flow. A snapshot is discoverable only
after object size and SHA-256 verification and an atomic database activation. Restore clients verify size,
hash, encrypted object kind, key epoch, schema, account, partition, and through-sequence before atomically
replacing an empty V2 state and its cursor. Partial partition restore is intentionally unavailable while V2
uses a single global event cursor.

Committed operations enqueue notification hints in the same database transaction. The optional notification
worker claims bounded batches with expiring leases, retries transient publishing failures with backoff, and
dead-letters exhausted or non-retryable messages. Enable it only after configuring both
`SYNC_NOTIFICATION_PUBLISHER_*` and `SYNC_NOTIFICATION_WORKER_*`; it is disabled by default.

Production observability uses structured JSON logs, correlation/trace/span identifiers, Micrometer
Prometheus metrics, and environment-configured OTLP trace export. Runtime flags, emergency mode,
minimum versions, and deterministic canary percentage are returned by the protocol endpoint and are
stored in PostgreSQL so an audited operator change takes effect without a client release. See
`docs/production-operations.md` for dashboards, alerts, emergency controls, and rollout procedure.
