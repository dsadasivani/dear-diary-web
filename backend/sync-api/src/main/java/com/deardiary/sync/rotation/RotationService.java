package com.deardiary.sync.rotation;

import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.protocol.ProtocolService;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class RotationService {
    private static final Map<String, Set<String>> TRANSITIONS = Map.of(
        "PREPARING", Set.of("NEW_KEY_CREATED", "CANCELLED"),
        "NEW_KEY_CREATED", Set.of("KEY_PACKAGES_CREATED", "CANCELLED"),
        "KEY_PACKAGES_CREATED", Set.of("SERVER_EPOCH_PENDING"),
        "SERVER_EPOCH_COMMITTED", Set.of("LOCAL_STATE_COMMITTED"),
        "LOCAL_STATE_COMMITTED", Set.of("COMPLETED")
    );

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final DeviceAuthorizationService devices;
    private final ProtocolService protocols;
    private final Clock clock;

    public RotationService(JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            DeviceAuthorizationService devices, ProtocolService protocols, Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.devices = devices;
        this.protocols = protocols;
        this.clock = clock;
    }

    public RotationResponse begin(String ownerSubject, RotationRequests.Begin request) {
        requireEnabled();
        var device = devices.requireActiveDevice(ownerSubject, request.deviceId());
        requirePrimary(device.accountId(), request.deviceId());
        return transactions.execute(status -> {
            var epoch = lockAccount(device.accountId());
            var existing = loadOptional(device.accountId(), request.rotationId(), true);
            if (existing != null) {
                if (!existing.deviceId().equals(request.deviceId()) || existing.fromEpoch() != epoch
                        || !java.util.Objects.equals(existing.revokedDeviceId(), request.revokedDeviceId())) {
                    throw invalid("IDEMPOTENCY_MISMATCH");
                }
                return response(existing);
            }
            if (request.revokedDeviceId() != null) requireRevocableCompanion(device.accountId(), request.revokedDeviceId());
            var now = OffsetDateTime.now(clock);
            jdbc.update("""
                INSERT INTO sync_key_rotations (
                    account_id, rotation_id, initiated_by_device_id, from_key_epoch,
                    to_key_epoch, revoked_device_id, rotation_status, initiated_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'PREPARING', ?, ?)
                """, device.accountId(), request.rotationId(), request.deviceId(), epoch, epoch + 1,
                request.revokedDeviceId(), now, now);
            return response(load(device.accountId(), request.rotationId(), false));
        });
    }

    public RotationResponse advance(String ownerSubject, UUID rotationId, RotationRequests.Advance request) {
        requireEnabled();
        var device = devices.requireActiveDevice(ownerSubject, request.deviceId());
        return transactions.execute(status -> {
            lockAccount(device.accountId());
            var row = load(device.accountId(), rotationId, true);
            requireInitiator(row, request.deviceId());
            if (row.status().equals(request.nextStatus())) return response(row);
            if (!TRANSITIONS.getOrDefault(row.status(), Set.of()).contains(request.nextStatus())) {
                throw invalid("INVALID_ROTATION_TRANSITION");
            }
            if ("KEY_PACKAGES_CREATED".equals(request.nextStatus())) requireCompletePackages(device.accountId(), row);
            if ("CANCELLED".equals(request.nextStatus())) {
                var available = packageCount(device.accountId(), rotationId, row.toEpoch());
                if (available > 0) throw invalid("ROTATION_CANCEL_UNSAFE");
            }
            update(device.accountId(), rotationId, request.nextStatus(), "COMPLETED".equals(request.nextStatus()));
            return response(load(device.accountId(), rotationId, false));
        });
    }

    public RotationResponse commitServerEpoch(String ownerSubject, UUID rotationId, UUID deviceId) {
        requireEnabled();
        var device = devices.requireActiveDevice(ownerSubject, deviceId);
        return transactions.execute(status -> {
            var currentEpoch = lockAccount(device.accountId());
            var row = load(device.accountId(), rotationId, true);
            requireInitiator(row, deviceId);
            if ("SERVER_EPOCH_COMMITTED".equals(row.status()) || later(row.status())) return response(row);
            if (!"SERVER_EPOCH_PENDING".equals(row.status()) || currentEpoch != row.fromEpoch()) {
                throw invalid("KEY_EPOCH_MISMATCH");
            }
            requireCompletePackages(device.accountId(), row);
            var now = OffsetDateTime.now(clock);
            jdbc.update("UPDATE sync_accounts SET current_key_epoch = ?, updated_at = ? WHERE account_id = ?",
                row.toEpoch(), now, device.accountId());
            if (row.revokedDeviceId() != null) {
                jdbc.update("""
                    UPDATE sync_devices SET device_status = 'REVOKED', revoked_at = ?, last_seen_at = ?
                    WHERE account_id = ? AND device_id = ? AND device_status = 'ACTIVE'
                    """, now, now, device.accountId(), row.revokedDeviceId());
            }
            update(device.accountId(), rotationId, "SERVER_EPOCH_COMMITTED", false);
            return response(load(device.accountId(), rotationId, false));
        });
    }

    public RotationResponse localCommitted(
            String ownerSubject, UUID rotationId, RotationRequests.LocalCommitted request) {
        requireEnabled();
        var device = devices.requireActiveDevice(ownerSubject, request.deviceId());
        return transactions.execute(status -> {
            lockAccount(device.accountId());
            var row = load(device.accountId(), rotationId, true);
            requireInitiator(row, request.deviceId());
            if ("LOCAL_STATE_COMMITTED".equals(row.status()) || "COMPLETED".equals(row.status())) {
                return response(row);
            }
            if (!"SERVER_EPOCH_COMMITTED".equals(row.status())) {
                throw invalid("INVALID_ROTATION_TRANSITION");
            }
            var key = jdbc.queryForObject("SELECT device_public_key FROM sync_devices WHERE account_id = ? AND device_id = ?",
                byte[].class, device.accountId(), request.deviceId());
            verify(key, "rotation-local-committed:" + rotationId + ":" + row.toEpoch(), request.possessionSignature());
            update(device.accountId(), rotationId, "LOCAL_STATE_COMMITTED", false);
            return response(load(device.accountId(), rotationId, false));
        });
    }

    public RotationResponse get(String ownerSubject, UUID rotationId) {
        var accounts = jdbc.query("SELECT account_id FROM sync_accounts WHERE owner_subject = ?",
            (rs, row) -> rs.getObject(1, UUID.class), ownerSubject);
        if (accounts.isEmpty()) throw invalid("ACCOUNT_NOT_FOUND");
        return response(load(accounts.getFirst(), rotationId, false));
    }

    private void requireCompletePackages(UUID accountId, RotationRow row) {
        var missingDevicePackages = jdbc.queryForObject("""
            SELECT count(*) FROM sync_devices d
            WHERE d.account_id = ? AND d.device_status = 'ACTIVE'
              AND (?::uuid IS NULL OR d.device_id <> ?::uuid)
              AND NOT EXISTS (
                SELECT 1 FROM sync_key_packages k
                WHERE k.account_id = d.account_id AND k.target_device_id = d.device_id
                  AND k.rotation_id = ? AND k.key_epoch = ?
                  AND k.package_purpose = 'DEVICE' AND k.package_status = 'AVAILABLE'
              )
              AND d.device_id <> ?
            """, Long.class, accountId, row.revokedDeviceId(), row.revokedDeviceId(),
            row.rotationId(), row.toEpoch(), row.deviceId());
        var recoveryPackages = jdbc.queryForObject("""
            SELECT count(*) FROM sync_key_packages
            WHERE account_id = ? AND rotation_id = ? AND key_epoch = ?
              AND package_purpose = 'RECOVERY' AND package_status = 'AVAILABLE'
            """, Long.class, accountId, row.rotationId(), row.toEpoch());
        if (missingDevicePackages != 0 || recoveryPackages == 0) throw new ApiException(
            "KEY_PACKAGES_INCOMPLETE", HttpStatus.CONFLICT,
            "Every active device and recovery path must have a new key package.", true, false, Map.of());
    }
    private long packageCount(UUID accountId, UUID rotationId, int epoch) { return jdbc.queryForObject("""
        SELECT count(*) FROM sync_key_packages WHERE account_id = ? AND rotation_id = ? AND key_epoch = ? AND package_status = 'AVAILABLE'
        """, Long.class, accountId, rotationId, epoch); }
    private int lockAccount(UUID id) { return jdbc.queryForObject(
        "SELECT current_key_epoch FROM sync_accounts WHERE account_id = ? FOR UPDATE", Integer.class, id); }
    private void requireEnabled() { if (!protocols.current().featureFlags().keyRotationEnabled()) throw new ApiException(
        "KEY_ROTATION_DISABLED", HttpStatus.SERVICE_UNAVAILABLE, "Key rotation is temporarily disabled.", true, false, Map.of()); }
    private void requirePrimary(UUID account, UUID device) { var role = jdbc.queryForObject(
        "SELECT device_role FROM sync_devices WHERE account_id = ? AND device_id = ?", String.class, account, device);
        if (!"PRIMARY".equals(role)) throw invalid("KEY_ROTATION_FORBIDDEN"); }
    private void requireRevocableCompanion(UUID account, UUID device) {
        if (!protocols.current().featureFlags().deviceRevocationEnabled()) throw new ApiException(
            "DEVICE_REVOCATION_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
            "Device revocation is temporarily disabled.", true, false, Map.of());
        var rows = jdbc.query("SELECT device_role, device_status FROM sync_devices WHERE account_id = ? AND device_id = ?",
            (rs, n) -> new String[] { rs.getString(1), rs.getString(2) }, account, device);
        if (rows.isEmpty() || !"COMPANION".equals(rows.getFirst()[0]) || !"ACTIVE".equals(rows.getFirst()[1])) {
            throw invalid("DEVICE_NOT_REVOCABLE");
        }
    }
    private void requireInitiator(RotationRow row, UUID device) { if (!row.deviceId().equals(device)) throw invalid("KEY_ROTATION_FORBIDDEN"); }
    private void update(UUID account, UUID rotation, String state, boolean finalized) { var now = OffsetDateTime.now(clock); jdbc.update("""
        UPDATE sync_key_rotations SET rotation_status = ?, finalized_at = CASE WHEN ? THEN ? ELSE finalized_at END, updated_at = ?
        WHERE account_id = ? AND rotation_id = ?
        """, state, finalized, now, now, account, rotation); }
    private RotationRow load(UUID account, UUID id, boolean lock) { var row = loadOptional(account, id, lock);
        if (row == null) throw invalid("KEY_ROTATION_NOT_FOUND"); return row; }
    private RotationRow loadOptional(UUID account, UUID id, boolean lock) { var rows = jdbc.query("""
        SELECT rotation_id, initiated_by_device_id, revoked_device_id, from_key_epoch, to_key_epoch, rotation_status
        FROM sync_key_rotations WHERE account_id = ? AND rotation_id = ?
        """ + (lock ? " FOR UPDATE" : ""), (rs, n) -> new RotationRow(rs.getObject(1, UUID.class),
            rs.getObject(2, UUID.class), rs.getObject(3, UUID.class), rs.getInt(4), rs.getInt(5), rs.getString(6)), account, id);
        return rows.isEmpty() ? null : rows.getFirst(); }
    private boolean later(String status) { return Set.of("LOCAL_STATE_COMMITTED", "COMPLETED").contains(status); }
    private void verify(byte[] publicKey, String message, String signature) { try { var verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(publicKey)));
        verifier.update(message.getBytes(StandardCharsets.UTF_8));
        if (!verifier.verify(Base64.getDecoder().decode(signature))) throw invalid("INVALID_ROTATION_PROOF");
        } catch (ApiException e) { throw e; } catch (Exception e) { throw invalid("INVALID_ROTATION_PROOF"); } }
    private RotationResponse response(RotationRow row) { return new RotationResponse(row.rotationId(), row.deviceId(), row.revokedDeviceId(), row.fromEpoch(), row.toEpoch(), row.status()); }
    private ApiException invalid(String code) { return new ApiException(code, HttpStatus.CONFLICT,
        "The key rotation state is invalid.", false, true, Map.of()); }
    private record RotationRow(UUID rotationId, UUID deviceId, UUID revokedDeviceId, int fromEpoch, int toEpoch, String status) {}
}
