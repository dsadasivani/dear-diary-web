ALTER TABLE sync_protocol_config
    ADD COLUMN media_upload_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN archive_hydration_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN device_revocation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN primary_recovery_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN companion_pairing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN minimum_supported_app_version TEXT NOT NULL DEFAULT '0.0.0',
    ADD COLUMN sync_v2_rollout_percentage INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN rollout_salt_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN emergency_mode BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT ck_sync_rollout_percentage CHECK (sync_v2_rollout_percentage BETWEEN 0 AND 100),
    ADD CONSTRAINT ck_sync_rollout_salt CHECK (rollout_salt_version > 0),
    ADD CONSTRAINT ck_sync_minimum_app_version CHECK (minimum_supported_app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$');

ALTER TABLE sync_kill_switches DROP CONSTRAINT ck_sync_kill_switch_name;
ALTER TABLE sync_kill_switches ADD CONSTRAINT ck_sync_kill_switch_name CHECK (switch_name IN (
    'SYNC_WRITES', 'REMOTE_PULL', 'REALTIME', 'SNAPSHOT_CREATION', 'GARBAGE_COLLECTION',
    'MEDIA_UPLOAD', 'ARCHIVE_HYDRATION', 'KEY_ROTATION', 'DEVICE_REVOCATION',
    'PRIMARY_RECOVERY', 'COMPANION_PAIRING'
));

INSERT INTO sync_kill_switches (switch_name, engaged, reason_code, updated_at, updated_by) VALUES
    ('MEDIA_UPLOAD', FALSE, NULL, CURRENT_TIMESTAMP, 'migration'),
    ('ARCHIVE_HYDRATION', FALSE, NULL, CURRENT_TIMESTAMP, 'migration'),
    ('DEVICE_REVOCATION', TRUE, 'NOT_YET_ENABLED', CURRENT_TIMESTAMP, 'migration'),
    ('PRIMARY_RECOVERY', TRUE, 'NOT_YET_ENABLED', CURRENT_TIMESTAMP, 'migration'),
    ('COMPANION_PAIRING', TRUE, 'NOT_YET_ENABLED', CURRENT_TIMESTAMP, 'migration');
