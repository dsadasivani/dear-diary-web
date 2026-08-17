-- Snapshot-first bootstrap is now required for bounded companion linking and
-- stale-device rebootstrap. Event deletion remains separately gated so the
-- retention worker can continue its dry-run/grace validation before rollout.
UPDATE sync_protocol_config
SET rolling_snapshots_enabled = TRUE,
    bootstrap_manifest_enabled = TRUE,
    updated_at = CURRENT_TIMESTAMP
WHERE config_id = 1;
