CREATE TABLE sync_record_versions (
    account_id UUID NOT NULL REFERENCES sync_accounts(account_id),
    record_type TEXT NOT NULL,
    record_id UUID NOT NULL,
    current_version BIGINT NOT NULL,
    last_sequence BIGINT NOT NULL,
    deleted BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (account_id, record_type, record_id),
    CONSTRAINT ck_sync_record_versions_type CHECK (record_type IN ('DIARY', 'ENTRY', 'NOTE', 'SETTINGS', 'PROFILE')),
    CONSTRAINT ck_sync_record_versions_version CHECK (current_version >= 0),
    CONSTRAINT ck_sync_record_versions_sequence CHECK (last_sequence >= 0)
);
