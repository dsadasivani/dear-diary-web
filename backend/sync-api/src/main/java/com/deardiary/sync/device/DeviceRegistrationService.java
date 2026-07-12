package com.deardiary.sync.device;

import com.deardiary.sync.common.ApiException;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.spec.X509EncodedKeySpec;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class DeviceRegistrationService {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final Clock clock;

    public DeviceRegistrationService(JdbcTemplate jdbc, PlatformTransactionManager transactionManager, Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.clock = clock;
    }

    public DeviceRegistrationResponse register(String ownerSubject, DeviceRegistrationRequest request) {
        var publicKey = decodeAndValidatePublicKey(request.devicePublicKey());
        return transactions.execute(status -> registerInTransaction(ownerSubject, request, publicKey));
    }

    private DeviceRegistrationResponse registerInTransaction(
            String ownerSubject,
            DeviceRegistrationRequest request,
            byte[] publicKey) {
        var accountId = findAccountId(ownerSubject);
        var createdAccount = accountId == null;
        if (createdAccount) {
            accountId = UUID.randomUUID();
            var now = OffsetDateTime.now(clock);
            jdbc.update("""
                INSERT INTO sync_accounts (
                    account_id, owner_subject, minimum_read_protocol, minimum_write_protocol,
                    account_status, created_at, updated_at
                ) VALUES (?, ?, 2, 2, 'ACTIVE', ?, ?)
                """, accountId, ownerSubject, now, now);
        }

        var existing = jdbc.query("""
            SELECT account_id, device_public_key, device_role, device_status, created_protocol_version
            FROM sync_devices WHERE device_id = ?
            """, (rs, row) -> new ExistingDevice(
                rs.getObject("account_id", UUID.class), rs.getBytes("device_public_key"),
                rs.getString("device_role"), rs.getString("device_status"),
                rs.getInt("created_protocol_version")
            ), request.deviceId());
        if (!existing.isEmpty()) {
            var device = existing.getFirst();
            if (!device.accountId().equals(accountId)) {
                throw new ApiException("DEVICE_NOT_FOUND", HttpStatus.NOT_FOUND, "The device is not registered for this user.");
            }
            if (!"ACTIVE".equals(device.status())) {
                throw new ApiException("DEVICE_REVOKED", HttpStatus.FORBIDDEN, "The device is no longer authorized.", false, true, Map.of());
            }
            if (!MessageDigest.isEqual(device.publicKey(), publicKey)
                    || !device.role().equals(request.deviceRole())
                    || device.protocolVersion() != request.protocolVersion()) {
                throw new ApiException("IDEMPOTENCY_MISMATCH", HttpStatus.CONFLICT, "The device identifier is already registered with different metadata.");
            }
            jdbc.update("UPDATE sync_devices SET last_seen_at = ?, last_app_version = ? WHERE device_id = ?",
                OffsetDateTime.now(clock), request.appVersion(), request.deviceId());
            return new DeviceRegistrationResponse(accountId, request.deviceId(), device.role(), device.status(), false);
        }

        var deviceCount = jdbc.queryForObject(
            "SELECT count(*) FROM sync_devices WHERE account_id = ?", Long.class, accountId);
        if (deviceCount != null && deviceCount > 0) {
            throw new ApiException(
                "DEVICE_REGISTRATION_REQUIRES_PAIRING", HttpStatus.CONFLICT,
                "Additional devices must use the pairing workflow.", false, true, Map.of());
        }
        if (!createdAccount || !"PRIMARY".equals(request.deviceRole())) {
            throw new ApiException("PRIMARY_DEVICE_REQUIRED", HttpStatus.CONFLICT, "The first registered device must be primary.");
        }
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            INSERT INTO sync_devices (
                device_id, account_id, device_public_key, device_role, device_status,
                registered_at, last_seen_at, created_protocol_version, last_app_version
            ) VALUES (?, ?, ?, 'PRIMARY', 'ACTIVE', ?, ?, ?, ?)
            """, request.deviceId(), accountId, publicKey, now, now, request.protocolVersion(), request.appVersion());
        jdbc.update("""
            INSERT INTO sync_device_cursors (account_id, device_id, last_applied_sequence, last_acknowledged_at)
            VALUES (?, ?, 0, ?)
            """, accountId, request.deviceId(), now);
        return new DeviceRegistrationResponse(accountId, request.deviceId(), "PRIMARY", "ACTIVE", true);
    }

    private UUID findAccountId(String ownerSubject) {
        var ids = jdbc.query("SELECT account_id FROM sync_accounts WHERE owner_subject = ? FOR UPDATE",
            (rs, row) -> rs.getObject(1, UUID.class), ownerSubject);
        return ids.isEmpty() ? null : ids.getFirst();
    }

    private byte[] decodeAndValidatePublicKey(String encoded) {
        final byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException error) {
            throw invalidPublicKey();
        }
        if (bytes.length < 32 || bytes.length > 16_384) throw invalidPublicKey();
        var specification = new X509EncodedKeySpec(bytes);
        for (var algorithm : new String[] {"EC", "RSA"}) {
            try {
                KeyFactory.getInstance(algorithm).generatePublic(specification);
                return bytes;
            } catch (Exception ignored) {
                // Try the next approved asymmetric key format.
            }
        }
        throw invalidPublicKey();
    }

    private ApiException invalidPublicKey() {
        return new ApiException("INVALID_DEVICE_PUBLIC_KEY", HttpStatus.BAD_REQUEST, "The device public key is invalid.");
    }

    private record ExistingDevice(UUID accountId, byte[] publicKey, String role, String status, int protocolVersion) {}
}
