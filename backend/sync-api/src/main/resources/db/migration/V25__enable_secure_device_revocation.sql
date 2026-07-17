UPDATE sync_protocol_config
SET key_rotation_enabled = TRUE,
    device_revocation_enabled = TRUE
WHERE config_id = 1;

UPDATE sync_kill_switches
SET engaged = FALSE, reason_code = NULL, updated_at = CURRENT_TIMESTAMP, updated_by = 'migration'
WHERE switch_name IN ('KEY_ROTATION', 'DEVICE_REVOCATION');
