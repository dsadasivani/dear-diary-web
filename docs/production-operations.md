# Production sync operations

The Loredays Sync backend sends metrics, structured logs, and sampled traces to Grafana Cloud over OTLP.
Logs contain correlation, trace, and span identifiers;
request bodies, signed object URLs, tokens, and diary content are never observability attributes.

Import `ops/prometheus/alerts.yml` and all six dashboards under `ops/grafana/dashboards` into Grafana
Cloud. Critical
integrity alerts page immediately. Operational alerts should page only after their configured window.
Keep `SYNC_PROMETHEUS_PUBLIC_ENABLED=false`; the hosted service pushes metrics over authenticated OTLP.

## Emergency controls

Runtime controls are stored in `sync_protocol_config` and `sync_kill_switches`. Engage a switch with a
non-sensitive reason code and operator identity through an audited administrative database workflow.
Emergency mode keeps local writes available, disables cloud writes and every destructive workflow,
and preserves the configured remote-pull setting. Clients cache the last response but fail closed for
cloud writes, uploads, deletion, snapshots, recovery, rotation, revocation, and pairing when refresh fails.

The minimum app and read/write protocol versions are independent controls. Raising them blocks cloud
activity but does not block local reading or local-first editing.

## Snapshot operations

Keep `snapshot_creation_enabled` and the `SNAPSHOT_CREATION` kill switch disabled until staging
has stable ordered replay and object-storage metrics. Creation exports one account-wide canonical
partition at the current global sequence, encrypts it locally, and retains only encrypted upload bytes
in the restart journal. The server exposes a snapshot only after its object metadata is verified and
the snapshot plus its object reference are committed atomically.

Restore is accepted only into an empty sync state. Clients verify encrypted size, SHA-256, object kind,
key epoch, schema, account, partition, and through-sequence before atomically installing state and the
cursor. A failed or interrupted import leaves the previous local state unchanged. Monthly partial
snapshot restore remains disabled because the event API uses one global cursor; enabling it
without partition cursors could skip events.

Keep `companion_pairing_enabled`, `primary_recovery_enabled`, and `key_rotation_enabled` false, with their matching
kill switches engaged, until the feature has passed staging recovery drills. Pairing requires an active primary,
an expiring challenge, signed approval, and target-device possession proof. Recovery does not revoke the prior
primary until the replacement has persisted the root key, decrypted/restored a validation snapshot, and acknowledged
the current cursor. Rotation creates packages for all active devices and a recovery package before atomically
advancing the server epoch; revoked devices are excluded. Crashed workflows resume from their server and encrypted
local journals. Monitor `sync_advanced_workflow_total` by workflow, action, and outcome.

## Garbage collection operations

GC has three independent gates: `SYNC_GC_WORKER_ENABLED=true`, `garbage_collection_enabled=true`, and an open
`GARBAGE_COLLECTION` kill switch. Start with `SYNC_GC_DRY_RUN=true` and review candidate metrics and reference
queries for at least one full retention window. Production defaults retain tombstoned objects for 30 days and then
quarantine them for another 30 days before deletion. Accounts in safety stop or active recovery/rotation are skipped.

Review `deardiary_sync_gc_candidates_total`, `deardiary_sync_gc_quarantined_total`, and
`deardiary_sync_gc_deleted_total`, plus `sync_gc_audit`, before disabling dry-run. To stop deletion immediately,
engage the database kill switch or disable the worker; quarantined objects remain recoverable until their delayed
deletion succeeds. Do not delete object-store data directly or delegate eligibility to mobile clients.
