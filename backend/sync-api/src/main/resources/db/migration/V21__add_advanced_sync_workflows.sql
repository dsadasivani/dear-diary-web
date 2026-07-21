ALTER TABLE sync_accounts
    ADD COLUMN v1_mode TEXT NOT NULL DEFAULT 'READ_WRITE',
    ADD CONSTRAINT ck_sync_accounts_v1_mode CHECK (v1_mode IN ('READ_WRITE', 'READ_ONLY'));

CREATE TABLE sync_migrations (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    migration_id UUID NOT NULL,
    device_id UUID NOT NULL,
    migration_status TEXT NOT NULL,
    baseline_digest TEXT NOT NULL,
    validation_digest TEXT,
    baseline_sequence BIGINT NOT NULL,
    activated_sequence BIGINT,
    snapshot_id UUID,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, migration_id),
    CONSTRAINT fk_sync_migrations_device FOREIGN KEY (account_id, device_id)
        REFERENCES sync_devices(account_id, device_id),
    CONSTRAINT ck_sync_migrations_status CHECK (migration_status IN (
        'PRECHECK', 'DRAINING_V1', 'VALIDATING_LOCAL_STATE', 'CREATING_V2_SNAPSHOT',
        'UPLOADING_V2_SNAPSHOT', 'REGISTERING_V2_ACCOUNT', 'VERIFYING_V2_RESTORE',
        'V2_ACTIVE', 'V1_READ_ONLY', 'FAILED', 'ROLLED_BACK'
    )),
    CONSTRAINT ck_sync_migrations_digest CHECK (
        baseline_digest ~ '^[0-9a-f]{64}$' AND
        (validation_digest IS NULL OR validation_digest ~ '^[0-9a-f]{64}$')
    ),
    CONSTRAINT ck_sync_migrations_sequences CHECK (
        baseline_sequence >= 0 AND
        (activated_sequence IS NULL OR activated_sequence >= baseline_sequence)
    )
);

CREATE UNIQUE INDEX uq_sync_migrations_active ON sync_migrations(account_id)
    WHERE migration_status NOT IN ('V1_READ_ONLY', 'FAILED', 'ROLLED_BACK');

CREATE TABLE sync_pairing_requests (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    pairing_id UUID NOT NULL,
    requested_device_id UUID NOT NULL,
    requested_device_public_key BYTEA NOT NULL,
    requested_device_role TEXT NOT NULL,
    platform TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    challenge BYTEA NOT NULL,
    pairing_status TEXT NOT NULL,
    approved_by_device_id UUID,
    key_package_id UUID,
    requested_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    approved_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, pairing_id),
    CONSTRAINT uq_sync_pairing_device UNIQUE (account_id, requested_device_id),
    CONSTRAINT fk_sync_pairing_approver FOREIGN KEY (account_id, approved_by_device_id)
        REFERENCES sync_devices(account_id, device_id),
    CONSTRAINT ck_sync_pairing_key CHECK (octet_length(requested_device_public_key) BETWEEN 32 AND 16384),
    CONSTRAINT ck_sync_pairing_role CHECK (requested_device_role = 'COMPANION'),
    CONSTRAINT ck_sync_pairing_code CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_sync_pairing_challenge CHECK (octet_length(challenge) BETWEEN 16 AND 128),
    CONSTRAINT ck_sync_pairing_status CHECK (pairing_status IN (
        'REQUESTED', 'APPROVED', 'KEY_PACKAGE_PENDING', 'KEY_PACKAGE_AVAILABLE',
        'COMPLETED', 'EXPIRED', 'REJECTED'
    )),
    CONSTRAINT ck_sync_pairing_expiry CHECK (expires_at > requested_at)
);

