package com.deardiary.sync.pairing;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.objectstore.EncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectKeyFactory;
import com.deardiary.sync.objectstore.ObjectStoreException;
import com.deardiary.sync.objectstore.UploadObjectCommand;
import com.deardiary.sync.protocol.ProtocolService;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
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
public class PairingService {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final AccountAuthorizationService accounts;
    private final DeviceAuthorizationService devices;
    private final ProtocolService protocols;
    private final ObjectKeyFactory objectKeys;
    private final EncryptedObjectStore objectStore;
    private final Clock clock;

    public PairingService(JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            AccountAuthorizationService accounts, DeviceAuthorizationService devices,
            ProtocolService protocols, ObjectKeyFactory objectKeys,
            EncryptedObjectStore objectStore, Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.accounts = accounts;
        this.devices = devices;
        this.protocols = protocols;
        this.objectKeys = objectKeys;
        this.objectStore = objectStore;
        this.clock = clock;
    }

    public PairingResponse create(String ownerSubject, PairingRequests.Create request) {
        requireEnabled();
        var account = accounts.requireActiveAccount(ownerSubject);
        var publicKey = decode(request.requestedDevicePublicKey(), "INVALID_DEVICE_KEY");
        var challenge = decode(request.challenge(), "INVALID_PAIRING_CHALLENGE");
        if (publicKey.length < 32 || publicKey.length > 16_384 || challenge.length < 16 || challenge.length > 128) {
            throw invalid("INVALID_PAIRING_REQUEST", "The pairing request is invalid.");
        }
        return transactions.execute(status -> {
            lockAccount(account.accountId());
            var existing = loadOptional(account.accountId(), request.pairingId(), true);
            if (existing != null) {
                if (!existing.requestedDeviceId().equals(request.requestedDeviceId())
                        || !MessageDigest.isEqual(existing.publicKey(), publicKey)
                        || !existing.codeHash().equals(request.codeHash())
                        || !MessageDigest.isEqual(existing.challenge(), challenge)) {
                    throw invalid("IDEMPOTENCY_MISMATCH", "The pairing identifier has different metadata.");
                }
                return response(existing, null, null, null);
            }
            var now = OffsetDateTime.now(clock);
            var expires = now.plus(Duration.ofMinutes(10));
            jdbc.update("""
                INSERT INTO sync_pairing_requests (
                    account_id, pairing_id, requested_device_id, requested_device_public_key,
                    requested_device_role, platform, code_hash, challenge, pairing_status,
                    requested_at, expires_at
                ) VALUES (?, ?, ?, ?, 'COMPANION', ?, ?, ?, 'REQUESTED', ?, ?)
                """, account.accountId(), request.pairingId(), request.requestedDeviceId(), publicKey,
                request.platform(), request.codeHash(), challenge, now, expires);
            return response(load(account.accountId(), request.pairingId(), false), null, null, null);
        });
    }

    public PairingResponse approve(String ownerSubject, UUID pairingId, PairingRequests.Approve request) {
        requireEnabled();
        var approver = devices.requireActiveDevice(ownerSubject, request.approverDeviceId());
        requirePrimary(approver.accountId(), request.approverDeviceId());
        var persisted = transactions.execute(status -> approveTransaction(approver.accountId(), pairingId, request));
        try {
            var upload = objectStore.initiateUpload(new UploadObjectCommand(
                new ObjectKey(persisted.objectKey()), "KEY_PACKAGE", persisted.sha256(), persisted.sizeBytes()));
            return response(persisted, new PairingResponse.Upload(persisted.objectKey(), upload.url().toString(),
                upload.headers(), upload.expiresAt()), null, null);
        } catch (ObjectStoreException error) {
            throw storage(error);
        }
    }

    public PairingResponse registerPackage(String ownerSubject, UUID pairingId, UUID approverDeviceId) {
        requireEnabled();
        var approver = devices.requireActiveDevice(ownerSubject, approverDeviceId);
        requirePrimary(approver.accountId(), approverDeviceId);
        var pair = load(approver.accountId(), pairingId, false);
        requireApprover(pair, approverDeviceId);
        verifyObject(pair);
        var available = transactions.execute(status -> activatePackage(approver.accountId(), pairingId, approverDeviceId));
        return response(available, null, null, null);
    }

