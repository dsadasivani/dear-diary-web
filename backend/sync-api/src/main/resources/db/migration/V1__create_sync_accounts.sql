CREATE TABLE sync_accounts (
    account_id UUID PRIMARY KEY,
    owner_subject TEXT NOT NULL UNIQUE,
    current_sequence BIGINT NOT NULL DEFAULT 0,
    current_key_epoch INTEGER NOT NULL DEFAULT 1,
    minimum_read_protocol INTEGER NOT NULL,
    minimum_write_protocol INTEGER NOT NULL,
    account_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_sync_accounts_owner_subject CHECK (length(btrim(owner_subject)) > 0),
    CONSTRAINT ck_sync_accounts_sequence CHECK (current_sequence >= 0),
    CONSTRAINT ck_sync_accounts_key_epoch CHECK (current_key_epoch > 0),
    CONSTRAINT ck_sync_accounts_protocols CHECK (minimum_read_protocol > 0 AND minimum_write_protocol > 0),
    CONSTRAINT ck_sync_accounts_status CHECK (account_status IN ('ACTIVE', 'RECOVERY_PENDING', 'SAFETY_STOP', 'DISABLED'))
);
