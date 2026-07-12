CREATE TABLE sync_operations (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    operation_id UUID NOT NULL,
    device_id UUID NOT NULL,
    record_type TEXT NOT NULL,
    record_id UUID NOT NULL,
    operation_type TEXT NOT NULL,
    base_record_version BIGINT NOT NULL,
    operation_status TEXT NOT NULL,
    protocol_version INTEGER NOT NULL,
    committed_sequence BIGINT,
    committed_record_version BIGINT,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, operation_id),
    CONSTRAINT fk_sync_operations_device FOREIGN KEY (account_id, device_id)
        REFERENCES sync_devices(account_id, device_id),
    CONSTRAINT ck_sync_operations_record_type CHECK (record_type IN ('DIARY', 'ENTRY', 'NOTE', 'SETTINGS', 'PROFILE')),
    CONSTRAINT ck_sync_operations_type CHECK (operation_type IN ('UPSERT', 'DELETE')),
    CONSTRAINT ck_sync_operations_status CHECK (operation_status IN ('INITIATED', 'OBJECTS_PENDING', 'READY_TO_COMMIT', 'COMMITTED', 'CONFLICT', 'REJECTED')),
    CONSTRAINT ck_sync_operations_base_version CHECK (base_record_version >= 0),
    CONSTRAINT ck_sync_operations_protocol CHECK (protocol_version > 0),
    CONSTRAINT ck_sync_operations_commit_values CHECK (
        (committed_sequence IS NULL AND committed_record_version IS NULL) OR
        (committed_sequence >= 1 AND committed_record_version >= 1)
    ),
    CONSTRAINT ck_sync_operations_committed_status CHECK (
        operation_status <> 'COMMITTED' OR committed_sequence IS NOT NULL
    )
);

CREATE INDEX idx_sync_operations_device_created ON sync_operations(account_id, device_id, created_at);
CREATE INDEX idx_sync_operations_status_updated ON sync_operations(account_id, operation_status, updated_at);
