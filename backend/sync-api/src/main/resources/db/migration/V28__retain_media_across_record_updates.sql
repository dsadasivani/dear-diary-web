CREATE TABLE sync_operation_retained_media (
    account_id UUID NOT NULL,
    operation_id UUID NOT NULL,
    object_key TEXT NOT NULL,
    object_kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, operation_id, object_key),
    CONSTRAINT fk_sync_operation_retained_media_operation
        FOREIGN KEY (account_id, operation_id)
        REFERENCES sync_operations(account_id, operation_id) ON DELETE CASCADE,
    CONSTRAINT fk_sync_operation_retained_media_object
        FOREIGN KEY (account_id, object_key)
        REFERENCES sync_objects(account_id, object_key),
    CONSTRAINT ck_sync_operation_retained_media_kind
        CHECK (object_kind IN ('MEDIA', 'THUMBNAIL'))
);
