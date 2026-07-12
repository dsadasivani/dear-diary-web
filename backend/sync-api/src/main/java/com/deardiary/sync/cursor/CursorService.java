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
        var device = devices.requireActiveDevice(ownerSubject, deviceId);
        return transactions.execute(status -> acknowledgeInTransaction(device.accountId(), deviceId, requestedSequence));
    }

    private CursorAcknowledgmentResponse acknowledgeInTransaction(
            UUID accountId,
            UUID deviceId,
            long requestedSequence) {
        var accountSequence = jdbc.queryForObject(
            "SELECT current_sequence FROM sync_accounts WHERE account_id = ? FOR UPDATE",
            Long.class, accountId);
        var deviceStatus = jdbc.queryForObject("""
            SELECT device_status FROM sync_devices
            WHERE account_id = ? AND device_id = ? FOR UPDATE
            """, String.class, accountId, deviceId);
        if (!"ACTIVE".equals(deviceStatus)) {
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
