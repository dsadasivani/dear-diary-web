CREATE TABLE sync_kill_switches (
    switch_name TEXT PRIMARY KEY,
    engaged BOOLEAN NOT NULL,
    reason_code TEXT,
    updated_at TIMESTAMPTZ NOT NULL,
    updated_by TEXT NOT NULL,
    CONSTRAINT ck_sync_kill_switch_name CHECK (switch_name IN (
        'SYNC_WRITES', 'REMOTE_PULL', 'REALTIME', 'SNAPSHOT_CREATION', 'GARBAGE_COLLECTION', 'KEY_ROTATION'
    )),
    CONSTRAINT ck_sync_kill_switch_reason CHECK (NOT engaged OR length(btrim(reason_code)) > 0),
    CONSTRAINT ck_sync_kill_switch_actor CHECK (length(btrim(updated_by)) > 0)
);

INSERT INTO sync_kill_switches (switch_name, engaged, reason_code, updated_at, updated_by) VALUES
    ('SYNC_WRITES', FALSE, NULL, CURRENT_TIMESTAMP, 'migration'),
    ('REMOTE_PULL', FALSE, NULL, CURRENT_TIMESTAMP, 'migration'),
    ('REALTIME', FALSE, NULL, CURRENT_TIMESTAMP, 'migration'),
    ('SNAPSHOT_CREATION', TRUE, 'NOT_YET_ENABLED', CURRENT_TIMESTAMP, 'migration'),
    ('GARBAGE_COLLECTION', TRUE, 'NOT_YET_ENABLED', CURRENT_TIMESTAMP, 'migration'),
    ('KEY_ROTATION', TRUE, 'NOT_YET_ENABLED', CURRENT_TIMESTAMP, 'migration');
