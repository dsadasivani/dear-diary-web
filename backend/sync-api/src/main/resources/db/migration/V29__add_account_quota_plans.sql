CREATE TABLE sync_plans (
    plan_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    maximum_companions INTEGER NOT NULL,
    maximum_photos_per_entry INTEGER NOT NULL,
    maximum_recordings_per_entry INTEGER NOT NULL,
    maximum_storage_bytes BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_sync_plans_id CHECK (plan_id ~ '^[a-z0-9_-]{1,64}$'),
    CONSTRAINT ck_sync_plans_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 128),
    CONSTRAINT ck_sync_plans_limits CHECK (
        maximum_companions >= 0 AND
        maximum_photos_per_entry >= 0 AND
        maximum_recordings_per_entry >= 0 AND
        maximum_storage_bytes > 0
    )
);

INSERT INTO sync_plans (
    plan_id, display_name, maximum_companions, maximum_photos_per_entry,
    maximum_recordings_per_entry, maximum_storage_bytes, created_at, updated_at
) VALUES (
    'default', 'Default', 3, 3, 3, 524288000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);

ALTER TABLE sync_accounts
    ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'default',
    ADD CONSTRAINT fk_sync_accounts_plan FOREIGN KEY (plan_id) REFERENCES sync_plans(plan_id);

ALTER TABLE sync_operations
    ADD COLUMN entry_photo_count INTEGER,
    ADD COLUMN entry_recording_count INTEGER,
    ADD CONSTRAINT ck_sync_operations_entry_media_counts CHECK (
        (entry_photo_count IS NULL AND entry_recording_count IS NULL) OR
        (entry_photo_count >= 0 AND entry_recording_count >= 0)
    );

ALTER TABLE sync_record_versions
    ADD COLUMN entry_photo_count INTEGER,
    ADD COLUMN entry_recording_count INTEGER,
    ADD CONSTRAINT ck_sync_record_versions_entry_media_counts CHECK (
        (entry_photo_count IS NULL AND entry_recording_count IS NULL) OR
        (entry_photo_count >= 0 AND entry_recording_count >= 0)
    );

UPDATE sync_protocol_config
SET minimum_write_protocol_version = 3,
    current_protocol_version = 3,
    updated_at = CURRENT_TIMESTAMP
WHERE config_id = 1;