    public PairingResponse status(String ownerSubject, UUID pairingId, UUID requestedDeviceId) {
        var account = accounts.requireActiveAccount(ownerSubject);
        var pair = load(account.accountId(), pairingId, false);
        if (!pair.requestedDeviceId().equals(requestedDeviceId)) throw forbidden();
        if (OffsetDateTime.now(clock).isAfter(pair.expiresAt()) && "REQUESTED".equals(pair.status())) {
            expire(account.accountId(), pairingId);
            pair = load(account.accountId(), pairingId, false);
        }
        if (!"KEY_PACKAGE_AVAILABLE".equals(pair.status()) && !"COMPLETED".equals(pair.status())) {
            return response(pair, null, null, null);
        }
        try {
            var download = objectStore.createDownload(new ObjectKey(pair.objectKey()));
            return response(pair, null, download.url().toString(), download.expiresAt());
        } catch (ObjectStoreException error) {
            throw storage(error);
        }
    }

    public PairingResponse complete(String ownerSubject, UUID pairingId, PairingRequests.Complete request) {
        requireEnabled();
        var account = accounts.requireActiveAccount(ownerSubject);
        return transactions.execute(status -> {
            lockAccount(account.accountId());
            var pair = load(account.accountId(), pairingId, true);
            if (!pair.requestedDeviceId().equals(request.requestedDeviceId())) throw forbidden();
            if ("COMPLETED".equals(pair.status())) return response(pair, null, null, null);
            if (!"KEY_PACKAGE_AVAILABLE".equals(pair.status())) throw invalid("PAIRING_NOT_READY",
                "The pairing key package is not available.");
            verifySignature(pair.publicKey(), completionMessage(pair), request.possessionSignature(),
                "INVALID_PAIRING_PROOF");
            var now = OffsetDateTime.now(clock);
            jdbc.update("""
                UPDATE sync_devices SET device_status = 'ACTIVE', last_seen_at = ?
                WHERE account_id = ? AND device_id = ? AND device_status = 'RECOVERY_PENDING'
                """, now, account.accountId(), request.requestedDeviceId());
            jdbc.update("""
                UPDATE sync_key_packages SET package_status = 'APPLIED', applied_at = ?
                WHERE account_id = ? AND key_package_id = ?
                """, now, account.accountId(), pair.keyPackageId());
            jdbc.update("""
                UPDATE sync_pairing_requests SET pairing_status = 'COMPLETED', completed_at = ?
                WHERE account_id = ? AND pairing_id = ?
                """, now, account.accountId(), pairingId);
            return response(load(account.accountId(), pairingId, false), null, null, null);
        });
    }

