package com.deardiary.sync.device;

import com.deardiary.sync.common.ApiException;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class DeviceAuthorizationService {
    private final JdbcTemplate jdbc;

    public DeviceAuthorizationService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public ActiveDevice requireActiveDevice(String ownerSubject, UUID deviceId) {
        return requireDevice(ownerSubject, deviceId, false);
    }

    public ActiveDevice requireCursorDevice(String ownerSubject, UUID deviceId) {
        return requireDevice(ownerSubject, deviceId, true);
    }

    private ActiveDevice requireDevice(String ownerSubject, UUID deviceId, boolean allowActiveRecovery) {
        var matches = jdbc.query("""
            SELECT a.account_id, d.device_id, a.owner_subject, a.current_key_epoch, a.current_sequence,
                   a.account_status, d.device_status,
                   EXISTS (
                       SELECT 1 FROM sync_recovery_state r
                       WHERE r.account_id = a.account_id
                         AND r.recovery_device_id = d.device_id
                         AND r.recovery_status IN (
                             'REQUESTED', 'APPROVED', 'KEY_PACKAGE_PENDING',
                             'KEY_PACKAGE_AVAILABLE', 'LOCAL_KEY_PERSISTED', 'FINALIZING'
                         )
                   ) AS active_recovery
            FROM sync_devices d
            JOIN sync_accounts a ON a.account_id = d.account_id
            WHERE d.device_id = ? AND a.owner_subject = ?
            """, (rs, row) -> new Object[] {
                rs.getObject("account_id", UUID.class), rs.getObject("device_id", UUID.class),
                rs.getString("owner_subject"), rs.getInt("current_key_epoch"), rs.getLong("current_sequence"),
                rs.getString("account_status"), rs.getString("device_status"), rs.getBoolean("active_recovery")
            }, deviceId, ownerSubject);
        if (matches.isEmpty()) {
            throw new ApiException("DEVICE_NOT_FOUND", HttpStatus.NOT_FOUND, "The device is not registered for this user.");
        }
        var row = matches.getFirst();
        if (!"ACTIVE".equals(row[5])) {
            throw new ApiException("ACCOUNT_NOT_ACTIVE", HttpStatus.CONFLICT, "The synchronization account is not active.", false, true, java.util.Map.of());
        }
        var recoveryMayAcknowledge = allowActiveRecovery
            && "RECOVERY_PENDING".equals(row[6]) && Boolean.TRUE.equals(row[7]);
        if (!"ACTIVE".equals(row[6]) && !recoveryMayAcknowledge) {
            throw new ApiException("DEVICE_REVOKED", HttpStatus.FORBIDDEN, "The device is no longer authorized.", false, true, java.util.Map.of());
        }
        return new ActiveDevice((UUID) row[0], (UUID) row[1], (String) row[2], (Integer) row[3], (Long) row[4]);
    }
}
