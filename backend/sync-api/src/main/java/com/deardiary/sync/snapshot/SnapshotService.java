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
import com.deardiary.sync.quota.QuotaService;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
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
    private final QuotaService quotas;

    public SnapshotService(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            DeviceAuthorizationService devices,
            AccountAuthorizationService accounts,
            ProtocolService protocols,
            ObjectKeyFactory objectKeys,
            EncryptedObjectStore objectStore,
            Clock clock,
            QuotaService quotas) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.devices = devices;
        this.accounts = accounts;
        this.protocols = protocols;
        this.objectKeys = objectKeys;
        this.objectStore = objectStore;
        this.clock = clock;
        this.quotas = quotas;
    }

    public InitiateSnapshotResponse initiate(String ownerSubject, InitiateSnapshotRequest request) {
        var device = devices.requireActiveDevice(ownerSubject, request.deviceId());
        validateCreation(device.accountId(), device.keyEpoch(), request);
        var persisted = transactions.execute(status -> persistInitiation(device.accountId(), request));
        try {
            var objects = chunkRows(device.accountId(), request.snapshotId());
            if (objects.isEmpty()) {
                objects = List.of(new ChunkRow(0, persisted.objectKey(), request.sha256(),
                    request.sizeBytes(), request.keyEpoch()));
            }
            var uploads = new ArrayList<InitiateSnapshotResponse.Upload>();
            for (var object : objects) {
                var uploaded = uploadedObjectMatches(object);
                var upload = objectStore.initiateUpload(new UploadObjectCommand(
                    new ObjectKey(object.objectKey()), "SNAPSHOT", object.sha256(), object.sizeBytes()));
                uploads.add(new InitiateSnapshotResponse.Upload(
                    object.objectKey(), upload.url().toString(), upload.headers(), upload.expiresAt(), uploaded));
            }
            return new InitiateSnapshotResponse(request.snapshotId(), persisted.status(), persisted.existing(),
                uploads.getFirst(), List.copyOf(uploads));
        } catch (ObjectStoreException error) {
            throw objectStoreUnavailable(error);
        }
    }

    private boolean uploadedObjectMatches(ChunkRow object) {
        try {
            var metadata = objectStore.head(new ObjectKey(object.objectKey()));
            return metadata.sizeBytes() == object.sizeBytes()
                && object.sha256().equalsIgnoreCase(metadata.sha256());
        } catch (ObjectStoreException error) {
            if ("OBJECT_MISSING".equals(error.code())) {
                return false;
            }
            throw error;
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
        verifyUploadedObjects(device.accountId(), snapshot);
        var available = transactions.execute(status -> activate(device.accountId(), snapshotId, deviceId));
        return response(device.accountId(), available, false);
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
        return response(account.accountId(), rows.getFirst(), true);
    }

    private void validateCreation(UUID accountId, int currentKeyEpoch, InitiateSnapshotRequest request) {
        var protocol = requireCreationEnabled();
        if (!ACCOUNT_PARTITION.equals(request.partitionKey())) {
            throw new ApiException("SNAPSHOT_PARTITION_UNSUPPORTED", HttpStatus.BAD_REQUEST,
                "This protocol version supports account snapshots only.");
        }
        var acknowledgedSequence = jdbc.queryForObject("""
            SELECT last_applied_sequence FROM sync_device_cursors
            WHERE account_id = ? AND device_id = ?
            """, Long.class, accountId, request.deviceId());
        if (request.throughSequence() != acknowledgedSequence) {
            throw new ApiException("SNAPSHOT_SEQUENCE_STALE", HttpStatus.CONFLICT,
                "The snapshot must cover the creating device's acknowledged cursor.", true, false,
                Map.of("acknowledgedSequence", acknowledgedSequence));
        }
        var latestSequence = jdbc.queryForObject("""
            SELECT COALESCE(MAX(sequence), 0) FROM sync_snapshots
            WHERE account_id = ? AND partition_key = ? AND snapshot_status = 'AVAILABLE'
            """, Long.class, accountId, request.partitionKey());
        if (request.throughSequence() < latestSequence) {
            throw new ApiException("SNAPSHOT_SEQUENCE_REGRESSION", HttpStatus.CONFLICT,
                "A snapshot cannot regress the latest verified snapshot.", false, true,
                Map.of("latestSnapshotSequence", latestSequence));
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
        var chunks = request.chunks() == null ? List.<InitiateSnapshotRequest.Chunk>of() : request.chunks();
        if (!chunks.isEmpty()) {
            long totalSize = 0;
            for (var index = 0; index < chunks.size(); index++) {
                var chunk = chunks.get(index);
                if (chunk.index() != index || chunk.sizeBytes() > protocol.maximumSnapshotBytes()) {
                    throw new ApiException("INVALID_SNAPSHOT_CHUNKS", HttpStatus.BAD_REQUEST,
                        "Snapshot chunks must be ordered, contiguous, and within the size limit.");
                }
                totalSize = Math.addExact(totalSize, chunk.sizeBytes());
            }
            if (totalSize != request.sizeBytes() || !chunkDigest(chunks).equals(request.sha256())) {
                throw new ApiException("INVALID_SNAPSHOT_CHUNKS", HttpStatus.BAD_REQUEST,
                    "Snapshot chunk metadata does not match the signed snapshot aggregate.");
            }
        }
        if (request.protocolVersion() >= 4) verifyMetadataSignature(accountId, request);
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
            if (!matches(accountId, existing, request)) {
                throw new ApiException("IDEMPOTENCY_MISMATCH", HttpStatus.CONFLICT,
                    "The snapshot identifier is associated with different metadata.");
            }
            return new PersistedSnapshot(existing.objectKey(), existing.status(), true);
        }
        var sequenceOccupied = Boolean.TRUE.equals(jdbc.queryForObject("""
            SELECT EXISTS (
                SELECT 1 FROM sync_snapshots
                WHERE account_id = ? AND partition_key = ? AND sequence = ?
            )
            """, Boolean.class, accountId, request.partitionKey(), request.throughSequence()));
        if (sequenceOccupied) {
            throw new ApiException("SNAPSHOT_SEQUENCE_EXISTS", HttpStatus.CONFLICT,
                "A restore point already exists for this account sequence.", false, false, Map.of());
        }
        quotas.requireStorageCapacity(accountId, request.sizeBytes(), false);
        var chunks = request.chunks() == null ? List.<InitiateSnapshotRequest.Chunk>of() : request.chunks();
        var objectKey = objectKeys.create(accountId).value();
        var now = OffsetDateTime.now(clock);
        var persistedChunks = new ArrayList<ChunkRow>();
        if (chunks.isEmpty()) {
            jdbc.update("""
                INSERT INTO sync_objects (
                    account_id, object_key, object_kind, sha256, size_bytes, key_epoch,
                    storage_status, created_at, updated_at
                ) VALUES (?, ?, 'SNAPSHOT', ?, ?, ?, 'PENDING_UPLOAD', ?, ?)
                """, accountId, objectKey, request.sha256(), request.sizeBytes(), request.keyEpoch(), now, now);
        } else {
            for (var index = 0; index < chunks.size(); index++) {
                var chunk = chunks.get(index);
                var chunkObjectKey = index == 0 ? objectKey : objectKeys.create(accountId).value();
                jdbc.update("""
                    INSERT INTO sync_objects (
                        account_id, object_key, object_kind, sha256, size_bytes, key_epoch,
                        storage_status, created_at, updated_at
                    ) VALUES (?, ?, 'SNAPSHOT', ?, ?, ?, 'PENDING_UPLOAD', ?, ?)
                    """, accountId, chunkObjectKey, chunk.sha256(), chunk.sizeBytes(),
                    request.keyEpoch(), now, now);
                persistedChunks.add(new ChunkRow(index, chunkObjectKey, chunk.sha256(),
                    chunk.sizeBytes(), request.keyEpoch()));
            }
        }
        jdbc.update("""
            INSERT INTO sync_snapshots (
                account_id, snapshot_id, sequence, partition_key, object_key, sha256,
                size_bytes, key_epoch, snapshot_schema_version, snapshot_status,
                created_by_device_id, protocol_version, metadata_signature, verified, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPLOADING', ?, ?, ?, FALSE, ?)
            """, accountId, request.snapshotId(), request.throughSequence(), request.partitionKey(),
            objectKey, request.sha256(), request.sizeBytes(), request.keyEpoch(),
            request.snapshotSchemaVersion(), request.deviceId(), request.protocolVersion(),
            request.metadataSignature(), now);
        for (var chunk : persistedChunks) {
            jdbc.update("""
                INSERT INTO sync_snapshot_chunks (
                    account_id, snapshot_id, chunk_index, object_key, sha256,
                    size_bytes, key_epoch, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, accountId, request.snapshotId(), chunk.index(), chunk.objectKey(),
                chunk.sha256(), chunk.sizeBytes(), chunk.keyEpoch(), now);
        }
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
        var objects = chunkRows(accountId, snapshotId);
        if (objects.isEmpty()) {
            objects = List.of(new ChunkRow(0, snapshot.objectKey(), snapshot.sha256(),
                snapshot.sizeBytes(), snapshot.keyEpoch()));
        }
        for (var object : objects) {
            jdbc.update("""
                UPDATE sync_objects SET storage_status = 'COMMITTED',
                    created_sequence = ?, updated_at = ?
                WHERE account_id = ? AND object_key = ?
                """, Math.max(1, snapshot.sequence()), now, accountId, object.objectKey());
        }
        jdbc.update("""
            UPDATE sync_snapshots SET snapshot_status = 'AVAILABLE', verified = TRUE
            WHERE account_id = ? AND snapshot_id = ? AND snapshot_status = 'UPLOADING'
            """, accountId, snapshotId);
        for (var object : objects) {
            jdbc.update("""
                INSERT INTO sync_object_references (
                    account_id, object_key, owner_record_type, owner_record_id,
                    reference_kind, created_sequence, created_at
                ) VALUES (?, ?, 'ACCOUNT', ?, 'SNAPSHOT', ?, ?)
                ON CONFLICT DO NOTHING
                """, accountId, object.objectKey(), accountId.toString(),
                Math.max(1, snapshot.sequence()), now);
        }
        return new SnapshotRow(snapshot.snapshotId(), snapshot.sequence(), snapshot.partitionKey(),
            snapshot.objectKey(), snapshot.sha256(), snapshot.sizeBytes(), snapshot.keyEpoch(),
            snapshot.schemaVersion(), "AVAILABLE", snapshot.deviceId());
    }

    private void verifyUploadedObjects(UUID accountId, SnapshotRow snapshot) {
        var objects = chunkRows(accountId, snapshot.snapshotId());
        if (objects.isEmpty()) {
            objects = List.of(new ChunkRow(0, snapshot.objectKey(), snapshot.sha256(),
                snapshot.sizeBytes(), snapshot.keyEpoch()));
        }
        for (var object : objects) {
            try {
                var metadata = objectStore.head(new ObjectKey(object.objectKey()));
                if (metadata.sizeBytes() != object.sizeBytes()) {
                    throw new ApiException("OBJECT_SIZE_MISMATCH", HttpStatus.CONFLICT,
                        "An encrypted snapshot chunk failed its size check.", false, true, Map.of());
                }
                if (!object.sha256().equals(metadata.sha256())) {
                    throw new ApiException("HASH_MISMATCH", HttpStatus.CONFLICT,
                        "An encrypted snapshot chunk failed its integrity check.", false, true, Map.of());
                }
            } catch (ObjectStoreException error) {
                throw objectStoreUnavailable(error);
            }
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

    private boolean matches(UUID accountId, SnapshotRow snapshot, InitiateSnapshotRequest request) {
        var metadataMatches = request.deviceId().equals(snapshot.deviceId())
            && request.throughSequence() == snapshot.sequence()
            && request.partitionKey().equals(snapshot.partitionKey())
            && request.sha256().equals(snapshot.sha256())
            && request.sizeBytes() == snapshot.sizeBytes()
            && request.keyEpoch() == snapshot.keyEpoch()
            && request.snapshotSchemaVersion() == snapshot.schemaVersion();
        if (!metadataMatches) return false;
        var requested = request.chunks() == null ? List.<InitiateSnapshotRequest.Chunk>of() : request.chunks();
        var persisted = chunkRows(accountId, snapshot.snapshotId());
        if (requested.isEmpty()) return persisted.isEmpty();
        if (requested.size() != persisted.size()) return false;
        for (var index = 0; index < requested.size(); index++) {
            var left = requested.get(index);
            var right = persisted.get(index);
            if (left.index() != right.index() || !left.sha256().equals(right.sha256())
                    || left.sizeBytes() != right.sizeBytes()) return false;
        }
        return true;
    }

    private void verifyMetadataSignature(UUID accountId, InitiateSnapshotRequest request) {
        if (request.metadataSignature() == null || request.metadataSignature().isBlank()) {
            throw new ApiException("SNAPSHOT_SIGNATURE_REQUIRED", HttpStatus.CONFLICT,
                "Protocol 4 snapshots require signed metadata.", false, true, Map.of());
        }
        try {
            var publicKey = jdbc.queryForObject("""
                SELECT device_public_key FROM sync_devices
                WHERE account_id = ? AND device_id = ?
                """, byte[].class, accountId, request.deviceId());
            var key = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(publicKey));
            var verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(key);
            verifier.update(metadataMessage(request).getBytes(StandardCharsets.UTF_8));
            if (!verifier.verify(Base64.getDecoder().decode(request.metadataSignature()))) {
                throw new IllegalArgumentException("invalid signature");
            }
        } catch (Exception error) {
            throw new ApiException("INVALID_SNAPSHOT_SIGNATURE", HttpStatus.CONFLICT,
                "The snapshot metadata signature is invalid.", false, true, Map.of());
        }
    }

    private String metadataMessage(InitiateSnapshotRequest request) {
        return "snapshot-metadata:" + request.snapshotId() + ":" + request.deviceId() + ":"
            + request.throughSequence() + ":" + request.partitionKey() + ":" + request.sha256() + ":"
            + request.sizeBytes() + ":" + request.keyEpoch() + ":" + request.snapshotSchemaVersion();
    }

    private SnapshotResponse response(UUID accountId, SnapshotRow row, boolean includeDownloads) {
        try {
            var persisted = chunkRows(accountId, row.snapshotId());
            if (persisted.isEmpty()) {
                if (!includeDownloads) {
                    return new SnapshotResponse(row.snapshotId(), row.status(), row.sequence(),
                        row.partitionKey(), row.objectKey(), row.sha256(), row.sizeBytes(),
                        row.keyEpoch(), row.schemaVersion(), null, null, List.of());
                }
                var download = objectStore.createDownload(new ObjectKey(row.objectKey()));
                return new SnapshotResponse(row.snapshotId(), row.status(), row.sequence(), row.partitionKey(),
                    row.objectKey(), row.sha256(), row.sizeBytes(), row.keyEpoch(), row.schemaVersion(),
                    download.url().toString(), download.expiresAt(), List.of());
            }
            var chunks = new ArrayList<SnapshotResponse.Chunk>();
            for (var chunk : persisted) {
                var download = includeDownloads
                    ? objectStore.createDownload(new ObjectKey(chunk.objectKey())) : null;
                chunks.add(new SnapshotResponse.Chunk(chunk.index(), chunk.objectKey(), chunk.sha256(),
                    chunk.sizeBytes(), chunk.keyEpoch(),
                    download == null ? null : download.url().toString(),
                    download == null ? null : download.expiresAt()));
            }
            var first = chunks.getFirst();
            return new SnapshotResponse(row.snapshotId(), row.status(), row.sequence(), row.partitionKey(),
                row.objectKey(), row.sha256(), row.sizeBytes(), row.keyEpoch(), row.schemaVersion(),
                first.downloadUrl(), first.downloadExpiresAt(), List.copyOf(chunks));
        } catch (ObjectStoreException error) {
            throw objectStoreUnavailable(error);
        }
    }

    private List<ChunkRow> chunkRows(UUID accountId, UUID snapshotId) {
        return jdbc.query("""
            SELECT chunk_index, object_key, sha256, size_bytes, key_epoch
            FROM sync_snapshot_chunks
            WHERE account_id = ? AND snapshot_id = ?
            ORDER BY chunk_index
            """, (rs, row) -> new ChunkRow(rs.getInt(1), rs.getString(2), rs.getString(3),
                rs.getLong(4), rs.getInt(5)), accountId, snapshotId);
    }

    private String chunkDigest(List<InitiateSnapshotRequest.Chunk> chunks) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            for (var chunk : chunks) {
                digest.update((chunk.index() + ":" + chunk.sha256() + ":" + chunk.sizeBytes() + "\n")
                    .getBytes(StandardCharsets.UTF_8));
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable.", error);
        }
    }

    private ApiException objectStoreUnavailable(ObjectStoreException error) {
        var status = error.retryable() ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.CONFLICT;
        return new ApiException(error.code(), status, "Encrypted snapshot storage is unavailable.",
            error.retryable(), false, Map.of());
    }

    private record PersistedSnapshot(String objectKey, String status, boolean existing) {}
    private record ChunkRow(int index, String objectKey, String sha256, long sizeBytes, int keyEpoch) {}
    private record SnapshotRow(
        UUID snapshotId, long sequence, String partitionKey, String objectKey, String sha256,
        long sizeBytes, int keyEpoch, int schemaVersion, String status, UUID deviceId
    ) {}
}
