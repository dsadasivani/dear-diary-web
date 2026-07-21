ALTER TABLE sync_notification_outbox
    ADD COLUMN lease_owner TEXT,
    ADD COLUMN lease_expires_at TIMESTAMPTZ,
    ADD COLUMN last_error_code TEXT,
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD CONSTRAINT ck_sync_notification_lease CHECK (
        (lease_owner IS NULL AND lease_expires_at IS NULL) OR
        (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    );

CREATE INDEX idx_sync_notification_recoverable
    ON sync_notification_outbox(status, lease_expires_at)
    WHERE status = 'PUBLISHING';
