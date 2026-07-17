ALTER TABLE sync_key_rotations
    ADD COLUMN revoked_device_id UUID,
    ADD CONSTRAINT fk_sync_key_rotations_revoked_device FOREIGN KEY (account_id, revoked_device_id)
        REFERENCES sync_devices(account_id, device_id);

ALTER TABLE sync_key_rotations
    ADD CONSTRAINT ck_sync_key_rotations_distinct_devices CHECK (
        revoked_device_id IS NULL OR revoked_device_id <> initiated_by_device_id
    );
