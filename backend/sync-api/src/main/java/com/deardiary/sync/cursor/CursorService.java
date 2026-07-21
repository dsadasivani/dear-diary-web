package com.deardiary.sync.cursor;

import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class CursorService {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final DeviceAuthorizationService devices;
    private final Clock clock;

    public CursorService(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            DeviceAuthorizationService devices,
            Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.devices = devices;
        this.clock = clock;
    }

    public CursorAcknowledgmentResponse acknowledge(String ownerSubject, UUID deviceId, long requestedSequence) {
        if (requestedSequence < 0) {
            throw new ApiException("INVALID_CURSOR", HttpStatus.BAD_REQUEST, "The device cursor is invalid.");
        }
        var device = devices.requireCursorDevice(ownerSubject, deviceId);
        return transactions.execute(status -> acknowledgeInTransaction(device.accountId(), deviceId, requestedSequence));
    }

    private CursorAcknowledgmentResponse acknowledgeInTransaction(
            UUID accountId,
            UUID deviceId,
            long requestedSequence) {
        var accountSequence = jdbc.queryForObject(
            "SELECT current_sequence FROM sync_accounts WHERE account_id = ? FOR UPDATE",
            Long.class, accountId);
        var deviceAuthorization = jdbc.queryForObject("""
            SELECT d.device_status,
                   EXISTS (
                       SELECT 1 FROM sync_recovery_state r
                       WHERE r.account_id = d.account_id
                         AND r.recovery_device_id = d.device_id
                         AND r.recovery_status IN (
                             'REQUESTED', 'APPROVED', 'KEY_PACKAGE_PENDING',
                             'KEY_PACKAGE_AVAILABLE', 'LOCAL_KEY_PERSISTED', 'FINALIZING'
                         )
                   ) AS active_recovery
            FROM sync_devices d
            WHERE d.account_id = ? AND d.device_id = ? FOR UPDATE
            """, (rs, row) -> new Object[] { rs.getString("device_status"), rs.getBoolean("active_recovery") },
            accountId, deviceId);
        var cursorAuthorized = "ACTIVE".equals(deviceAuthorization[0])
            || ("RECOVERY_PENDING".equals(deviceAuthorization[0]) && Boolean.TRUE.equals(deviceAuthorization[1]));
        if (!cursorAuthorized) {
            throw new ApiException("DEVICE_REVOKED", HttpStatus.FORBIDDEN,
                "The device is no longer authorized.", false, true, Map.of());
        }
        var cursor = jdbc.queryForObject("""
            SELECT last_applied_sequence FROM sync_device_cursors
            WHERE account_id = ? AND device_id = ? FOR UPDATE
            """, Long.class, accountId, deviceId);
        if (requestedSequence < cursor) {
            throw new ApiException("CURSOR_REGRESSION", HttpStatus.CONFLICT,
                "The device cursor cannot move backwards.", false, true,
                Map.of("currentSequence", cursor, "requestedSequence", requestedSequence));
        }
        if (requestedSequence > accountSequence) {
            throw new ApiException("CURSOR_AHEAD", HttpStatus.CONFLICT,
                "The device cursor cannot exceed the account sequence.", false, true,
                Map.of("accountSequence", accountSequence, "requestedSequence", requestedSequence));
        }
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            UPDATE sync_device_cursors SET last_applied_sequence = ?, last_acknowledged_at = ?
            WHERE account_id = ? AND device_id = ?
            """, requestedSequence, now, accountId, deviceId);
        jdbc.update("UPDATE sync_devices SET last_seen_at = ? WHERE account_id = ? AND device_id = ?",
            now, accountId, deviceId);
        return new CursorAcknowledgmentResponse(deviceId, requestedSequence);
    }
}
