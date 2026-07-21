CREATE TABLE sync_recovery_state (
    account_id UUID PRIMARY KEY REFERENCES sync_accounts(account_id),
    recovery_attempt_id UUID,
    requested_by_device_id UUID,
    recovery_status TEXT NOT NULL,
    requested_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    last_error_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_sync_recovery_device FOREIGN KEY (account_id, requested_by_device_id)
        REFERENCES sync_devices(account_id, device_id),
    CONSTRAINT ck_sync_recovery_status CHECK (recovery_status IN ('IDLE', 'PENDING', 'VALIDATING', 'READY', 'COMPLETED', 'FAILED')),
    CONSTRAINT ck_sync_recovery_attempt CHECK (
        recovery_status = 'IDLE' OR
        (recovery_attempt_id IS NOT NULL AND requested_at IS NOT NULL AND expires_at IS NOT NULL)
    ),
    CONSTRAINT ck_sync_recovery_expiry CHECK (expires_at IS NULL OR requested_at IS NULL OR expires_at > requested_at),
    CONSTRAINT ck_sync_recovery_completed CHECK (
        (recovery_status = 'COMPLETED' AND completed_at IS NOT NULL) OR recovery_status <> 'COMPLETED'
    )
);
