-- Chunked snapshots keep each transfer bounded while allowing long-lived accounts
-- to exceed the original 100 MiB full-snapshot ceiling. This remains below the
-- default plan's aggregate storage quota and does not enable retention deletion.
UPDATE sync_protocol_config
SET maximum_snapshot_bytes = 268435456,
    updated_at = CURRENT_TIMESTAMP
WHERE config_id = 1
  AND maximum_snapshot_bytes < 268435456;
