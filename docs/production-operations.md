# Production sync operations

The Sync V2 backend exposes health and Prometheus metrics through Actuator and exports sampled OTLP
traces when configured. Logs are structured JSON and contain correlation, trace, and span identifiers;
request bodies, signed object URLs, tokens, and diary content are never observability attributes.

Import `ops/prometheus/alerts.yml` and the four dashboards under `ops/grafana/dashboards`. Critical
integrity alerts page immediately. Operational alerts should page only after their configured window.

## Emergency controls

Runtime controls are stored in `sync_protocol_config` and `sync_kill_switches`. Engage a switch with a
non-sensitive reason code and operator identity through an audited administrative database workflow.
Emergency mode keeps local writes available, disables cloud writes and every destructive workflow,
and preserves the configured remote-pull setting. Clients cache the last response but fail closed for
cloud writes, uploads, deletion, snapshots, recovery, rotation, revocation, and pairing when refresh fails.

## Canary rollout

Keep `sync_v2_rollout_percentage` at `0` until pre-production gates pass. Increase through 1, 5, 25,
50, and 100 percent while holding `rollout_salt_version` stable. Assignment uses a telemetry-specific
pseudonym, never a raw account or device identifier. Halt or roll back to zero on any integrity alert,
SLO breach, unexpected conflict increase, or persistent dependency degradation. Raising the salt
version reshuffles the cohort and is not part of a normal percentage increase.

The minimum app and read/write protocol versions are independent controls. Raising them blocks cloud
activity but does not block local reading or local-first editing.

## Snapshot operations

Keep `snapshot_creation_enabled` and the `SNAPSHOT_CREATION` kill switch disabled until the V2 canary
has stable ordered replay and object-storage metrics. Creation exports one account-wide canonical
partition at the current global sequence, encrypts it locally, and retains only encrypted upload bytes
in the restart journal. The server exposes a snapshot only after its object metadata is verified and
the snapshot plus its object reference are committed atomically.

Restore is accepted only into an empty V2 state. Clients verify encrypted size, SHA-256, object kind,
key epoch, schema, account, partition, and through-sequence before atomically installing state and the
cursor. A failed or interrupted import leaves the previous local state unchanged. Monthly partial V2
snapshot restore remains disabled because the current V2 event API uses one global cursor; enabling it
without partition cursors could skip events.
