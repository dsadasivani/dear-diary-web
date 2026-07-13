ALTER TABLE sync_snapshots
    ADD COLUMN created_by_device_id UUID REFERENCES sync_devices(device_id),
    ADD COLUMN protocol_version INTEGER;

ALTER TABLE sync_protocol_config
    ADD COLUMN maximum_snapshot_bytes BIGINT NOT NULL DEFAULT 104857600,
    ADD CONSTRAINT ck_sync_protocol_snapshot_size CHECK (maximum_snapshot_bytes > 0);

ALTER TABLE sync_snapshots DROP CONSTRAINT ck_sync_snapshots_status;
ALTER TABLE sync_snapshots ADD CONSTRAINT ck_sync_snapshots_status
    CHECK (snapshot_status IN ('UPLOADING', 'AVAILABLE', 'RETIRED', 'QUARANTINED'));

ALTER TABLE sync_snapshots ADD CONSTRAINT ck_sync_snapshots_protocol
    CHECK (protocol_version IS NULL OR protocol_version > 0);

CREATE UNIQUE INDEX uq_sync_snapshots_object
    ON sync_snapshots(account_id, object_key);

CREATE INDEX idx_sync_snapshots_uploading
    ON sync_snapshots(account_id, created_at)
    WHERE snapshot_status = 'UPLOADING';
