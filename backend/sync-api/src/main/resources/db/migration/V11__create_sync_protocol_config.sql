CREATE TABLE sync_protocol_config (
    config_id SMALLINT PRIMARY KEY,
    minimum_read_protocol_version INTEGER NOT NULL,
    minimum_write_protocol_version INTEGER NOT NULL,
    current_protocol_version INTEGER NOT NULL,
    event_schema_version INTEGER NOT NULL,
    snapshot_schema_version INTEGER NOT NULL,
    maximum_event_bytes BIGINT NOT NULL,
    maximum_media_bytes BIGINT NOT NULL,
    sync_writes_enabled BOOLEAN NOT NULL,
    remote_pull_enabled BOOLEAN NOT NULL,
    realtime_enabled BOOLEAN NOT NULL,
    snapshot_creation_enabled BOOLEAN NOT NULL,
    garbage_collection_enabled BOOLEAN NOT NULL,
    key_rotation_enabled BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT ck_sync_protocol_singleton CHECK (config_id = 1),
    CONSTRAINT ck_sync_protocol_versions CHECK (
        minimum_read_protocol_version > 0 AND
        minimum_write_protocol_version > 0 AND
        current_protocol_version >= minimum_read_protocol_version AND
        current_protocol_version >= minimum_write_protocol_version
    ),
    CONSTRAINT ck_sync_protocol_schemas CHECK (event_schema_version > 0 AND snapshot_schema_version > 0),
    CONSTRAINT ck_sync_protocol_sizes CHECK (maximum_event_bytes > 0 AND maximum_media_bytes >= maximum_event_bytes)
);

INSERT INTO sync_protocol_config (
    config_id, minimum_read_protocol_version, minimum_write_protocol_version,
    current_protocol_version, event_schema_version, snapshot_schema_version,
    maximum_event_bytes, maximum_media_bytes, sync_writes_enabled,
    remote_pull_enabled, realtime_enabled, snapshot_creation_enabled,
    garbage_collection_enabled, key_rotation_enabled, updated_at
) VALUES (
    1, 2, 2, 2, 2, 2,
    10485760, 104857600, TRUE,
    TRUE, TRUE, FALSE,
    FALSE, FALSE, CURRENT_TIMESTAMP
);
