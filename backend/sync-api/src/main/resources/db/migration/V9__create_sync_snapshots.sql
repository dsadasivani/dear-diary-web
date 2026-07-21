CREATE TABLE sync_snapshots (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    snapshot_id UUID NOT NULL,
    sequence BIGINT NOT NULL,
    partition_key TEXT NOT NULL,
    object_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    key_epoch INTEGER NOT NULL,
    snapshot_schema_version INTEGER NOT NULL,
    snapshot_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    retired_at TIMESTAMPTZ,
    PRIMARY KEY (account_id, snapshot_id),
    CONSTRAINT uq_sync_snapshots_partition_sequence UNIQUE (account_id, partition_key, sequence),
    CONSTRAINT fk_sync_snapshots_object FOREIGN KEY (account_id, object_key)
        REFERENCES sync_objects(account_id, object_key),
    CONSTRAINT ck_sync_snapshots_sequence CHECK (sequence >= 0),
    CONSTRAINT ck_sync_snapshots_partition CHECK (length(btrim(partition_key)) > 0),
    CONSTRAINT ck_sync_snapshots_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_sync_snapshots_size CHECK (size_bytes > 0),
    CONSTRAINT ck_sync_snapshots_epoch CHECK (key_epoch >= 1),
    CONSTRAINT ck_sync_snapshots_schema CHECK (snapshot_schema_version > 0),
    CONSTRAINT ck_sync_snapshots_status CHECK (snapshot_status IN ('AVAILABLE', 'RETIRED', 'QUARANTINED')),
    CONSTRAINT ck_sync_snapshots_retired CHECK (
        (snapshot_status = 'RETIRED' AND retired_at IS NOT NULL) OR snapshot_status <> 'RETIRED'
    )
);

CREATE INDEX idx_sync_snapshots_latest ON sync_snapshots(account_id, partition_key, sequence DESC);
