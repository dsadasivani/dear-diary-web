package com.deardiary.sync.protocol;

import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class ProtocolService {
    private final JdbcTemplate jdbc;

    public ProtocolService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public ProtocolResponse current() {
        Map<String, Boolean> switches = jdbc.query(
            "SELECT switch_name, engaged FROM sync_kill_switches",
            (rs, row) -> Map.entry(rs.getString(1), rs.getBoolean(2)))
            .stream().collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue));
        return jdbc.queryForObject("""
            SELECT minimum_read_protocol_version, minimum_write_protocol_version,
                   current_protocol_version, event_schema_version, snapshot_schema_version,
                   maximum_event_bytes, maximum_media_bytes, maximum_snapshot_bytes, sync_writes_enabled,
                   remote_pull_enabled, realtime_enabled, snapshot_creation_enabled,
                   garbage_collection_enabled, key_rotation_enabled,
                   media_upload_enabled, archive_hydration_enabled, device_revocation_enabled,
                   primary_recovery_enabled, companion_pairing_enabled,
                   minimum_supported_app_version, sync_v2_rollout_percentage,
                   rollout_salt_version, emergency_mode
            FROM sync_protocol_config WHERE config_id = 1
            """, (rs, row) -> new ProtocolResponse(
                rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4), rs.getInt(5),
                rs.getLong(6), rs.getLong(7), rs.getLong(8), rs.getString(20), rs.getInt(21), rs.getInt(22), rs.getBoolean(23),
                new ProtocolResponse.FeatureFlags(
                    rs.getBoolean(9) && !rs.getBoolean(23) && !switches.getOrDefault("SYNC_WRITES", true),
                    rs.getBoolean(10) && !switches.getOrDefault("REMOTE_PULL", true),
                    rs.getBoolean(11) && !rs.getBoolean(23) && !switches.getOrDefault("REALTIME", true),
                    rs.getBoolean(12) && !rs.getBoolean(23) && !switches.getOrDefault("SNAPSHOT_CREATION", true),
                    rs.getBoolean(13) && !rs.getBoolean(23) && !switches.getOrDefault("GARBAGE_COLLECTION", true),
                    rs.getBoolean(15) && !rs.getBoolean(23) && !switches.getOrDefault("MEDIA_UPLOAD", true),
                    rs.getBoolean(16) && !rs.getBoolean(23) && !switches.getOrDefault("ARCHIVE_HYDRATION", true),
                    rs.getBoolean(14) && !rs.getBoolean(23) && !switches.getOrDefault("KEY_ROTATION", true),
                    rs.getBoolean(17) && !rs.getBoolean(23) && !switches.getOrDefault("DEVICE_REVOCATION", true),
                    rs.getBoolean(18) && !rs.getBoolean(23) && !switches.getOrDefault("PRIMARY_RECOVERY", true),
                    rs.getBoolean(19) && !rs.getBoolean(23) && !switches.getOrDefault("COMPANION_PAIRING", true)
                )));
    }
}
