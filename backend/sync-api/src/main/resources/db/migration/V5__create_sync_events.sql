CREATE TABLE sync_events (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    sequence BIGINT NOT NULL,
    event_id UUID NOT NULL,
    operation_id UUID NOT NULL,
    device_id UUID NOT NULL,
    record_type TEXT NOT NULL,
    record_id UUID NOT NULL,
    operation_type TEXT NOT NULL,
    record_version BIGINT NOT NULL,
    key_epoch INTEGER NOT NULL,
    partition_key TEXT NOT NULL,
    object_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    event_schema_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, sequence),
    CONSTRAINT uq_sync_events_event UNIQUE (account_id, event_id),
    CONSTRAINT uq_sync_events_operation UNIQUE (account_id, operation_id),
    CONSTRAINT fk_sync_events_operation FOREIGN KEY (account_id, operation_id)
        REFERENCES sync_operations(account_id, operation_id),
    CONSTRAINT fk_sync_events_device FOREIGN KEY (account_id, device_id)
        REFERENCES sync_devices(account_id, device_id),
    CONSTRAINT ck_sync_events_sequence CHECK (sequence >= 1),
    CONSTRAINT ck_sync_events_record_type CHECK (record_type IN ('DIARY', 'ENTRY', 'NOTE', 'SETTINGS', 'PROFILE')),
    CONSTRAINT ck_sync_events_operation_type CHECK (operation_type IN ('UPSERT', 'DELETE')),
    CONSTRAINT ck_sync_events_record_version CHECK (record_version >= 1),
    CONSTRAINT ck_sync_events_key_epoch CHECK (key_epoch >= 1),
    CONSTRAINT ck_sync_events_partition CHECK (length(btrim(partition_key)) > 0),
    CONSTRAINT ck_sync_events_object_key CHECK (length(btrim(object_key)) > 0),
    CONSTRAINT ck_sync_events_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_sync_events_size CHECK (size_bytes > 0),
    CONSTRAINT ck_sync_events_schema CHECK (event_schema_version > 0)
);

CREATE INDEX idx_sync_events_record ON sync_events(account_id, record_type, record_id, sequence);
CREATE INDEX idx_sync_events_partition ON sync_events(account_id, partition_key, sequence);
CREATE INDEX idx_sync_events_created ON sync_events(account_id, created_at);
