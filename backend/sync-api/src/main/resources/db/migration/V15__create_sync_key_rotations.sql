CREATE TABLE sync_key_rotations (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    rotation_id UUID NOT NULL,
    initiated_by_device_id UUID NOT NULL,
    from_key_epoch INTEGER NOT NULL,
    to_key_epoch INTEGER NOT NULL,
    rotation_status TEXT NOT NULL,
    initiated_at TIMESTAMPTZ NOT NULL,
    finalized_at TIMESTAMPTZ,
    last_error_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, rotation_id),
    CONSTRAINT uq_sync_key_rotations_target_epoch UNIQUE (account_id, to_key_epoch),
    CONSTRAINT fk_sync_key_rotations_device FOREIGN KEY (account_id, initiated_by_device_id)
        REFERENCES sync_devices(account_id, device_id),
    CONSTRAINT ck_sync_key_rotations_epochs CHECK (from_key_epoch >= 1 AND to_key_epoch = from_key_epoch + 1),
    CONSTRAINT ck_sync_key_rotations_status CHECK (rotation_status IN ('INITIATED', 'PACKAGES_PENDING', 'READY_TO_FINALIZE', 'COMPLETED', 'FAILED', 'CANCELLED')),
    CONSTRAINT ck_sync_key_rotations_finalized CHECK (
        (rotation_status = 'COMPLETED' AND finalized_at IS NOT NULL) OR rotation_status <> 'COMPLETED'
    )
);

CREATE UNIQUE INDEX uq_sync_key_rotations_active
    ON sync_key_rotations(account_id)
    WHERE rotation_status IN ('INITIATED', 'PACKAGES_PENDING', 'READY_TO_FINALIZE');
