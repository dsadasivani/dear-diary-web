package com.deardiary.sync.keypackage;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.objectstore.EncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectKeyFactory;
import com.deardiary.sync.objectstore.ObjectStoreException;
import com.deardiary.sync.objectstore.UploadObjectCommand;
import com.deardiary.sync.protocol.ProtocolService;
import java.time.Clock;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class KeyPackageService {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final DeviceAuthorizationService devices;
    private final AccountAuthorizationService accounts;
    private final ObjectKeyFactory objectKeys;
    private final EncryptedObjectStore objectStore;
    private final Clock clock;
    private final ProtocolService protocols;

    public KeyPackageService(JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            DeviceAuthorizationService devices, AccountAuthorizationService accounts,
            ObjectKeyFactory objectKeys, EncryptedObjectStore objectStore, Clock clock,
            ProtocolService protocols) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.devices = devices;
        this.accounts = accounts;
        this.objectKeys = objectKeys;
        this.objectStore = objectStore;
        this.clock = clock;
        this.protocols = protocols;
    }

    public KeyPackageResponse initiate(String ownerSubject, KeyPackageRequest request) {
        var creator = devices.requireActiveDevice(ownerSubject, request.creatorDeviceId());
        validate(creator.accountId(), creator.keyEpoch(), request);
        var row = transactions.execute(status -> persist(creator.accountId(), request));
        try {
            var upload = objectStore.initiateUpload(new UploadObjectCommand(
                new ObjectKey(row.objectKey()), "KEY_PACKAGE", row.sha256(), row.sizeBytes()));
            return response(row, null, null, new KeyPackageResponse.Upload(row.objectKey(),
                upload.url().toString(), upload.headers(), upload.expiresAt()));
        } catch (ObjectStoreException error) { throw storage(error); }
    }

    public KeyPackageResponse register(String ownerSubject, UUID packageId, UUID creatorDeviceId) {
        var creator = devices.requireActiveDevice(ownerSubject, creatorDeviceId);
        var row = load(creator.accountId(), packageId, false);
        if (!creatorDeviceId.equals(row.creatorDeviceId())) throw forbidden();
        verify(row);
        var available = transactions.execute(status -> activate(creator.accountId(), packageId, creatorDeviceId));
        return response(available, null, null, null);
    }

    public KeyPackageResponse latestRecovery(String ownerSubject) {
        var account = accounts.requireActiveAccount(ownerSubject);
        var rows = jdbc.query("""
            SELECT key_package_id, target_device_id, key_epoch, package_purpose, package_status,
                   object_key, sha256, size_bytes, created_by_device_id, rotation_id, recovery_attempt_id
            FROM sync_key_packages
            WHERE account_id = ? AND package_purpose = 'RECOVERY' AND package_status IN ('AVAILABLE', 'APPLIED')
            ORDER BY key_epoch DESC, created_at DESC LIMIT 1
            """, (rs, row) -> map(rs), account.accountId());
        if (rows.isEmpty()) throw new ApiException("RECOVERY_PACKAGE_NOT_FOUND", HttpStatus.NOT_FOUND,
            "No recovery key package is available.");
        try {
            var download = objectStore.createDownload(new ObjectKey(rows.getFirst().objectKey()));
            return response(rows.getFirst(), download.url().toString(), download.expiresAt(), null);
        } catch (ObjectStoreException error) { throw storage(error); }
    }

    public List<KeyPackageResponse> availableForDevice(String ownerSubject, UUID deviceId) {
        var device = devices.requireActiveDevice(ownerSubject, deviceId);
        return jdbc.query("""
            SELECT key_package_id, target_device_id, key_epoch, package_purpose, package_status,
                   object_key, sha256, size_bytes, created_by_device_id, rotation_id, recovery_attempt_id
            FROM sync_key_packages
            WHERE account_id = ? AND target_device_id = ? AND package_purpose = 'DEVICE'
              AND package_status = 'AVAILABLE'
            ORDER BY key_epoch DESC, created_at DESC
            """, (rs, row) -> map(rs), device.accountId(), deviceId).stream().map(row -> {
                try {
                    var download = objectStore.createDownload(new ObjectKey(row.objectKey()));
                    return response(row, download.url().toString(), download.expiresAt(), null);
                } catch (ObjectStoreException error) { throw storage(error); }
            }).toList();
    }

    public KeyPackageResponse applyDevicePackage(
            String ownerSubject, UUID packageId, ApplyDeviceKeyPackageRequest request) {
        var device = devices.requireActiveDevice(ownerSubject, request.deviceId());
        return transactions.execute(status -> {
            lockAccount(device.accountId());
            var row = load(device.accountId(), packageId, true);
            if (!row.targetDeviceId().equals(request.deviceId()) || !"DEVICE".equals(row.purpose())) throw forbidden();
            if ("APPLIED".equals(row.status())) return response(row, null, null, null);
            if (!"AVAILABLE".equals(row.status())) throw invalid("KEY_PACKAGE_NOT_AVAILABLE");
            var key = jdbc.queryForObject(
                "SELECT device_public_key FROM sync_devices WHERE account_id = ? AND device_id = ?",
                byte[].class, device.accountId(), request.deviceId());
            verifyPossession(key, "key-package-applied:" + packageId + ":" + row.keyEpoch(), request.possessionSignature());
            jdbc.update("UPDATE sync_key_packages SET package_status = 'APPLIED', applied_at = ? WHERE account_id = ? AND key_package_id = ?",
                OffsetDateTime.now(clock), device.accountId(), packageId);
            return response(load(device.accountId(), packageId, false), null, null, null);
        });
    }

    public long availableRotationPackageCount(UUID accountId, UUID rotationId, int epoch) {
        return jdbc.queryForObject("""
            SELECT count(*) FROM sync_key_packages
            WHERE account_id = ? AND rotation_id = ? AND key_epoch = ? AND package_status = 'AVAILABLE'
            """, Long.class, accountId, rotationId, epoch);
    }

    private void validate(UUID accountId, int currentEpoch, KeyPackageRequest request) {
        if (request.rotationId() != null && !protocols.current().featureFlags().keyRotationEnabled()) {
            throw invalid("KEY_ROTATION_DISABLED");
        }
        if ("RECOVERY".equals(request.purpose()) && request.rotationId() == null) {
            if (!protocols.current().featureFlags().primaryRecoveryEnabled()) throw invalid("PRIMARY_RECOVERY_DISABLED");
        }
        var targetStatus = jdbc.query("SELECT device_status FROM sync_devices WHERE account_id = ? AND device_id = ?",
            (rs, row) -> rs.getString(1), accountId, request.targetDeviceId());
        if (targetStatus.isEmpty() || "REVOKED".equals(targetStatus.getFirst())) throw forbidden();
        if ("RECOVERY".equals(request.purpose())) {
            if (!request.targetDeviceId().equals(request.creatorDeviceId())) {
                throw invalid("INVALID_RECOVERY_PACKAGE");
            }
            if (request.rotationId() == null && request.keyEpoch() != currentEpoch) throw invalid("KEY_EPOCH_MISMATCH");
            if (request.rotationId() != null) requireRotationTarget(
                accountId, request.rotationId(), request.keyEpoch(), request.targetDeviceId());
        } else if (request.rotationId() == null) {
            if (request.keyEpoch() != currentEpoch) throw invalid("KEY_EPOCH_MISMATCH");
        } else {
            requireRotationTarget(accountId, request.rotationId(), request.keyEpoch(), request.targetDeviceId());
        }
    }

    private void requireRotation(UUID accountId, UUID rotationId, int epoch) {
        var count = jdbc.queryForObject("""
            SELECT count(*) FROM sync_key_rotations
            WHERE account_id = ? AND rotation_id = ? AND to_key_epoch = ?
              AND rotation_status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
            """, Long.class, accountId, rotationId, epoch);
        if (count == null || count == 0) throw invalid("KEY_ROTATION_NOT_FOUND");
    }

    private void requireRotationTarget(UUID accountId, UUID rotationId, int epoch, UUID targetDeviceId) {
        requireRotation(accountId, rotationId, epoch);
        var revokedTarget = jdbc.queryForObject("""
            SELECT revoked_device_id FROM sync_key_rotations
            WHERE account_id = ? AND rotation_id = ?
            """, UUID.class, accountId, rotationId);
        if (targetDeviceId.equals(revokedTarget)) throw invalid("KEY_PACKAGE_TARGET_REVOKED");
    }

    private PackageRow persist(UUID accountId, KeyPackageRequest request) {
        lockAccount(accountId);
        var existing = loadOptional(accountId, request.keyPackageId(), true);
        if (existing != null) {
            if (!existing.targetDeviceId().equals(request.targetDeviceId())
                    || existing.keyEpoch() != request.keyEpoch() || !existing.purpose().equals(request.purpose())
                    || !existing.sha256().equals(request.sha256()) || existing.sizeBytes() != request.sizeBytes()
                    || !existing.creatorDeviceId().equals(request.creatorDeviceId())) {
                throw invalid("IDEMPOTENCY_MISMATCH");
            }
            return existing;
        }
        var objectKey = objectKeys.create(accountId).value();
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            INSERT INTO sync_objects (
                account_id, object_key, object_kind, sha256, size_bytes, key_epoch,
                storage_status, created_at, updated_at
            ) VALUES (?, ?, 'KEY_PACKAGE', ?, ?, ?, 'PENDING_UPLOAD', ?, ?)
            """, accountId, objectKey, request.sha256(), request.sizeBytes(), request.keyEpoch(), now, now);
        jdbc.update("""
            INSERT INTO sync_key_packages (
                account_id, key_package_id, target_device_id, key_epoch, object_key,
                package_status, package_purpose, sha256, size_bytes, package_schema_version,
                created_by_device_id, rotation_id, recovery_attempt_id, created_at
            ) VALUES (?, ?, ?, ?, ?, 'PENDING_UPLOAD', ?, ?, ?, ?, ?, ?, ?, ?)
            """, accountId, request.keyPackageId(), request.targetDeviceId(), request.keyEpoch(), objectKey,
            request.purpose(), request.sha256(), request.sizeBytes(), request.packageSchemaVersion(),
            request.creatorDeviceId(), request.rotationId(), request.recoveryAttemptId(), now);
        return load(accountId, request.keyPackageId(), false);
    }

    private PackageRow activate(UUID accountId, UUID packageId, UUID creatorDeviceId) {
        lockAccount(accountId);
        var row = load(accountId, packageId, true);
        if (!creatorDeviceId.equals(row.creatorDeviceId())) throw forbidden();
        if ("AVAILABLE".equals(row.status()) || "APPLIED".equals(row.status())) return row;
        var sequence = jdbc.queryForObject("SELECT current_sequence FROM sync_accounts WHERE account_id = ?", Long.class, accountId);
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            UPDATE sync_objects SET storage_status = 'COMMITTED', created_sequence = ?, updated_at = ?
            WHERE account_id = ? AND object_key = ?
            """, Math.max(1, sequence), now, accountId, row.objectKey());
        jdbc.update("UPDATE sync_key_packages SET package_status = 'AVAILABLE' WHERE account_id = ? AND key_package_id = ?",
            accountId, packageId);
        jdbc.update("""
            INSERT INTO sync_object_references (
                account_id, object_key, owner_record_type, owner_record_id,
                reference_kind, created_sequence, created_at
            ) VALUES (?, ?, 'ACCOUNT', ?, 'KEY_PACKAGE', ?, ?) ON CONFLICT DO NOTHING
            """, accountId, row.objectKey(), accountId.toString(), Math.max(1, sequence), now);
        return load(accountId, packageId, false);
    }

    private void verify(PackageRow row) {
        try {
            var metadata = objectStore.head(new ObjectKey(row.objectKey()));
            if (metadata.sizeBytes() != row.sizeBytes()) throw invalid("OBJECT_SIZE_MISMATCH");
            if (!metadata.sha256().equals(row.sha256())) throw invalid("HASH_MISMATCH");
        } catch (ObjectStoreException error) { throw storage(error); }
    }
    private void verifyPossession(byte[] publicKey, String message, String encodedSignature) {
        try {
            var verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(publicKey)));
            verifier.update(message.getBytes(StandardCharsets.UTF_8));
            if (!verifier.verify(Base64.getDecoder().decode(encodedSignature))) throw invalid("INVALID_KEY_PACKAGE_PROOF");
        } catch (ApiException error) { throw error; }
        catch (Exception error) { throw invalid("INVALID_KEY_PACKAGE_PROOF"); }
    }
    private void lockAccount(UUID id) { jdbc.queryForObject("SELECT account_id FROM sync_accounts WHERE account_id = ? FOR UPDATE", UUID.class, id); }
    private PackageRow load(UUID accountId, UUID id, boolean lock) {
        var row = loadOptional(accountId, id, lock);
        if (row == null) throw new ApiException("KEY_PACKAGE_NOT_FOUND", HttpStatus.NOT_FOUND, "The key package was not found.");
        return row;
    }
    private PackageRow loadOptional(UUID accountId, UUID id, boolean lock) {
        var rows = jdbc.query("""
            SELECT key_package_id, target_device_id, key_epoch, package_purpose, package_status,
                   object_key, sha256, size_bytes, created_by_device_id, rotation_id, recovery_attempt_id
            FROM sync_key_packages WHERE account_id = ? AND key_package_id = ?
            """ + (lock ? " FOR UPDATE" : ""), (rs, row) -> map(rs), accountId, id);
        return rows.isEmpty() ? null : rows.getFirst();
    }
    private PackageRow map(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new PackageRow(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getInt(3),
            rs.getString(4), rs.getString(5), rs.getString(6), rs.getString(7), rs.getLong(8),
            rs.getObject(9, UUID.class), rs.getObject(10, UUID.class), rs.getObject(11, UUID.class));
    }
    private KeyPackageResponse response(PackageRow row, String url, java.time.Instant expires, KeyPackageResponse.Upload upload) {
        return new KeyPackageResponse(row.packageId(), row.targetDeviceId(), row.keyEpoch(), row.purpose(),
            row.status(), row.objectKey(), row.sha256(), row.sizeBytes(), url, expires, upload);
    }
    private ApiException invalid(String code) { return new ApiException(code, HttpStatus.CONFLICT,
        "The encrypted key package request is invalid.", false, true, Map.of()); }
    private ApiException forbidden() { return new ApiException("KEY_PACKAGE_FORBIDDEN", HttpStatus.FORBIDDEN,
        "The key package target is not authorized.", false, true, Map.of()); }
    private ApiException storage(ObjectStoreException error) { return new ApiException(error.code(),
        error.retryable() ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.CONFLICT,
        "Encrypted key package storage is unavailable.", error.retryable(), false, Map.of()); }
    private record PackageRow(UUID packageId, UUID targetDeviceId, int keyEpoch, String purpose, String status,
        String objectKey, String sha256, long sizeBytes, UUID creatorDeviceId, UUID rotationId, UUID recoveryAttemptId) {}
}
