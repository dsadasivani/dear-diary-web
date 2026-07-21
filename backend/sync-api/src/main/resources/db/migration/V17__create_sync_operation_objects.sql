ALTER TABLE sync_operations
    ADD COLUMN event_schema_version INTEGER NOT NULL DEFAULT 2,
    ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN partition_key TEXT NOT NULL DEFAULT 'core',
    ADD CONSTRAINT ck_sync_operations_event_schema CHECK (event_schema_version > 0),
    ADD CONSTRAINT ck_sync_operations_key_epoch CHECK (key_epoch > 0),
    ADD CONSTRAINT ck_sync_operations_partition CHECK (length(btrim(partition_key)) > 0);

ALTER TABLE sync_operations
    ALTER COLUMN event_schema_version DROP DEFAULT,
    ALTER COLUMN key_epoch DROP DEFAULT,
    ALTER COLUMN partition_key DROP DEFAULT;

CREATE TABLE sync_operation_objects (
    account_id UUID NOT NULL,
    operation_id UUID NOT NULL,
    object_key TEXT NOT NULL,
    object_kind TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    required BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, operation_id, object_key),
    CONSTRAINT fk_sync_operation_objects_operation FOREIGN KEY (account_id, operation_id)
        REFERENCES sync_operations(account_id, operation_id),
    CONSTRAINT fk_sync_operation_objects_object FOREIGN KEY (account_id, object_key)
        REFERENCES sync_objects(account_id, object_key),
    CONSTRAINT ck_sync_operation_objects_kind CHECK (object_kind IN ('EVENT', 'MEDIA', 'THUMBNAIL', 'SNAPSHOT', 'KEY_PACKAGE')),
    CONSTRAINT ck_sync_operation_objects_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_sync_operation_objects_size CHECK (size_bytes > 0)
);

CREATE UNIQUE INDEX uq_sync_operation_event_object
    ON sync_operation_objects(account_id, operation_id)
    WHERE object_kind = 'EVENT';
