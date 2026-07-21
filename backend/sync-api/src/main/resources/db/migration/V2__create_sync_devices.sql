CREATE TABLE sync_devices (
    device_id UUID PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    device_public_key BYTEA NOT NULL,
    device_role TEXT NOT NULL,
    device_status TEXT NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_protocol_version INTEGER NOT NULL,
    last_app_version TEXT,
    CONSTRAINT uq_sync_devices_account_device UNIQUE (account_id, device_id),
    CONSTRAINT ck_sync_devices_public_key CHECK (octet_length(device_public_key) BETWEEN 32 AND 16384),
    CONSTRAINT ck_sync_devices_role CHECK (device_role IN ('PRIMARY', 'COMPANION')),
    CONSTRAINT ck_sync_devices_status CHECK (device_status IN ('ACTIVE', 'RECOVERY_PENDING', 'REVOKED')),
    CONSTRAINT ck_sync_devices_protocol CHECK (created_protocol_version > 0),
    CONSTRAINT ck_sync_devices_revocation CHECK (
        (device_status = 'REVOKED' AND revoked_at IS NOT NULL) OR
        (device_status <> 'REVOKED' AND revoked_at IS NULL)
    )
);

CREATE INDEX idx_sync_devices_account_status ON sync_devices(account_id, device_status);
