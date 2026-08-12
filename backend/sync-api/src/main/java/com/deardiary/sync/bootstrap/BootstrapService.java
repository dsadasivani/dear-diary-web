package com.deardiary.sync.bootstrap;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.objectstore.EncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectStoreException;
import com.deardiary.sync.protocol.ProtocolService;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.sql.Array;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
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
public class BootstrapService {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final AccountAuthorizationService accounts;
    private final DeviceAuthorizationService devices;
    private final ProtocolService protocols;
    private final EncryptedObjectStore objectStore;
    private final Clock clock;

    public BootstrapService(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            AccountAuthorizationService accounts,
            DeviceAuthorizationService devices,
            ProtocolService protocols,
            EncryptedObjectStore objectStore,
            Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.accounts = accounts;
        this.devices = devices;
        this.protocols = protocols;
        this.objectStore = objectStore;
        this.clock = clock;
    }

    public BootstrapReadinessResponse readiness(String ownerSubject, UUID deviceId) {
        var device = devices.requireActiveDevice(ownerSubject, deviceId);
        var role = jdbc.queryForObject(
            "SELECT device_role FROM sync_devices WHERE account_id = ? AND device_id = ?",
            String.class, device.accountId(), deviceId);
        if (!"PRIMARY".equals(role)) throw forbidden();
        var controls = controls();
        var account = accountState(device.accountId());
        var snapshot = latestSnapshot(device.accountId());
        var lag = snapshot == null ? account.headSequence() : account.headSequence() - snapshot.sequence();
        var tooOld = snapshot == null || snapshot.createdAt().plusDays(controls.maximumSnapshotAgeDays())
            .isBefore(OffsetDateTime.now(clock));
        var required = snapshot == null || lag > controls.hardTailEvents() || (lag > 0 && tooOld);
        return new BootstrapReadinessResponse(
            required ? "SNAPSHOT_PREPARING" : "BOOTSTRAP_READY",
            account.headSequence(), account.minimumAvailableSequence(),
            snapshot == null ? null : snapshot.snapshotId(),
            snapshot == null ? null : snapshot.sequence(),
            snapshot == null ? null : snapshot.createdAt().toInstant(),
            lag, required, controls.softTailEvents(), controls.hardTailEvents());
    }

    public BootstrapManifestResponse create(String ownerSubject, BootstrapRequests.Create request) {
        requireEnabled();
        var account = accounts.requireActiveAccount(ownerSubject);
        return transactions.execute(status -> {
            lockAccount(account.accountId());
            var existing = loadOptional(account.accountId(), request.bootstrapId(), true);
            if (existing != null) {
                if (!existing.deviceId().equals(request.deviceId())
                        || !java.util.Objects.equals(existing.pairingId(), request.pairingId())) {
                    throw conflict("IDEMPOTENCY_MISMATCH", "The bootstrap identifier has different metadata.");
                }
                return response(account.accountId(), existing);
            }
            requireBootstrapDevice(account.accountId(), request.deviceId(), request.pairingId());
            var state = accountState(account.accountId());
            var snapshot = latestSnapshot(account.accountId());
            if (snapshot == null || snapshot.sequence() < state.minimumAvailableSequence()) {
                throw snapshotRequired("No verified snapshot covers the retained event boundary.", state, snapshot);
            }
            var controls = controls();
            var tail = state.headSequence() - snapshot.sequence();
            if (tail > controls.hardTailEvents()) {
                throw snapshotRequired("A fresh snapshot is required before this companion can activate.", state, snapshot);
            }
            var now = OffsetDateTime.now(clock);
            var expires = now.plus(Duration.ofMinutes(controls.bootstrapExpiryMinutes()));
            jdbc.update("""
                INSERT INTO sync_bootstraps (
                    account_id, bootstrap_id, device_id, pairing_id, snapshot_id,
                    snapshot_sequence, head_sequence, required_key_epochs,
                    bootstrap_status, expires_at, created_at
                )
                SELECT ?, ?, ?, ?, ?, ?, ?,
                    ARRAY(
                        SELECT DISTINCT epoch FROM (
                            SELECT key_epoch AS epoch FROM sync_events
                            WHERE account_id = ? AND sequence > ? AND sequence <= ?
                            UNION SELECT ?
                        ) required ORDER BY epoch
                    ),
                    'READY', ?, ?
                """, account.accountId(), request.bootstrapId(), request.deviceId(), request.pairingId(),
                snapshot.snapshotId(), snapshot.sequence(), state.headSequence(), account.accountId(),
                snapshot.sequence(), state.headSequence(), snapshot.keyEpoch(), expires, now);
            // A stale device can have acknowledged events newer than the pinned
            // snapshot. Rebootstrap intentionally replaces its local canonical
            // state, so pin its server cursor to the same verified restore point.
            // Active bootstraps block retention until completion or expiry.
            jdbc.update("""
                UPDATE sync_device_cursors c
                SET last_applied_sequence = LEAST(c.last_applied_sequence, ?),
                    last_acknowledged_at = ?
                FROM sync_devices d
                WHERE c.account_id = ? AND c.device_id = ?
                  AND d.account_id = c.account_id AND d.device_id = c.device_id
                  AND d.rebootstrap_required = TRUE
                """, snapshot.sequence(), now, account.accountId(), request.deviceId());
            if (request.pairingId() != null) {
                jdbc.update("""
                    UPDATE sync_pairing_requests SET pairing_status = 'BOOTSTRAP_READY'
                    WHERE account_id = ? AND pairing_id = ?
                      AND pairing_status IN ('KEY_PACKAGE_AVAILABLE', 'ACTIVATING', 'BOOTSTRAP_READY')
                    """, account.accountId(), request.pairingId());
            }
            return response(account.accountId(), load(account.accountId(), request.bootstrapId(), false));
        });
    }

