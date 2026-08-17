-- Schema v3 identifies snapshots whose encrypted chunks may contain bounded
-- canonical-record batches instead of byte slices from one materialized JSON object.
-- Schema v2 snapshots remain readable by current clients.
UPDATE sync_protocol_config
SET snapshot_schema_version = 3,
    updated_at = CURRENT_TIMESTAMP
WHERE config_id = 1
  AND snapshot_schema_version < 3;
