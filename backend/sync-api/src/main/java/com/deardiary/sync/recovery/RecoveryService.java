package com.deardiary.sync.recovery;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.keypackage.KeyPackageResponse;
import com.deardiary.sync.keypackage.KeyPackageService;
import com.deardiary.sync.protocol.ProtocolService;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.time.Clock;
import java.time.Duration;
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
public class RecoveryService {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final AccountAuthorizationService accounts;
    private final ProtocolService protocols;
    private final KeyPackageService keyPackages;
    private final Clock clock;

    public RecoveryService(JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            AccountAuthorizationService accounts, ProtocolService protocols,
            KeyPackageService keyPackages, Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.accounts = accounts;
        this.protocols = protocols;
        this.keyPackages = keyPackages;
        this.clock = clock;
    }

    public RecoveryResponse begin(String ownerSubject, RecoveryRequests.Begin request) {
        requireEnabled();
        var account = accounts.requireActiveAccount(ownerSubject);
        var publicKey = decode(request.recoveryDevicePublicKey());
        if (publicKey.length < 32 || publicKey.length > 16_384) throw invalid("INVALID_DEVICE_KEY");
        return transactions.execute(status -> {
            lockAccount(account.accountId());
            var existing = loadOptional(account.accountId(), true);
            if (existing != null && !isTerminal(existing.status())) {
                if (existing.attemptId().equals(request.recoveryAttemptId())
                        && existing.deviceId().equals(request.recoveryDeviceId())) return response(existing, null);
                throw invalid("RECOVERY_ALREADY_ACTIVE");
            }
            var now = OffsetDateTime.now(clock);
            var expires = now.plus(Duration.ofHours(24));
            jdbc.update("""
                INSERT INTO sync_devices (
                    device_id, account_id, device_public_key, device_role, device_status,
                    registered_at, last_seen_at, created_protocol_version, last_app_version
                ) VALUES (?, ?, ?, 'PRIMARY', 'RECOVERY_PENDING', ?, ?, 2, ?)
                ON CONFLICT (device_id) DO NOTHING
                """, request.recoveryDeviceId(), account.accountId(), publicKey, now, now, request.platform());
            var deviceKey = jdbc.queryForObject("SELECT device_public_key FROM sync_devices WHERE account_id = ? AND device_id = ?",
                byte[].class, account.accountId(), request.recoveryDeviceId());
            if (!java.security.MessageDigest.isEqual(deviceKey, publicKey)) throw invalid("IDEMPOTENCY_MISMATCH");
            jdbc.update("""
                INSERT INTO sync_device_cursors (account_id, device_id, last_applied_sequence, last_acknowledged_at)
                VALUES (?, ?, 0, ?) ON CONFLICT (account_id, device_id) DO NOTHING
                """, account.accountId(), request.recoveryDeviceId(), now);
            jdbc.update("""
                INSERT INTO sync_recovery_state (
                    account_id, recovery_attempt_id, requested_by_device_id, recovery_device_id,
                    recovery_status, requested_at, expires_at, updated_at
                ) VALUES (?, ?, ?, ?, 'REQUESTED', ?, ?, ?)
                ON CONFLICT (account_id) DO UPDATE SET
                    recovery_attempt_id = EXCLUDED.recovery_attempt_id,
                    requested_by_device_id = EXCLUDED.requested_by_device_id,
                    recovery_device_id = EXCLUDED.recovery_device_id,
                    recovery_status = 'REQUESTED', requested_at = EXCLUDED.requested_at,
                    expires_at = EXCLUDED.expires_at, completed_at = NULL,
                    validation_snapshot_id = NULL, last_error_code = NULL, updated_at = EXCLUDED.updated_at
                """, account.accountId(), request.recoveryAttemptId(), request.recoveryDeviceId(),
                request.recoveryDeviceId(), now, expires, now);
            return response(load(account.accountId(), false), null);
        });
    }

    public RecoveryResponse approve(String ownerSubject, UUID attemptId, UUID recoveryDeviceId) {
        requireEnabled();
        var account = accounts.requireActiveAccount(ownerSubject);
        keyPackages.latestRecovery(ownerSubject);
        return transactions.execute(status -> {
            lockAccount(account.accountId());
            var state = requireAttempt(account.accountId(), attemptId, recoveryDeviceId, true);
            requireNotExpired(state);
            if ("APPROVED".equals(state.status()) || later(state.status())) return response(state, null);
            if (!"REQUESTED".equals(state.status())) throw invalid("INVALID_RECOVERY_TRANSITION");
            updateStatus(account.accountId(), "APPROVED", null, null);
            return response(load(account.accountId(), false), null);
        });
    }

