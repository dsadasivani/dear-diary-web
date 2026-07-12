CREATE TABLE sync_key_packages (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    key_package_id UUID NOT NULL,
    target_device_id UUID NOT NULL,
    key_epoch INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    package_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    applied_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, key_package_id),
    CONSTRAINT uq_sync_key_packages_device_epoch UNIQUE (account_id, target_device_id, key_epoch),
    CONSTRAINT fk_sync_key_packages_device FOREIGN KEY (account_id, target_device_id)
        REFERENCES sync_devices(account_id, device_id),
    CONSTRAINT fk_sync_key_packages_object FOREIGN KEY (account_id, object_key)
        REFERENCES sync_objects(account_id, object_key),
    CONSTRAINT ck_sync_key_packages_epoch CHECK (key_epoch >= 1),
    CONSTRAINT ck_sync_key_packages_status CHECK (package_status IN ('PENDING_UPLOAD', 'AVAILABLE', 'APPLIED', 'REVOKED')),
    CONSTRAINT ck_sync_key_packages_applied CHECK (
        (package_status = 'APPLIED' AND applied_at IS NOT NULL) OR package_status <> 'APPLIED'
    )
);

CREATE INDEX idx_sync_key_packages_pending ON sync_key_packages(account_id, target_device_id, package_status, key_epoch);
