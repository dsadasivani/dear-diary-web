CREATE TABLE sync_notification_outbox (
    notification_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    sequence BIGINT NOT NULL,
    notification_type TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ,
    CONSTRAINT uq_sync_notification_account_sequence_type UNIQUE (account_id, sequence, notification_type),
    CONSTRAINT ck_sync_notification_sequence CHECK (sequence >= 1),
    CONSTRAINT ck_sync_notification_type CHECK (notification_type IN ('SYNC_WAKE_UP')),
    CONSTRAINT ck_sync_notification_status CHECK (status IN ('PENDING', 'PUBLISHING', 'RETRY_WAIT', 'PUBLISHED', 'DEAD_LETTER')),
    CONSTRAINT ck_sync_notification_attempts CHECK (attempt_count >= 0),
    CONSTRAINT ck_sync_notification_published CHECK (
        (status = 'PUBLISHED' AND published_at IS NOT NULL) OR status <> 'PUBLISHED'
    )
);

CREATE INDEX idx_sync_notification_runnable
    ON sync_notification_outbox(status, next_attempt_at, created_at)
    WHERE status IN ('PENDING', 'RETRY_WAIT');
