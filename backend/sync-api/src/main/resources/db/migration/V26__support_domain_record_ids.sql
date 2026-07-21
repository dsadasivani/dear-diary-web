ALTER TABLE sync_operations
    ALTER COLUMN record_id TYPE VARCHAR(128) USING record_id::text;

ALTER TABLE sync_record_versions
    ALTER COLUMN record_id TYPE VARCHAR(128) USING record_id::text;

ALTER TABLE sync_events
    ALTER COLUMN record_id TYPE VARCHAR(128) USING record_id::text;

ALTER TABLE sync_object_references
    ALTER COLUMN owner_record_id TYPE VARCHAR(128) USING owner_record_id::text;

ALTER TABLE sync_operations
    ADD CONSTRAINT ck_sync_operations_record_id
        CHECK (record_id ~ '^[A-Za-z0-9:_-]{1,128}$');

ALTER TABLE sync_record_versions
    ADD CONSTRAINT ck_sync_record_versions_record_id
        CHECK (record_id ~ '^[A-Za-z0-9:_-]{1,128}$');

ALTER TABLE sync_events
    ADD CONSTRAINT ck_sync_events_record_id
        CHECK (record_id ~ '^[A-Za-z0-9:_-]{1,128}$');

ALTER TABLE sync_object_references
    ADD CONSTRAINT ck_sync_object_references_owner_record_id
        CHECK (owner_record_id ~ '^[A-Za-z0-9:_-]{1,128}$');
