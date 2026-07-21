ALTER TABLE sync_pairing_requests
    ADD COLUMN requested_device_encryption_public_key TEXT;

UPDATE sync_pairing_requests
SET pairing_status = 'EXPIRED'
WHERE pairing_status = 'REQUESTED';

UPDATE sync_protocol_config
SET companion_pairing_enabled = TRUE
WHERE config_id = 1;

UPDATE sync_kill_switches
SET engaged = FALSE, reason_code = NULL, updated_at = CURRENT_TIMESTAMP, updated_by = 'migration'
WHERE switch_name = 'COMPANION_PAIRING';
