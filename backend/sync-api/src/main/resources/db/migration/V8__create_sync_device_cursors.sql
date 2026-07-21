CREATE TABLE sync_device_cursors (
    account_id UUID NOT NULL,
    device_id UUID NOT NULL,
    last_applied_sequence BIGINT NOT NULL,
    last_acknowledged_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, device_id),
    CONSTRAINT fk_sync_device_cursors_device FOREIGN KEY (account_id, device_id)
        REFERENCES sync_devices(account_id, device_id),
    CONSTRAINT ck_sync_device_cursors_sequence CHECK (last_applied_sequence >= 0)
);
