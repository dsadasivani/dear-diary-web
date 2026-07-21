CREATE TABLE sync_objects (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    object_key TEXT NOT NULL,
    object_kind TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    key_epoch INTEGER NOT NULL,
    storage_status TEXT NOT NULL,
    created_sequence BIGINT,
    retired_sequence BIGINT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, object_key),
    CONSTRAINT ck_sync_objects_key CHECK (length(btrim(object_key)) > 0),
    CONSTRAINT ck_sync_objects_kind CHECK (object_kind IN ('EVENT', 'MEDIA', 'THUMBNAIL', 'SNAPSHOT', 'KEY_PACKAGE')),
    CONSTRAINT ck_sync_objects_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_sync_objects_size CHECK (size_bytes > 0),
    CONSTRAINT ck_sync_objects_key_epoch CHECK (key_epoch >= 1),
    CONSTRAINT ck_sync_objects_status CHECK (storage_status IN ('PENDING_UPLOAD', 'UPLOADED', 'COMMITTED', 'QUARANTINED', 'DELETE_PENDING', 'DELETED')),
    CONSTRAINT ck_sync_objects_sequences CHECK (
        (created_sequence IS NULL OR created_sequence >= 1) AND
        (retired_sequence IS NULL OR retired_sequence >= COALESCE(created_sequence, 1))
    )
);

CREATE INDEX idx_sync_objects_status ON sync_objects(account_id, storage_status, updated_at);
CREATE INDEX idx_sync_objects_retired ON sync_objects(account_id, retired_sequence) WHERE retired_sequence IS NOT NULL;