    public BootstrapManifestResponse get(String ownerSubject, UUID bootstrapId) {
        var account = accounts.requireActiveAccount(ownerSubject);
        expire(account.accountId(), bootstrapId);
        return response(account.accountId(), load(account.accountId(), bootstrapId, false));
    }

    public BootstrapManifestResponse complete(
            String ownerSubject, UUID bootstrapId, BootstrapRequests.Complete request) {
        requireEnabled();
        var account = accounts.requireActiveAccount(ownerSubject);
        return transactions.execute(status -> {
            lockAccount(account.accountId());
            var row = load(account.accountId(), bootstrapId, true);
            if ("COMPLETED".equals(row.status())) return response(account.accountId(), row);
            if (OffsetDateTime.now(clock).isAfter(row.expiresAt())) {
                markExpired(account.accountId(), bootstrapId);
                throw conflict("BOOTSTRAP_EXPIRED", "The bootstrap manifest expired.");
            }
            if (!row.deviceId().equals(request.deviceId())
                    || request.appliedThroughSequence() != row.headSequence()) {
                throw conflict("BOOTSTRAP_HEAD_NOT_APPLIED", "The pinned bootstrap head has not been applied.");
            }
            var device = jdbc.queryForObject("""
                SELECT device_public_key FROM sync_devices
                WHERE account_id = ? AND device_id = ?
                  AND device_status IN ('ACTIVE', 'RECOVERY_PENDING')
                FOR UPDATE
                """, byte[].class, account.accountId(), request.deviceId());
            verifySignature(device, completionMessage(row), request.possessionSignature());
            var cursor = jdbc.queryForObject("""
                SELECT last_applied_sequence FROM sync_device_cursors
                WHERE account_id = ? AND device_id = ? FOR UPDATE
                """, Long.class, account.accountId(), request.deviceId());
            if (cursor != row.headSequence()) {
                throw conflict("BOOTSTRAP_HEAD_NOT_ACKNOWLEDGED", "The pinned bootstrap head has not been acknowledged.");
            }
            var now = OffsetDateTime.now(clock);
            jdbc.update("""
                UPDATE sync_devices SET device_status = 'ACTIVE', rebootstrap_required = FALSE,
                    last_seen_at = ? WHERE account_id = ? AND device_id = ?
                """, now, account.accountId(), request.deviceId());
            jdbc.update("""
                UPDATE sync_bootstraps SET bootstrap_status = 'COMPLETED', completed_at = ?
                WHERE account_id = ? AND bootstrap_id = ?
                """, now, account.accountId(), bootstrapId);
            if (row.pairingId() != null) {
                jdbc.update("""
                    UPDATE sync_pairing_requests SET pairing_status = 'COMPLETED', completed_at = ?
                    WHERE account_id = ? AND pairing_id = ?
                    """, now, account.accountId(), row.pairingId());
            }
            return response(account.accountId(), load(account.accountId(), bootstrapId, false));
        });
    }