    public RecoveryResponse packageForRecovery(String ownerSubject, UUID attemptId, UUID recoveryDeviceId) {
        requireEnabled();
        var account = accounts.requireActiveAccount(ownerSubject);
        var state = requireAttempt(account.accountId(), attemptId, recoveryDeviceId, false);
        requireNotExpired(state);
        if (!"APPROVED".equals(state.status()) && !"KEY_PACKAGE_PENDING".equals(state.status())
                && !"KEY_PACKAGE_AVAILABLE".equals(state.status())) {
            throw invalid("INVALID_RECOVERY_TRANSITION");
        }
        if ("APPROVED".equals(state.status())) {
            transactions.executeWithoutResult(status -> {
                lockAccount(account.accountId());
                updateStatus(account.accountId(), "KEY_PACKAGE_PENDING", null, null);
            });
            state = load(account.accountId(), false);
        }
        var keyPackage = keyPackages.latestRecovery(ownerSubject);
        if ("KEY_PACKAGE_PENDING".equals(state.status())) {
            transactions.executeWithoutResult(status -> {
                lockAccount(account.accountId());
                updateStatus(account.accountId(), "KEY_PACKAGE_AVAILABLE", null, null);
            });
            state = load(account.accountId(), false);
        }
        return response(state, keyPackage);
    }

    public RecoveryResponse markLocalKeyPersisted(
            String ownerSubject, UUID attemptId, RecoveryRequests.Persisted request) {
        requireEnabled();
        var account = accounts.requireActiveAccount(ownerSubject);
        return transactions.execute(status -> {
            lockAccount(account.accountId());
            var state = requireAttempt(account.accountId(), attemptId, request.recoveryDeviceId(), true);
            requireNotExpired(state);
            if ("LOCAL_KEY_PERSISTED".equals(state.status()) || "COMPLETED".equals(state.status())) return response(state, null);
            if (!"KEY_PACKAGE_AVAILABLE".equals(state.status())) throw invalid("INVALID_RECOVERY_TRANSITION");
            requireSnapshot(account.accountId(), request.validationSnapshotId());
            var publicKey = jdbc.queryForObject("SELECT device_public_key FROM sync_devices WHERE account_id = ? AND device_id = ?",
                byte[].class, account.accountId(), request.recoveryDeviceId());
            verify(publicKey, "recovery-key-persisted:" + attemptId + ":" + request.validationSnapshotId(),
                request.possessionSignature());
            updateStatus(account.accountId(), "LOCAL_KEY_PERSISTED", request.validationSnapshotId(), null);
            return response(load(account.accountId(), false), null);
        });
    }

    public RecoveryResponse finalizeRecovery(String ownerSubject, UUID attemptId, UUID recoveryDeviceId) {
        requireEnabled();
        var account = accounts.requireActiveAccount(ownerSubject);
        return transactions.execute(status -> {
            var currentSequence = lockAccount(account.accountId());
            var state = requireAttempt(account.accountId(), attemptId, recoveryDeviceId, true);
            requireNotExpired(state);
            if ("COMPLETED".equals(state.status())) return response(state, null);
            if (!"LOCAL_KEY_PERSISTED".equals(state.status())) throw invalid("INVALID_RECOVERY_TRANSITION");
            var cursor = jdbc.queryForObject("""
                SELECT last_applied_sequence FROM sync_device_cursors WHERE account_id = ? AND device_id = ?
                """, Long.class, account.accountId(), recoveryDeviceId);
            if (cursor == null || cursor != currentSequence) throw new ApiException("RECOVERY_CURSOR_STALE",
                HttpStatus.CONFLICT, "Recovery must restore through the current sequence.", true, false, Map.of());
            requireSnapshot(account.accountId(), state.snapshotId());
            var now = OffsetDateTime.now(clock);
            updateStatus(account.accountId(), "FINALIZING", state.snapshotId(), null);
            jdbc.update("""
                UPDATE sync_devices SET device_status = 'REVOKED', revoked_at = ?
                WHERE account_id = ? AND device_role = 'PRIMARY' AND device_id <> ? AND device_status = 'ACTIVE'
                """, now, account.accountId(), recoveryDeviceId);
            jdbc.update("""
                UPDATE sync_devices SET device_status = 'ACTIVE', revoked_at = NULL, last_seen_at = ?
                WHERE account_id = ? AND device_id = ? AND device_status = 'RECOVERY_PENDING'
                """, now, account.accountId(), recoveryDeviceId);
            jdbc.update("""
                UPDATE sync_recovery_state SET recovery_status = 'COMPLETED', completed_at = ?, updated_at = ?
                WHERE account_id = ?
                """, now, now, account.accountId());
            return response(load(account.accountId(), false), null);
        });
    }

