CREATE TABLE sync_snapshot_chunks (
    account_id UUID NOT NULL,
    snapshot_id UUID NOT NULL,
    chunk_index INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    key_epoch INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, snapshot_id, chunk_index),
    CONSTRAINT uq_sync_snapshot_chunk_object UNIQUE (account_id, object_key),
    CONSTRAINT fk_sync_snapshot_chunks_snapshot
        FOREIGN KEY (account_id, snapshot_id)
        REFERENCES sync_snapshots(account_id, snapshot_id) ON DELETE CASCADE,
    CONSTRAINT fk_sync_snapshot_chunks_object
        FOREIGN KEY (account_id, object_key)
        REFERENCES sync_objects(account_id, object_key),
    CONSTRAINT ck_sync_snapshot_chunk_index CHECK (chunk_index >= 0),
    CONSTRAINT ck_sync_snapshot_chunk_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_sync_snapshot_chunk_size CHECK (size_bytes > 0),
    CONSTRAINT ck_sync_snapshot_chunk_epoch CHECK (key_epoch >= 1)
);

CREATE INDEX idx_sync_snapshot_chunks_snapshot
    ON sync_snapshot_chunks(account_id, snapshot_id, chunk_index);