    private BootstrapManifestResponse response(UUID accountId, BootstrapRow row) {
        String downloadUrl = null;
        java.time.Instant downloadExpiresAt = null;
        var chunks = new ArrayList<BootstrapManifestResponse.Snapshot.Chunk>();
        if (!"EXPIRED".equals(row.status()) && !"FAILED".equals(row.status())) {
            try {
                var persisted = jdbc.query("""
                    SELECT chunk_index, object_key, sha256, size_bytes, key_epoch
                    FROM sync_snapshot_chunks
                    WHERE account_id = ? AND snapshot_id = ? ORDER BY chunk_index
                    """, (rs, index) -> new Object[] { rs.getInt(1), rs.getString(2),
                        rs.getString(3), rs.getLong(4), rs.getInt(5) }, accountId, row.snapshotId());
                for (var chunk : persisted) {
                    var download = objectStore.createDownload(new ObjectKey((String) chunk[1]));
                    chunks.add(new BootstrapManifestResponse.Snapshot.Chunk(
                        (Integer) chunk[0], (String) chunk[1], (String) chunk[2],
                        (Long) chunk[3], (Integer) chunk[4], download.url().toString(),
                        download.expiresAt()));
                }
                if (chunks.isEmpty()) {
                    var download = objectStore.createDownload(new ObjectKey(row.objectKey()));
                    downloadUrl = download.url().toString();
                    downloadExpiresAt = download.expiresAt();
                } else {
                    downloadUrl = chunks.getFirst().downloadUrl();
                    downloadExpiresAt = chunks.getFirst().downloadExpiresAt();
                }
            } catch (ObjectStoreException error) {
                throw new ApiException(error.code(), HttpStatus.SERVICE_UNAVAILABLE,
                    "The pinned snapshot is temporarily unavailable.", true, false, Map.of());
            }
        }
        return new BootstrapManifestResponse(
            row.bootstrapId(), row.deviceId(), row.pairingId(), row.status(),
            new BootstrapManifestResponse.Snapshot(
                row.snapshotId(), "AVAILABLE", row.snapshotSequence(), row.partitionKey(), row.objectKey(),
                row.sha256(), row.sizeBytes(), row.keyEpoch(), row.snapshotSchemaVersion(),
                row.metadataSignature(), downloadUrl, downloadExpiresAt, List.copyOf(chunks)),
            row.headSequence(), row.minimumAvailableSequence(), row.requiredKeyEpochs(),
            Math.toIntExact(row.headSequence() - row.snapshotSequence()),
            row.expiresAt().toInstant(),
            row.completedAt() == null ? null : row.completedAt().toInstant());
    }

    private BootstrapRow load(UUID accountId, UUID bootstrapId, boolean lock) {
        var row = loadOptional(accountId, bootstrapId, lock);
        if (row == null) throw new ApiException("BOOTSTRAP_NOT_FOUND", HttpStatus.NOT_FOUND,
            "The bootstrap manifest was not found.");
        return row;
    }

