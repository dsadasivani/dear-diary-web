-- V1 and V2 have independent sequence spaces. A verified V1 baseline may be
-- migrated into a newly registered V2 account whose first snapshot is at 0.
ALTER TABLE sync_migrations DROP CONSTRAINT ck_sync_migrations_sequences;
ALTER TABLE sync_migrations ADD CONSTRAINT ck_sync_migrations_sequences CHECK (
    baseline_sequence >= 0 AND
    (activated_sequence IS NULL OR activated_sequence >= 0)
);
