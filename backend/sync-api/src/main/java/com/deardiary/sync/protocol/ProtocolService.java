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
                   maximum_event_bytes, maximum_media_bytes, sync_writes_enabled,
                   remote_pull_enabled, realtime_enabled, snapshot_creation_enabled,
                   garbage_collection_enabled, key_rotation_enabled
            FROM sync_protocol_config WHERE config_id = 1
            """, (rs, row) -> new ProtocolResponse(
                rs.getInt(1), rs.getInt(2), rs.getInt(3), rs.getInt(4), rs.getInt(5),
                rs.getLong(6), rs.getLong(7),
                new ProtocolResponse.FeatureFlags(
                    rs.getBoolean(8) && !switches.getOrDefault("SYNC_WRITES", true),
                    rs.getBoolean(9) && !switches.getOrDefault("REMOTE_PULL", true),
                    rs.getBoolean(10) && !switches.getOrDefault("REALTIME", true),
                    rs.getBoolean(11) && !switches.getOrDefault("SNAPSHOT_CREATION", true),
                    rs.getBoolean(12) && !switches.getOrDefault("GARBAGE_COLLECTION", true),
                    rs.getBoolean(13) && !switches.getOrDefault("KEY_ROTATION", true)
                )));
    }
}