    private BootstrapRow loadOptional(UUID accountId, UUID bootstrapId, boolean lock) {
        var rows = jdbc.query("""
            SELECT b.bootstrap_id, b.device_id, b.pairing_id, b.bootstrap_status,
                   b.snapshot_id, b.snapshot_sequence, b.head_sequence,
                   b.required_key_epochs, b.expires_at, b.completed_at,
                   s.partition_key, s.object_key, s.sha256, s.size_bytes,
                   s.key_epoch, s.snapshot_schema_version, s.metadata_signature,
                   a.minimum_available_sequence
            FROM sync_bootstraps b
            JOIN sync_snapshots s ON s.account_id = b.account_id AND s.snapshot_id = b.snapshot_id
            JOIN sync_accounts a ON a.account_id = b.account_id
            WHERE b.account_id = ? AND b.bootstrap_id = ?
            """ + (lock ? " FOR UPDATE OF b" : ""), (rs, index) -> new BootstrapRow(
                rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class),
                rs.getString(4), rs.getObject(5, UUID.class), rs.getLong(6), rs.getLong(7),
                integerList(rs.getArray(8)), rs.getObject(9, OffsetDateTime.class),
                rs.getObject(10, OffsetDateTime.class), rs.getString(11), rs.getString(12),
                rs.getString(13), rs.getLong(14), rs.getInt(15), rs.getInt(16),
                rs.getString(17), rs.getLong(18)), accountId, bootstrapId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private SnapshotRow latestSnapshot(UUID accountId) {
        var rows = jdbc.query("""
            SELECT snapshot_id, sequence, key_epoch, created_at
            FROM sync_snapshots
            WHERE account_id = ? AND partition_key = 'account'
              AND snapshot_status = 'AVAILABLE' AND verified = TRUE
            ORDER BY sequence DESC, created_at DESC LIMIT 1
            """, (rs, index) -> new SnapshotRow(
                rs.getObject(1, UUID.class), rs.getLong(2), rs.getInt(3),
                rs.getObject(4, OffsetDateTime.class)), accountId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private AccountState accountState(UUID accountId) {
        return jdbc.queryForObject("""
            SELECT current_sequence, minimum_available_sequence
            FROM sync_accounts WHERE account_id = ?
            """, (rs, index) -> new AccountState(rs.getLong(1), rs.getLong(2)), accountId);
    }

    private void requireBootstrapDevice(UUID accountId, UUID deviceId, UUID pairingId) {
        var matches = jdbc.queryForObject("""
            SELECT COUNT(*) FROM sync_devices d
            WHERE d.account_id = ? AND d.device_id = ?
              AND d.device_status IN ('ACTIVE', 'RECOVERY_PENDING')
              AND (?::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM sync_pairing_requests p
                  WHERE p.account_id = d.account_id AND p.pairing_id = ?
                    AND p.requested_device_id = d.device_id
                    AND p.pairing_status IN ('KEY_PACKAGE_AVAILABLE', 'BOOTSTRAP_READY', 'ACTIVATING')
              ))
            """, Integer.class, accountId, deviceId, pairingId, pairingId);
        if (matches == null || matches != 1) throw forbidden();
    }

    private com.deardiary.sync.protocol.ProtocolResponse.BootstrapControls controls() {
        return protocols.current().bootstrapControls();
    }

    private void requireEnabled() {
        if (!controls().bootstrapManifestEnabled()) {
            throw new ApiException("BOOTSTRAP_MANIFEST_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
                "Snapshot-first bootstrap is not enabled.", true, false, Map.of());
        }
    }

    private void expire(UUID accountId, UUID bootstrapId) {
        jdbc.update("""
            UPDATE sync_bootstraps SET bootstrap_status = 'EXPIRED'
            WHERE account_id = ? AND bootstrap_id = ? AND completed_at IS NULL
              AND bootstrap_status NOT IN ('EXPIRED', 'FAILED') AND expires_at <= ?
            """, accountId, bootstrapId, OffsetDateTime.now(clock));
    }

    private void markExpired(UUID accountId, UUID bootstrapId) {
        jdbc.update("""
            UPDATE sync_bootstraps SET bootstrap_status = 'EXPIRED'
            WHERE account_id = ? AND bootstrap_id = ? AND completed_at IS NULL
            """, accountId, bootstrapId);
    }

    private void lockAccount(UUID accountId) {
        jdbc.queryForObject("SELECT account_id FROM sync_accounts WHERE account_id = ? FOR UPDATE",
            UUID.class, accountId);
    }

    private List<Integer> integerList(Array values) throws java.sql.SQLException {
        var result = new ArrayList<Integer>();
        for (var value : (Integer[]) values.getArray()) result.add(value);
        return List.copyOf(result);
    }

    private void verifySignature(byte[] publicKey, String message, String encodedSignature) {
        try {
            var key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(publicKey));
            var verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(key);
            verifier.update(message.getBytes(StandardCharsets.UTF_8));
            if (!verifier.verify(Base64.getDecoder().decode(encodedSignature))) throw new IllegalArgumentException();
        } catch (Exception error) {
            throw conflict("INVALID_BOOTSTRAP_PROOF", "The bootstrap possession proof is invalid.");
        }
    }

    private String completionMessage(BootstrapRow row) {
        return "bootstrap-complete:" + row.bootstrapId() + ":" + row.headSequence();
    }

    private ApiException snapshotRequired(String message, AccountState state, SnapshotRow snapshot) {
        var details = new java.util.HashMap<String, Object>();
        details.put("headSequence", state.headSequence());
        details.put("minimumAvailableSequence", state.minimumAvailableSequence());
        if (snapshot != null) {
            details.put("snapshotId", snapshot.snapshotId());
            details.put("snapshotSequence", snapshot.sequence());
        }
        return new ApiException("SNAPSHOT_REQUIRED", HttpStatus.CONFLICT, message, true, false, details);
    }

    private ApiException forbidden() {
        return new ApiException("BOOTSTRAP_FORBIDDEN", HttpStatus.FORBIDDEN,
            "The device is not authorized for this bootstrap.", false, true, Map.of());
    }

    private ApiException conflict(String code, String message) {
        return new ApiException(code, HttpStatus.CONFLICT, message);
    }

    private record AccountState(long headSequence, long minimumAvailableSequence) {}
    private record SnapshotRow(UUID snapshotId, long sequence, int keyEpoch, OffsetDateTime createdAt) {}
    private record BootstrapRow(
        UUID bootstrapId, UUID deviceId, UUID pairingId, String status,
        UUID snapshotId, long snapshotSequence, long headSequence,
        List<Integer> requiredKeyEpochs, OffsetDateTime expiresAt, OffsetDateTime completedAt,
        String partitionKey, String objectKey, String sha256, long sizeBytes,
        int keyEpoch, int snapshotSchemaVersion, String metadataSignature,
        long minimumAvailableSequence
    ) {}
}
