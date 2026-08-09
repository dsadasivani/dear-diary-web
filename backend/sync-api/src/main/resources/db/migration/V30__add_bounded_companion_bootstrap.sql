ALTER TABLE sync_accounts
    ADD COLUMN minimum_available_sequence BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT ck_sync_accounts_minimum_available_sequence CHECK (
        minimum_available_sequence >= 0 AND minimum_available_sequence <= current_sequence
    );

ALTER TABLE sync_devices
    ADD COLUMN rebootstrap_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE sync_snapshots
    ADD COLUMN metadata_signature TEXT,
    ADD COLUMN verified BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE sync_pairing_requests DROP CONSTRAINT ck_sync_pairing_status;
ALTER TABLE sync_pairing_requests ADD CONSTRAINT ck_sync_pairing_status CHECK (pairing_status IN (
    'REQUESTED', 'SNAPSHOT_PREPARING', 'APPROVED', 'KEY_PACKAGE_PENDING',
    'KEY_PACKAGE_AVAILABLE', 'BOOTSTRAP_READY', 'ACTIVATING',
    'COMPLETED', 'EXPIRED', 'REJECTED'
));

CREATE TABLE sync_bootstraps (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    bootstrap_id UUID NOT NULL,
    device_id UUID NOT NULL,
    pairing_id UUID,
    snapshot_id UUID NOT NULL,
    snapshot_sequence BIGINT NOT NULL,
    head_sequence BIGINT NOT NULL,
    required_key_epochs INTEGER[] NOT NULL,
    bootstrap_status TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, bootstrap_id),
    CONSTRAINT fk_sync_bootstrap_device FOREIGN KEY (account_id, device_id)
        REFERENCES sync_devices(account_id, device_id),
    CONSTRAINT fk_sync_bootstrap_pairing FOREIGN KEY (account_id, pairing_id)
        REFERENCES sync_pairing_requests(account_id, pairing_id),
    CONSTRAINT fk_sync_bootstrap_snapshot FOREIGN KEY (account_id, snapshot_id)
        REFERENCES sync_snapshots(account_id, snapshot_id),
    CONSTRAINT ck_sync_bootstrap_sequences CHECK (
        snapshot_sequence >= 0 AND head_sequence >= snapshot_sequence
    ),
    CONSTRAINT ck_sync_bootstrap_status CHECK (bootstrap_status IN (
        'READY', 'ACTIVATING', 'COMPLETED', 'EXPIRED', 'FAILED'
    )),
    CONSTRAINT ck_sync_bootstrap_expiry CHECK (expires_at > created_at),
    CONSTRAINT ck_sync_bootstrap_completion CHECK (
        (bootstrap_status = 'COMPLETED' AND completed_at IS NOT NULL) OR
        (bootstrap_status <> 'COMPLETED' AND completed_at IS NULL)
    )
);

CREATE INDEX idx_sync_bootstraps_expiry
    ON sync_bootstraps (bootstrap_status, expires_at);
CREATE INDEX idx_sync_bootstraps_snapshot
    ON sync_bootstraps (account_id, snapshot_id, bootstrap_status);
CREATE UNIQUE INDEX uq_sync_bootstraps_active_device
    ON sync_bootstraps (account_id, device_id)
    WHERE completed_at IS NULL AND bootstrap_status NOT IN ('EXPIRED', 'FAILED');

CREATE TABLE sync_event_retention_candidates (
    account_id UUID PRIMARY KEY REFERENCES sync_accounts(account_id),
    eligible_through_sequence BIGINT NOT NULL,
    candidate_status TEXT NOT NULL,
    first_eligible_at TIMESTAMPTZ NOT NULL,
    delete_not_before TIMESTAMPTZ NOT NULL,
    last_verified_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ,
    CONSTRAINT ck_sync_event_retention_sequence CHECK (eligible_through_sequence >= 0),
    CONSTRAINT ck_sync_event_retention_status CHECK (
        candidate_status IN ('DRY_RUN', 'GRACE', 'DELETED', 'RELEASED')
    ),
    CONSTRAINT ck_sync_event_retention_delay CHECK (delete_not_before > first_eligible_at)
);

ALTER TABLE sync_protocol_config
    ADD COLUMN atomic_replay_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN rolling_snapshots_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN bootstrap_manifest_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN retention_deletion_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN bootstrap_soft_tail INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN bootstrap_hard_tail INTEGER NOT NULL DEFAULT 500,
    ADD COLUMN maximum_snapshot_age_days INTEGER NOT NULL DEFAULT 7,
    ADD COLUMN replay_batch_size INTEGER NOT NULL DEFAULT 25,
    ADD COLUMN bootstrap_expiry_minutes INTEGER NOT NULL DEFAULT 60,
    ADD CONSTRAINT ck_sync_bootstrap_controls CHECK (
        bootstrap_soft_tail > 0 AND
        bootstrap_hard_tail >= bootstrap_soft_tail AND
        maximum_snapshot_age_days > 0 AND
        replay_batch_size BETWEEN 1 AND 100 AND
        bootstrap_expiry_minutes BETWEEN 5 AND 1440
    );

UPDATE sync_protocol_config
SET current_protocol_version = 4,
    updated_at = CURRENT_TIMESTAMP
WHERE config_id = 1;
