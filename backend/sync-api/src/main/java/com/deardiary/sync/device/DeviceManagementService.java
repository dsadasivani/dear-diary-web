package com.deardiary.sync.device;

import com.deardiary.sync.common.ApiException;
import java.time.OffsetDateTime;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
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

    public SelfRevocationResponse revokeSelf(
            String ownerSubject, UUID deviceId, SelfRevocationRequest request) {
        var rows = jdbc.query("""
            SELECT d.account_id, d.device_role, d.device_status, d.device_public_key
            FROM sync_devices d
            JOIN sync_accounts a ON a.account_id = d.account_id
            WHERE d.device_id = ? AND a.owner_subject = ?
            """, (rs, row) -> new Object[] {
                rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getBytes(4)
            }, deviceId, ownerSubject);
        if (rows.isEmpty()) throw new ApiException(
            "DEVICE_NOT_FOUND", HttpStatus.NOT_FOUND, "The device is not registered for this user.");
        var row = rows.getFirst();
        if (!"COMPANION".equals(row[1])) throw new ApiException(
            "SELF_REVOCATION_FORBIDDEN", HttpStatus.FORBIDDEN,
            "Only a companion can unlink itself.", false, true, Map.of());
        if (!"ACTIVE".equals(row[2]) && !"REVOKED".equals(row[2])) throw new ApiException(
            "SELF_REVOCATION_FORBIDDEN", HttpStatus.FORBIDDEN,
            "Only an active companion can unlink itself.", false, true, Map.of());
        verify((byte[]) row[3], "device-revoke-self:" + deviceId, request.possessionSignature());
        if (!"REVOKED".equals(row[2])) {
            jdbc.update("""
                UPDATE sync_devices SET device_status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP,
                    last_seen_at = CURRENT_TIMESTAMP
                WHERE account_id = ? AND device_id = ? AND device_status = 'ACTIVE'
                """, row[0], deviceId);
        }
        return new SelfRevocationResponse(deviceId, "REVOKED");
    }

    private void verify(byte[] publicKey, String message, String signature) {
        try {
            var verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(publicKey)));
            verifier.update(message.getBytes(StandardCharsets.UTF_8));
            if (!verifier.verify(Base64.getDecoder().decode(signature))) {
                throw invalidSignature();
            }
        } catch (ApiException error) {
            throw error;
        } catch (Exception error) {
            throw invalidSignature();
        }
    }

    private ApiException invalidSignature() {
        return new ApiException("INVALID_DEVICE_SIGNATURE", HttpStatus.FORBIDDEN,
            "The device signature is invalid.", false, true, Map.of());
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
