package com.deardiary.sync.device;

import com.deardiary.sync.common.ApiException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class DeviceManagementService {
    private final JdbcTemplate jdbc;
    private final DeviceAuthorizationService authorization;

    public DeviceManagementService(JdbcTemplate jdbc, DeviceAuthorizationService authorization) {
        this.jdbc = jdbc;
        this.authorization = authorization;
    }

    public List<DeviceResponse> list(String ownerSubject, UUID requestingDeviceId) {
        var requester = authorization.requireActiveDevice(ownerSubject, requestingDeviceId);
        requirePrimary(requester.accountId(), requestingDeviceId);
        return jdbc.query("""
            SELECT d.device_id, d.device_role, d.device_status,
                   COALESCE(p.platform, CASE WHEN d.device_role = 'PRIMARY' THEN 'mobile' ELSE 'web' END),
                   p.requested_device_encryption_public_key,
                   d.registered_at, d.last_seen_at, d.last_app_version
            FROM sync_devices d
            LEFT JOIN LATERAL (
                SELECT platform, requested_device_encryption_public_key
                FROM sync_pairing_requests
                WHERE account_id = d.account_id AND requested_device_id = d.device_id
                  AND pairing_status = 'COMPLETED'
                ORDER BY completed_at DESC NULLS LAST, requested_at DESC
                LIMIT 1
            ) p ON TRUE
            WHERE d.account_id = ?
            ORDER BY d.registered_at ASC, d.device_id ASC
            """, (rs, row) -> new DeviceResponse(
                rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5),
                rs.getObject(6, OffsetDateTime.class).toInstant(),
                rs.getObject(7, OffsetDateTime.class).toInstant(), rs.getString(8)), requester.accountId());
    }

    private void requirePrimary(UUID accountId, UUID deviceId) {
        var role = jdbc.queryForObject(
            "SELECT device_role FROM sync_devices WHERE account_id = ? AND device_id = ?",
            String.class, accountId, deviceId);
        if (!"PRIMARY".equals(role)) throw new ApiException(
            "DEVICE_MANAGEMENT_FORBIDDEN", HttpStatus.FORBIDDEN,
            "Only the active primary device can manage companion devices.", false, true, Map.of());
    }
}