ALTER TABLE sync_key_packages
    ADD COLUMN package_purpose TEXT NOT NULL DEFAULT 'DEVICE',
    ADD COLUMN sha256 TEXT,
    ADD COLUMN size_bytes BIGINT,
    ADD COLUMN package_schema_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN created_by_device_id UUID,
    ADD COLUMN pairing_id UUID,
    ADD COLUMN recovery_attempt_id UUID,
    ADD COLUMN rotation_id UUID,
    ADD CONSTRAINT fk_sync_key_packages_creator FOREIGN KEY (account_id, created_by_device_id)
        REFERENCES sync_devices(account_id, device_id),
    ADD CONSTRAINT ck_sync_key_packages_purpose CHECK (package_purpose IN ('DEVICE', 'RECOVERY')),
    ADD CONSTRAINT ck_sync_key_packages_integrity CHECK (
        (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$') AND
        (size_bytes IS NULL OR size_bytes > 0) AND package_schema_version > 0
    );

UPDATE sync_key_packages k SET sha256 = o.sha256, size_bytes = o.size_bytes
FROM sync_objects o
WHERE o.account_id = k.account_id AND o.object_key = k.object_key;

ALTER TABLE sync_key_packages
    ALTER COLUMN sha256 SET NOT NULL,
    ALTER COLUMN size_bytes SET NOT NULL;

ALTER TABLE sync_key_packages DROP CONSTRAINT uq_sync_key_packages_device_epoch;
CREATE UNIQUE INDEX uq_sync_key_packages_device_epoch_purpose
    ON sync_key_packages(account_id, target_device_id, key_epoch, package_purpose);

ALTER TABLE sync_recovery_state DROP CONSTRAINT ck_sync_recovery_status;
UPDATE sync_recovery_state SET recovery_status = CASE recovery_status
    WHEN 'IDLE' THEN 'NONE'
    WHEN 'PENDING' THEN 'REQUESTED'
    WHEN 'VALIDATING' THEN 'APPROVED'
    WHEN 'READY' THEN 'KEY_PACKAGE_AVAILABLE'
    ELSE recovery_status
END;
ALTER TABLE sync_recovery_state ADD CONSTRAINT ck_sync_recovery_status CHECK (recovery_status IN (
    'NONE', 'REQUESTED', 'APPROVED', 'KEY_PACKAGE_PENDING', 'KEY_PACKAGE_AVAILABLE',
    'LOCAL_KEY_PERSISTED', 'FINALIZING', 'COMPLETED', 'FAILED'
));
ALTER TABLE sync_recovery_state DROP CONSTRAINT ck_sync_recovery_attempt;
ALTER TABLE sync_recovery_state ADD CONSTRAINT ck_sync_recovery_attempt CHECK (
    recovery_status = 'NONE' OR
    (recovery_attempt_id IS NOT NULL AND requested_at IS NOT NULL AND expires_at IS NOT NULL)
);
ALTER TABLE sync_recovery_state
    ADD COLUMN recovery_device_id UUID,
    ADD COLUMN validation_snapshot_id UUID,
    ADD CONSTRAINT fk_sync_recovery_target FOREIGN KEY (account_id, recovery_device_id)
        REFERENCES sync_devices(account_id, device_id);

ALTER TABLE sync_key_rotations DROP CONSTRAINT ck_sync_key_rotations_status;
DROP INDEX uq_sync_key_rotations_active;
UPDATE sync_key_rotations SET rotation_status = CASE rotation_status
    WHEN 'INITIATED' THEN 'PREPARING'
    WHEN 'PACKAGES_PENDING' THEN 'NEW_KEY_CREATED'
    WHEN 'READY_TO_FINALIZE' THEN 'SERVER_EPOCH_PENDING'
    ELSE rotation_status
END;
ALTER TABLE sync_key_rotations ADD CONSTRAINT ck_sync_key_rotations_status CHECK (rotation_status IN (
    'PREPARING', 'NEW_KEY_CREATED', 'KEY_PACKAGES_CREATED', 'SERVER_EPOCH_PENDING',
    'SERVER_EPOCH_COMMITTED', 'LOCAL_STATE_COMMITTED', 'COMPLETED', 'FAILED', 'CANCELLED'
));
CREATE UNIQUE INDEX uq_sync_key_rotations_active ON sync_key_rotations(account_id)
    WHERE rotation_status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');

ALTER TABLE sync_gc_quarantine
    ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN last_error_code TEXT,
    ADD COLUMN claimed_at TIMESTAMPTZ,
    ADD CONSTRAINT ck_sync_gc_attempts CHECK (attempt_count >= 0);

CREATE INDEX idx_sync_operations_gc_pending ON sync_operations(account_id, operation_status)
    WHERE operation_status NOT IN ('COMMITTED', 'CONFLICT');

CREATE TABLE sync_gc_audit (
    audit_id UUID PRIMARY KEY,
    account_id UUID NOT NULL,
    object_key TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    error_code TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT fk_sync_gc_audit_object FOREIGN KEY (account_id, object_key)
        REFERENCES sync_objects(account_id, object_key),
    CONSTRAINT ck_sync_gc_audit_status CHECK (to_status IN ('QUARANTINED', 'DELETE_PENDING', 'DELETED', 'RETRY_WAIT'))
);

CREATE INDEX idx_sync_gc_audit_object ON sync_gc_audit(account_id, object_key, occurred_at);