    private PairRow approveTransaction(UUID accountId, UUID pairingId, PairingRequests.Approve request) {
        lockAccount(accountId);
        var pair = load(accountId, pairingId, true);
        if (OffsetDateTime.now(clock).isAfter(pair.expiresAt())) {
            expire(accountId, pairingId);
            throw invalid("PAIRING_EXPIRED", "The pairing request expired.");
        }
        if ("KEY_PACKAGE_PENDING".equals(pair.status()) || "KEY_PACKAGE_AVAILABLE".equals(pair.status())) {
            if (!request.keyPackageId().equals(pair.keyPackageId())
                    || !request.sha256().equals(pair.sha256()) || request.sizeBytes() != pair.sizeBytes()) {
                throw invalid("IDEMPOTENCY_MISMATCH", "The pairing approval has different metadata.");
            }
            return pair;
        }
        if (!"REQUESTED".equals(pair.status())) throw invalid("PAIRING_ALREADY_USED", "The pairing request was already used.");
        var actualHash = sha256(request.pairingCode().getBytes(StandardCharsets.UTF_8));
        if (!MessageDigest.isEqual(pair.codeHash().getBytes(StandardCharsets.US_ASCII), actualHash.getBytes(StandardCharsets.US_ASCII))) {
            throw invalid("PAIRING_CODE_INVALID", "The pairing code is invalid.");
        }
        var approverKey = jdbc.queryForObject("""
            SELECT device_public_key FROM sync_devices WHERE account_id = ? AND device_id = ?
            """, byte[].class, accountId, request.approverDeviceId());
        verifySignature(approverKey, approvalMessage(pair), request.approvalSignature(), "INVALID_PAIRING_APPROVAL");
        var objectKey = objectKeys.create(accountId).value();
        var epoch = jdbc.queryForObject("SELECT current_key_epoch FROM sync_accounts WHERE account_id = ?",
            Integer.class, accountId);
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            INSERT INTO sync_devices (
                device_id, account_id, device_public_key, device_role, device_status,
                registered_at, last_seen_at, created_protocol_version
            ) VALUES (?, ?, ?, 'COMPANION', 'RECOVERY_PENDING', ?, ?, 2)
            """, pair.requestedDeviceId(), accountId, pair.publicKey(), now, now);
        jdbc.update("""
            INSERT INTO sync_device_cursors (account_id, device_id, last_applied_sequence, last_acknowledged_at)
            VALUES (?, ?, 0, ?)
            """, accountId, pair.requestedDeviceId(), now);
        jdbc.update("""
            INSERT INTO sync_objects (
                account_id, object_key, object_kind, sha256, size_bytes, key_epoch,
                storage_status, created_at, updated_at
            ) VALUES (?, ?, 'KEY_PACKAGE', ?, ?, ?, 'PENDING_UPLOAD', ?, ?)
            """, accountId, objectKey, request.sha256(), request.sizeBytes(), epoch, now, now);
        jdbc.update("""
            INSERT INTO sync_key_packages (
                account_id, key_package_id, target_device_id, key_epoch, object_key,
                package_status, package_purpose, sha256, size_bytes, package_schema_version,
                created_by_device_id, pairing_id, created_at
            ) VALUES (?, ?, ?, ?, ?, 'PENDING_UPLOAD', 'DEVICE', ?, ?, ?, ?, ?, ?)
            """, accountId, request.keyPackageId(), pair.requestedDeviceId(), epoch, objectKey,
            request.sha256(), request.sizeBytes(), request.packageSchemaVersion(),
            request.approverDeviceId(), pairingId, now);
        jdbc.update("""
            UPDATE sync_pairing_requests SET pairing_status = 'KEY_PACKAGE_PENDING',
                approved_by_device_id = ?, key_package_id = ?, approved_at = ?
            WHERE account_id = ? AND pairing_id = ?
            """, request.approverDeviceId(), request.keyPackageId(), now, accountId, pairingId);
        return load(accountId, pairingId, false);
    }

    private PairRow activatePackage(UUID accountId, UUID pairingId, UUID approverDeviceId) {
        lockAccount(accountId);
        var pair = load(accountId, pairingId, true);
        requireApprover(pair, approverDeviceId);
        if ("KEY_PACKAGE_AVAILABLE".equals(pair.status()) || "COMPLETED".equals(pair.status())) return pair;
        if (!"KEY_PACKAGE_PENDING".equals(pair.status())) throw invalid("PAIRING_NOT_READY", "The pairing is not ready.");
        var sequence = jdbc.queryForObject("SELECT current_sequence FROM sync_accounts WHERE account_id = ?", Long.class, accountId);
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            UPDATE sync_objects SET storage_status = 'COMMITTED', created_sequence = ?, updated_at = ?
            WHERE account_id = ? AND object_key = ?
            """, Math.max(1, sequence), now, accountId, pair.objectKey());
        jdbc.update("""
            UPDATE sync_key_packages SET package_status = 'AVAILABLE'
            WHERE account_id = ? AND key_package_id = ?
            """, accountId, pair.keyPackageId());
        jdbc.update("""
            INSERT INTO sync_object_references (
                account_id, object_key, owner_record_type, owner_record_id,
                reference_kind, created_sequence, created_at
            ) VALUES (?, ?, 'ACCOUNT', ?, 'KEY_PACKAGE', ?, ?) ON CONFLICT DO NOTHING
            """, accountId, pair.objectKey(), accountId, Math.max(1, sequence), now);
        jdbc.update("""
            UPDATE sync_pairing_requests SET pairing_status = 'KEY_PACKAGE_AVAILABLE'
            WHERE account_id = ? AND pairing_id = ?
            """, accountId, pairingId);
        return load(accountId, pairingId, false);
    }

    private void verifyObject(PairRow pair) {
        try {
            var metadata = objectStore.head(new ObjectKey(pair.objectKey()));
            if (metadata.sizeBytes() != pair.sizeBytes()) throw integrity("OBJECT_SIZE_MISMATCH");
            if (!metadata.sha256().equals(pair.sha256())) throw integrity("HASH_MISMATCH");
        } catch (ObjectStoreException error) { throw storage(error); }
    }

    private void requireEnabled() {
        if (!protocols.current().featureFlags().companionPairingEnabled()) throw new ApiException(
            "COMPANION_PAIRING_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
            "Companion pairing is temporarily disabled.", true, false, Map.of());
    }

    private void requirePrimary(UUID accountId, UUID deviceId) {
        var role = jdbc.queryForObject("SELECT device_role FROM sync_devices WHERE account_id = ? AND device_id = ?",
            String.class, accountId, deviceId);
        if (!"PRIMARY".equals(role)) throw forbidden();
    }

    private void requireApprover(PairRow pair, UUID deviceId) {
        if (pair.approverDeviceId() == null || !pair.approverDeviceId().equals(deviceId)) throw forbidden();
    }

    private void lockAccount(UUID accountId) {
        jdbc.queryForObject("SELECT account_id FROM sync_accounts WHERE account_id = ? FOR UPDATE", UUID.class, accountId);
    }

    private PairRow load(UUID accountId, UUID pairingId, boolean lock) {
        var row = loadOptional(accountId, pairingId, lock);
        if (row == null) throw new ApiException("PAIRING_NOT_FOUND", HttpStatus.NOT_FOUND, "The pairing request was not found.");
        return row;
    }

    private PairRow loadOptional(UUID accountId, UUID pairingId, boolean lock) {
        var rows = jdbc.query("""
            SELECT p.pairing_id, p.requested_device_id, p.requested_device_public_key,
                   p.code_hash, p.challenge, p.pairing_status, p.approved_by_device_id,
                   p.key_package_id, p.expires_at, k.key_epoch, k.object_key, k.sha256, k.size_bytes
            FROM sync_pairing_requests p
            LEFT JOIN sync_key_packages k ON k.account_id = p.account_id AND k.key_package_id = p.key_package_id
            WHERE p.account_id = ? AND p.pairing_id = ?
            """ + (lock ? " FOR UPDATE OF p" : ""), (rs, row) -> new PairRow(
                rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getBytes(3),
                rs.getString(4), rs.getBytes(5), rs.getString(6), rs.getObject(7, UUID.class),
                rs.getObject(8, UUID.class), rs.getObject(9, OffsetDateTime.class),
                nullableInt(rs, 10), rs.getString(11), rs.getString(12), nullableLong(rs, 13)),
            accountId, pairingId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private PairingResponse response(PairRow pair, PairingResponse.Upload upload, String downloadUrl, java.time.Instant expires) {
        return new PairingResponse(pair.pairingId(), pair.requestedDeviceId(), pair.status(),
            pair.keyEpoch() == null ? 0 : pair.keyEpoch(), pair.keyPackageId(), pair.objectKey(), pair.sha256(),
            pair.sizeBytes(), downloadUrl, expires, upload, pair.expiresAt().toInstant());
    }

    private String approvalMessage(PairRow pair) {
        return pair.pairingId() + ":" + pair.requestedDeviceId() + ":"
            + Base64.getEncoder().encodeToString(pair.challenge()) + ":" + pair.codeHash();
    }
    private String completionMessage(PairRow pair) {
        return "pairing-complete:" + pair.pairingId() + ":" + pair.keyPackageId();
    }

    private void verifySignature(byte[] publicKey, String message, String signature, String code) {
        try {
            var key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(publicKey));
            var verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(key);
            verifier.update(message.getBytes(StandardCharsets.UTF_8));
            if (!verifier.verify(decode(signature, code))) throw invalid(code, "The pairing proof is invalid.");
        } catch (ApiException error) { throw error; }
        catch (Exception error) { throw invalid(code, "The pairing proof is invalid."); }
    }

    private void expire(UUID accountId, UUID pairingId) {
        jdbc.update("""
            UPDATE sync_pairing_requests SET pairing_status = 'EXPIRED'
            WHERE account_id = ? AND pairing_id = ? AND pairing_status = 'REQUESTED'
            """, accountId, pairingId);
    }

    private byte[] decode(String value, String code) {
        try { return Base64.getDecoder().decode(value); }
        catch (IllegalArgumentException error) { throw invalid(code, "Encoded pairing data is invalid."); }
    }
    private String sha256(byte[] bytes) {
        try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }
    private ApiException forbidden() { return new ApiException("PAIRING_FORBIDDEN", HttpStatus.FORBIDDEN,
        "An active primary device must approve pairing.", false, true, Map.of()); }
    private ApiException invalid(String code, String message) { return new ApiException(code, HttpStatus.CONFLICT, message); }
    private ApiException integrity(String code) { return new ApiException(code, HttpStatus.CONFLICT,
        "The encrypted key package failed verification.", false, true, Map.of()); }
    private ApiException storage(ObjectStoreException error) { return new ApiException(error.code(),
        error.retryable() ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.CONFLICT,
        "Encrypted key package storage is unavailable.", error.retryable(), false, Map.of()); }
    private Integer nullableInt(java.sql.ResultSet rs, int index) throws java.sql.SQLException {
        var value = rs.getInt(index); return rs.wasNull() ? null : value;
    }
    private Long nullableLong(java.sql.ResultSet rs, int index) throws java.sql.SQLException {
        var value = rs.getLong(index); return rs.wasNull() ? null : value;
    }

    private record PairRow(
        UUID pairingId, UUID requestedDeviceId, byte[] publicKey, String codeHash, byte[] challenge,
        String status, UUID approverDeviceId, UUID keyPackageId, OffsetDateTime expiresAt,
        Integer keyEpoch, String objectKey, String sha256, Long sizeBytes
    ) {}
}