    public RecoveryResponse get(String ownerSubject) {
        var account = accounts.requireActiveAccount(ownerSubject);
        var state = loadOptional(account.accountId(), false);
        return state == null ? new RecoveryResponse(null, null, "NONE", null, null, null) : response(state, null);
    }

    private void requireEnabled() {
        if (!protocols.current().featureFlags().primaryRecoveryEnabled()) throw new ApiException(
            "PRIMARY_RECOVERY_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
            "Primary recovery is temporarily disabled.", true, false, Map.of());
    }
    private long lockAccount(UUID id) { return jdbc.queryForObject(
        "SELECT current_sequence FROM sync_accounts WHERE account_id = ? FOR UPDATE", Long.class, id); }
    private void requireSnapshot(UUID accountId, UUID snapshotId) {
        if (snapshotId == null) throw invalid("SNAPSHOT_NOT_FOUND");
        var count = jdbc.queryForObject("""
            SELECT count(*) FROM sync_snapshots WHERE account_id = ? AND snapshot_id = ? AND snapshot_status = 'AVAILABLE'
            """, Long.class, accountId, snapshotId);
        if (count == null || count == 0) throw invalid("SNAPSHOT_NOT_FOUND");
    }
    private RecoveryRow requireAttempt(UUID accountId, UUID attempt, UUID device, boolean lock) {
        var state = load(accountId, lock);
        if (!attempt.equals(state.attemptId()) || !device.equals(state.deviceId())) throw invalid("RECOVERY_NOT_FOUND");
        return state;
    }
    private void requireNotExpired(RecoveryRow row) {
        if (OffsetDateTime.now(clock).isAfter(row.expiresAt())) throw invalid("RECOVERY_EXPIRED");
    }
    private void updateStatus(UUID accountId, String status, UUID snapshotId, String error) {
        jdbc.update("""
            UPDATE sync_recovery_state SET recovery_status = ?,
                validation_snapshot_id = COALESCE(?, validation_snapshot_id), last_error_code = ?, updated_at = ?
            WHERE account_id = ?
            """, status, snapshotId, error, OffsetDateTime.now(clock), accountId);
    }
    private RecoveryRow load(UUID accountId, boolean lock) {
        var row = loadOptional(accountId, lock);
        if (row == null) throw invalid("RECOVERY_NOT_FOUND");
        return row;
    }
    private RecoveryRow loadOptional(UUID accountId, boolean lock) {
        var rows = jdbc.query("""
            SELECT recovery_attempt_id, recovery_device_id, recovery_status,
                   validation_snapshot_id, expires_at
            FROM sync_recovery_state WHERE account_id = ?
            """ + (lock ? " FOR UPDATE" : ""), (rs, row) -> new RecoveryRow(
                rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3),
                rs.getObject(4, UUID.class), rs.getObject(5, OffsetDateTime.class)), accountId);
        return rows.isEmpty() ? null : rows.getFirst();
    }
    private RecoveryResponse response(RecoveryRow row, KeyPackageResponse keyPackage) {
        return new RecoveryResponse(row.attemptId(), row.deviceId(), row.status(), row.snapshotId(),
            row.expiresAt() == null ? null : row.expiresAt().toInstant(), keyPackage);
    }
    private boolean isTerminal(String status) { return "COMPLETED".equals(status) || "FAILED".equals(status) || "NONE".equals(status); }
    private boolean later(String status) { return java.util.Set.of("KEY_PACKAGE_PENDING", "KEY_PACKAGE_AVAILABLE", "LOCAL_KEY_PERSISTED", "FINALIZING", "COMPLETED").contains(status); }
    private byte[] decode(String value) { try { return Base64.getDecoder().decode(value); } catch (Exception e) { throw invalid("INVALID_DEVICE_KEY"); } }
    private void verify(byte[] publicKey, String message, String signature) {
        try {
            var verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(publicKey)));
            verifier.update(message.getBytes(StandardCharsets.UTF_8));
            if (!verifier.verify(Base64.getDecoder().decode(signature))) throw invalid("INVALID_RECOVERY_PROOF");
        } catch (ApiException e) { throw e; } catch (Exception e) { throw invalid("INVALID_RECOVERY_PROOF"); }
    }
    private ApiException invalid(String code) { return new ApiException(code, HttpStatus.CONFLICT,
        "The recovery state is invalid.", false, true, Map.of()); }
    private record RecoveryRow(UUID attemptId, UUID deviceId, String status, UUID snapshotId, OffsetDateTime expiresAt) {}
}
