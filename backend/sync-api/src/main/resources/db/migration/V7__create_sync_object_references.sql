CREATE TABLE sync_object_references (
    account_id UUID NOT NULL,
    object_key TEXT NOT NULL,
    owner_record_type TEXT NOT NULL,
    owner_record_id UUID NOT NULL,
    reference_kind TEXT NOT NULL,
    created_sequence BIGINT NOT NULL,
    deleted_sequence BIGINT,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, object_key, owner_record_type, owner_record_id, reference_kind, created_sequence),
    CONSTRAINT fk_sync_object_references_object FOREIGN KEY (account_id, object_key)
        REFERENCES sync_objects(account_id, object_key),
    CONSTRAINT ck_sync_object_references_owner_type CHECK (owner_record_type IN ('DIARY', 'ENTRY', 'NOTE', 'SETTINGS', 'PROFILE', 'ACCOUNT')),
    CONSTRAINT ck_sync_object_references_kind CHECK (reference_kind IN ('EVENT_PAYLOAD', 'MEDIA', 'THUMBNAIL', 'SNAPSHOT', 'KEY_PACKAGE')),
    CONSTRAINT ck_sync_object_references_created CHECK (created_sequence >= 1),
    CONSTRAINT ck_sync_object_references_deleted CHECK (deleted_sequence IS NULL OR deleted_sequence >= created_sequence)
);

CREATE INDEX idx_sync_object_references_owner
    ON sync_object_references(account_id, owner_record_type, owner_record_id, deleted_sequence);
CREATE INDEX idx_sync_object_references_live
    ON sync_object_references(account_id, object_key) WHERE deleted_sequence IS NULL;
