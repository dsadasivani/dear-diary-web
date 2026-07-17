package com.deardiary.sync.snapshot;

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
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class SnapshotService {
    public static final String ACCOUNT_PARTITION = "account";

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final DeviceAuthorizationService devices;
    private final AccountAuthorizationService accounts;
    private final ProtocolService protocols;
    private final ObjectKeyFactory objectKeys;
    private final EncryptedObjectStore objectStore;
    private final Clock clock;

    public SnapshotService(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            DeviceAuthorizationService devices,
            AccountAuthorizationService accounts,
            ProtocolService protocols,
            ObjectKeyFactory objectKeys,
            EncryptedObjectStore objectStore,
            Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.devices = devices;
        this.accounts = accounts;
        this.protocols = protocols;
        this.objectKeys = objectKeys;
        this.objectStore = objectStore;
        this.clock = clock;
    }

    public InitiateSnapshotResponse initiate(String ownerSubject, InitiateSnapshotRequest request) {
        var device = devices.requireActiveDevice(ownerSubject, request.deviceId());
        validateCreation(device.currentSequence(), device.keyEpoch(), request);
        var persisted = transactions.execute(status -> persistInitiation(device.accountId(), request));
        try {
            var upload = objectStore.initiateUpload(new UploadObjectCommand(
                new ObjectKey(persisted.objectKey()), "SNAPSHOT", request.sha256(), request.sizeBytes()));
            return new InitiateSnapshotResponse(request.snapshotId(), persisted.status(), persisted.existing(),
                new InitiateSnapshotResponse.Upload(
                    persisted.objectKey(), upload.url().toString(), upload.headers(), upload.expiresAt()));
        } catch (ObjectStoreException error) {
            throw objectStoreUnavailable(error);
        }
    }

    public SnapshotResponse register(String ownerSubject, UUID snapshotId, UUID deviceId) {
        var device = devices.requireActiveDevice(ownerSubject, deviceId);
        requireCreationEnabled();
        var snapshot = load(device.accountId(), snapshotId, false);
        if (!deviceId.equals(snapshot.deviceId())) {
            throw new ApiException("SNAPSHOT_DEVICE_MISMATCH", HttpStatus.FORBIDDEN,
                "The snapshot belongs to another device.", false, true, Map.of());
        }
        verifyUploadedObject(snapshot);
        var available = transactions.execute(status -> activate(device.accountId(), snapshotId, deviceId));
        return response(available, null, null);
    }

    public SnapshotResponse latest(
            String ownerSubject, String partitionKey, int snapshotSchemaVersion) {
        var account = accounts.requireActiveAccount(ownerSubject);
        if (!ACCOUNT_PARTITION.equals(partitionKey)) {
            throw new ApiException("SNAPSHOT_PARTITION_UNSUPPORTED", HttpStatus.BAD_REQUEST,
                "This protocol version supports account snapshots only.");
        }
        var rows = jdbc.query("""
            SELECT snapshot_id, sequence, partition_key, object_key, sha256, size_bytes,
                   key_epoch, snapshot_schema_version, snapshot_status, created_by_device_id
            FROM sync_snapshots
            WHERE account_id = ? AND partition_key = ? AND snapshot_schema_version = ?
              AND snapshot_status = 'AVAILABLE'
            ORDER BY sequence DESC, created_at DESC LIMIT 1
            """, (rs, row) -> mapSnapshot(rs), account.accountId(), partitionKey, snapshotSchemaVersion);
        if (rows.isEmpty()) {
            throw new ApiException("SNAPSHOT_NOT_FOUND", HttpStatus.NOT_FOUND,
                "No compatible encrypted snapshot is available.");
        }
        try {
            var download = objectStore.createDownload(new ObjectKey(rows.getFirst().objectKey()));
            return response(rows.getFirst(), download.url().toString(), download.expiresAt());
        } catch (ObjectStoreException error) {
            throw objectStoreUnavailable(error);
        }
    }

    private void validateCreation(long currentSequence, int currentKeyEpoch, InitiateSnapshotRequest request) {
        var protocol = requireCreationEnabled();
        if (!ACCOUNT_PARTITION.equals(request.partitionKey())) {
            throw new ApiException("SNAPSHOT_PARTITION_UNSUPPORTED", HttpStatus.BAD_REQUEST,
                "This protocol version supports account snapshots only.");
        }
        if (request.throughSequence() != currentSequence) {
            throw new ApiException("SNAPSHOT_SEQUENCE_STALE", HttpStatus.CONFLICT,
                "The snapshot must cover the current account sequence.", true, false,
                Map.of("currentSequence", currentSequence));
        }
        if (request.keyEpoch() != currentKeyEpoch) {
            throw new ApiException("KEY_EPOCH_MISMATCH", HttpStatus.CONFLICT,
                "The snapshot uses an unavailable key epoch.", false, true, Map.of());
        }
        if (request.protocolVersion() < protocol.minimumWriteProtocolVersion()
                || request.protocolVersion() > protocol.currentProtocolVersion()
                || request.snapshotSchemaVersion() != protocol.snapshotSchemaVersion()) {
            throw new ApiException("PROTOCOL_INCOMPATIBLE", HttpStatus.CONFLICT,
                "The client snapshot protocol is incompatible.", false, true, Map.of());
        }
        if (request.sizeBytes() > protocol.maximumSnapshotBytes()) {
            throw new ApiException("OBJECT_TOO_LARGE", HttpStatus.PAYLOAD_TOO_LARGE,
                "The encrypted snapshot exceeds the configured size limit.");
        }
    }

    private com.deardiary.sync.protocol.ProtocolResponse requireCreationEnabled() {
        var protocol = protocols.current();
        if (!protocol.featureFlags().syncWritesEnabled() || !protocol.featureFlags().snapshotCreationEnabled()) {
            throw new ApiException("SNAPSHOT_CREATION_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
                "Snapshot creation is temporarily disabled.", true, false, Map.of());
        }
        return protocol;
    }

    private PersistedSnapshot persistInitiation(UUID accountId, InitiateSnapshotRequest request) {
        jdbc.queryForObject("SELECT account_id FROM sync_accounts WHERE account_id = ? FOR UPDATE", UUID.class, accountId);
        var existing = loadOptional(accountId, request.snapshotId(), true);
        if (existing != null) {
            if (!matches(existing, request)) {
                throw new ApiException("IDEMPOTENCY_MISMATCH", HttpStatus.CONFLICT,
                    "The snapshot identifier is associated with different metadata.");
            }
            return new PersistedSnapshot(existing.objectKey(), existing.status(), true);
        }
        var objectKey = objectKeys.create(accountId).value();
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            INSERT INTO sync_objects (
                account_id, object_key, object_kind, sha256, size_bytes, key_epoch,
                storage_status, created_at, updated_at
            ) VALUES (?, ?, 'SNAPSHOT', ?, ?, ?, 'PENDING_UPLOAD', ?, ?)
            """, accountId, objectKey, request.sha256(), request.sizeBytes(), request.keyEpoch(), now, now);
        jdbc.update("""
            INSERT INTO sync_snapshots (
                account_id, snapshot_id, sequence, partition_key, object_key, sha256,
                size_bytes, key_epoch, snapshot_schema_version, snapshot_status,
                created_by_device_id, protocol_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADING', ?, ?, ?)
            """, accountId, request.snapshotId(), request.throughSequence(), request.partitionKey(),
            objectKey, request.sha256(), request.sizeBytes(), request.keyEpoch(),
            request.snapshotSchemaVersion(), request.deviceId(), request.protocolVersion(), now);
        return new PersistedSnapshot(objectKey, "UPLOADING", false);
    }

    private SnapshotRow activate(UUID accountId, UUID snapshotId, UUID deviceId) {
        jdbc.queryForObject("SELECT account_id FROM sync_accounts WHERE account_id = ? FOR UPDATE", UUID.class, accountId);
        var snapshot = load(accountId, snapshotId, true);
        if (!deviceId.equals(snapshot.deviceId())) {
            throw new ApiException("SNAPSHOT_DEVICE_MISMATCH", HttpStatus.FORBIDDEN,
                "The snapshot belongs to another device.", false, true, Map.of());
        }
        if ("AVAILABLE".equals(snapshot.status())) return snapshot;
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            UPDATE sync_objects SET storage_status = 'COMMITTED',
                created_sequence = ?, updated_at = ?
            WHERE account_id = ? AND object_key = ?
            """, Math.max(1, snapshot.sequence()), now, accountId, snapshot.objectKey());
        jdbc.update("""
            UPDATE sync_snapshots SET snapshot_status = 'AVAILABLE'
            WHERE account_id = ? AND snapshot_id = ? AND snapshot_status = 'UPLOADING'
            """, accountId, snapshotId);
        jdbc.update("""
            INSERT INTO sync_object_references (
                account_id, object_key, owner_record_type, owner_record_id,
                reference_kind, created_sequence, created_at
            ) VALUES (?, ?, 'ACCOUNT', ?, 'SNAPSHOT', ?, ?)
            ON CONFLICT DO NOTHING
            """, accountId, snapshot.objectKey(), accountId.toString(), Math.max(1, snapshot.sequence()), now);
        return new SnapshotRow(snapshot.snapshotId(), snapshot.sequence(), snapshot.partitionKey(),
            snapshot.objectKey(), snapshot.sha256(), snapshot.sizeBytes(), snapshot.keyEpoch(),
            snapshot.schemaVersion(), "AVAILABLE", snapshot.deviceId());
    }

    private void verifyUploadedObject(SnapshotRow snapshot) {
        try {
            var metadata = objectStore.head(new ObjectKey(snapshot.objectKey()));
            if (metadata.sizeBytes() != snapshot.sizeBytes()) {
                throw new ApiException("OBJECT_SIZE_MISMATCH", HttpStatus.CONFLICT,
                    "The encrypted snapshot failed its size check.", false, true, Map.of());
            }
            if (!snapshot.sha256().equals(metadata.sha256())) {
                throw new ApiException("HASH_MISMATCH", HttpStatus.CONFLICT,
                    "The encrypted snapshot failed its integrity check.", false, true, Map.of());
            }
        } catch (ObjectStoreException error) {
            throw objectStoreUnavailable(error);
        }
    }

    private SnapshotRow load(UUID accountId, UUID snapshotId, boolean lock) {
        var snapshot = loadOptional(accountId, snapshotId, lock);
        if (snapshot == null) throw new ApiException("SNAPSHOT_NOT_FOUND", HttpStatus.NOT_FOUND,
            "The encrypted snapshot was not found.");
        return snapshot;
    }

    private SnapshotRow loadOptional(UUID accountId, UUID snapshotId, boolean lock) {
        var rows = jdbc.query("""
            SELECT snapshot_id, sequence, partition_key, object_key, sha256, size_bytes,
                   key_epoch, snapshot_schema_version, snapshot_status, created_by_device_id
            FROM sync_snapshots WHERE account_id = ? AND snapshot_id = ?
            """ + (lock ? " FOR UPDATE" : ""), (rs, row) -> mapSnapshot(rs), accountId, snapshotId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private SnapshotRow mapSnapshot(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new SnapshotRow(rs.getObject(1, UUID.class), rs.getLong(2), rs.getString(3),
            rs.getString(4), rs.getString(5), rs.getLong(6), rs.getInt(7), rs.getInt(8),
            rs.getString(9), rs.getObject(10, UUID.class));
    }

    private boolean matches(SnapshotRow snapshot, InitiateSnapshotRequest request) {
        return request.deviceId().equals(snapshot.deviceId())
            && request.throughSequence() == snapshot.sequence()
            && request.partitionKey().equals(snapshot.partitionKey())
            && request.sha256().equals(snapshot.sha256())
            && request.sizeBytes() == snapshot.sizeBytes()
            && request.keyEpoch() == snapshot.keyEpoch()
            && request.snapshotSchemaVersion() == snapshot.schemaVersion();
    }

    private SnapshotResponse response(SnapshotRow row, String downloadUrl, java.time.Instant expiresAt) {
        return new SnapshotResponse(row.snapshotId(), row.status(), row.sequence(), row.partitionKey(),
            row.objectKey(), row.sha256(), row.sizeBytes(), row.keyEpoch(), row.schemaVersion(),
            downloadUrl, expiresAt);
    }

    private ApiException objectStoreUnavailable(ObjectStoreException error) {
        var status = error.retryable() ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.CONFLICT;
        return new ApiException(error.code(), status, "Encrypted snapshot storage is unavailable.",
            error.retryable(), false, Map.of());
    }

    private record PersistedSnapshot(String objectKey, String status, boolean existing) {}
    private record SnapshotRow(
        UUID snapshotId, long sequence, String partitionKey, String objectKey, String sha256,
        long sizeBytes, int keyEpoch, int schemaVersion, String status, UUID deviceId
    ) {}
}
