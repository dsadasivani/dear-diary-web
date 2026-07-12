CREATE TABLE sync_gc_quarantine (
    account_id UUID NOT NULL,
    object_key TEXT NOT NULL,
    quarantine_id UUID NOT NULL,
    reason_code TEXT NOT NULL,
    eligible_sequence BIGINT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL,
    delete_not_before TIMESTAMPTZ NOT NULL,
    quarantine_status TEXT NOT NULL,
    reviewed_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, object_key),
    CONSTRAINT uq_sync_gc_quarantine_id UNIQUE (quarantine_id),
    CONSTRAINT fk_sync_gc_quarantine_object FOREIGN KEY (account_id, object_key)
        REFERENCES sync_objects(account_id, object_key),
    CONSTRAINT ck_sync_gc_quarantine_reason CHECK (length(btrim(reason_code)) > 0),
    CONSTRAINT ck_sync_gc_quarantine_sequence CHECK (eligible_sequence >= 1),
    CONSTRAINT ck_sync_gc_quarantine_delay CHECK (delete_not_before > quarantined_at),
    CONSTRAINT ck_sync_gc_quarantine_status CHECK (quarantine_status IN ('QUARANTINED', 'REVIEWED', 'DELETE_PENDING', 'DELETED', 'RELEASED')),
    CONSTRAINT ck_sync_gc_quarantine_deleted CHECK (
        (quarantine_status = 'DELETED' AND deleted_at IS NOT NULL) OR quarantine_status <> 'DELETED'
    )
);

CREATE INDEX idx_sync_gc_quarantine_eligible
    ON sync_gc_quarantine(quarantine_status, delete_not_before)
    WHERE quarantine_status IN ('QUARANTINED', 'REVIEWED', 'DELETE_PENDING');
