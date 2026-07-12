package com.deardiary.sync.operation;

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
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class OperationInitiationService {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final DeviceAuthorizationService devices;
    private final ProtocolService protocols;
    private final ObjectKeyFactory objectKeys;
    private final EncryptedObjectStore objectStore;
    private final Clock clock;

    public OperationInitiationService(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            DeviceAuthorizationService devices,
            ProtocolService protocols,
            ObjectKeyFactory objectKeys,
            EncryptedObjectStore objectStore,
            Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.devices = devices;
        this.protocols = protocols;
        this.objectKeys = objectKeys;
        this.objectStore = objectStore;
        this.clock = clock;
    }

    public InitiateOperationResponse initiate(String ownerSubject, InitiateOperationRequest request) {
        var device = devices.requireActiveDevice(ownerSubject, request.deviceId());
        validate(device.accountId(), device.keyEpoch(), request);
        var persisted = transactions.execute(status -> persist(device.accountId(), request));
        var uploads = persisted.objects().stream().map(object -> {
            try {
                var instruction = objectStore.initiateUpload(new UploadObjectCommand(
                    new ObjectKey(object.objectKey()), object.objectKind(), object.sha256(), object.sizeBytes()));
                return new InitiateOperationResponse.Upload(
                    object.objectKey(), instruction.url(), instruction.headers(), instruction.expiresAt());
            } catch (ObjectStoreException error) {
                throw new ApiException(error.code(), HttpStatus.SERVICE_UNAVAILABLE,
                    "Encrypted object storage is unavailable.", error.retryable(), false, Map.of());
            }
        }).toList();
        return new InitiateOperationResponse(request.operationId(), persisted.status(), persisted.existing(), uploads);
    }

    private void validate(UUID accountId, int currentKeyEpoch, InitiateOperationRequest request) {
        var protocol = protocols.current();
        if (!protocol.featureFlags().syncWritesEnabled()) {
            throw new ApiException("SYNC_WRITES_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
                "Cloud synchronization writes are temporarily disabled.", true, false, Map.of());
        }
        if (request.protocolVersion() < protocol.minimumWriteProtocolVersion()
                || request.protocolVersion() > protocol.currentProtocolVersion()
                || request.eventSchemaVersion() != protocol.eventSchemaVersion()) {
            throw new ApiException("PROTOCOL_INCOMPATIBLE", HttpStatus.CONFLICT,
                "The client synchronization protocol is incompatible.", false, true, Map.of());
        }
        if (request.keyEpoch() != currentKeyEpoch) {
            throw new ApiException("KEY_EPOCH_MISMATCH", HttpStatus.CONFLICT,
                "The operation uses an unavailable key epoch.", false, true, Map.of());
        }
        if (request.objects().stream().filter(object -> "EVENT".equals(object.objectKind())).count() != 1) {
            throw new ApiException("INVALID_OPERATION_OBJECTS", HttpStatus.BAD_REQUEST,
                "Exactly one encrypted event object is required.");
        }
        for (var object : request.objects()) {
            final ObjectKey key;
            try {
                key = new ObjectKey(object.objectKey());
            } catch (IllegalArgumentException error) {
                throw new ApiException("INVALID_OBJECT_KEY", HttpStatus.BAD_REQUEST, "The encrypted object key is invalid.");
            }
            if (!objectKeys.belongsTo(accountId, key)) {
                throw new ApiException("INVALID_OBJECT_KEY", HttpStatus.BAD_REQUEST, "The encrypted object key is invalid.");
            }
            var maximum = "EVENT".equals(object.objectKind())
                ? protocol.maximumEventBytes() : protocol.maximumMediaBytes();
            if (object.sizeBytes() > maximum) {
                throw new ApiException("OBJECT_TOO_LARGE", HttpStatus.PAYLOAD_TOO_LARGE,
                    "The encrypted object exceeds the configured size limit.");
            }
        }
    }

    private PersistedOperation persist(UUID accountId, InitiateOperationRequest request) {
        var existing = loadExisting(accountId, request.operationId());
        if (existing != null) {
            assertMatches(accountId, existing, request);
            return new PersistedOperation(existing.status(), true, loadObjects(accountId, request.operationId()));
        }
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            INSERT INTO sync_operations (
                account_id, operation_id, device_id, record_type, record_id, operation_type,
                base_record_version, operation_status, protocol_version, event_schema_version,
                key_epoch, partition_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OBJECTS_PENDING', ?, ?, ?, ?, ?, ?)
            """, accountId, request.operationId(), request.deviceId(), request.recordType(), request.recordId(),
            request.operationType(), request.baseRecordVersion(), request.protocolVersion(),
            request.eventSchemaVersion(), request.keyEpoch(), request.partitionKey(), now, now);
        for (var object : request.objects()) {
            jdbc.update("""
                INSERT INTO sync_objects (
                    account_id, object_key, object_kind, sha256, size_bytes, key_epoch,
                    storage_status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING_UPLOAD', ?, ?)
                """, accountId, object.objectKey(), object.objectKind(), object.sha256(), object.sizeBytes(),
                request.keyEpoch(), now, now);
            jdbc.update("""
                INSERT INTO sync_operation_objects (
                    account_id, operation_id, object_key, object_kind, sha256, size_bytes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """, accountId, request.operationId(), object.objectKey(), object.objectKind(),
                object.sha256(), object.sizeBytes(), now);
        }
        return new PersistedOperation("OBJECTS_PENDING", false, sorted(request.objects()));
    }

    private ExistingOperation loadExisting(UUID accountId, UUID operationId) {
        var rows = jdbc.query("""
            SELECT device_id, record_type, record_id, operation_type, base_record_version,
                   protocol_version, event_schema_version, key_epoch, partition_key, operation_status
            FROM sync_operations WHERE account_id = ? AND operation_id = ? FOR UPDATE
            """, (rs, row) -> new ExistingOperation(
                rs.getObject(1, UUID.class), rs.getString(2), rs.getObject(3, UUID.class),
                rs.getString(4), rs.getLong(5), rs.getInt(6), rs.getInt(7), rs.getInt(8),
                rs.getString(9), rs.getString(10)), accountId, operationId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private void assertMatches(UUID accountId, ExistingOperation existing, InitiateOperationRequest request) {
        var metadataMatches = existing.deviceId().equals(request.deviceId())
            && existing.recordType().equals(request.recordType())
            && existing.recordId().equals(request.recordId())
            && existing.operationType().equals(request.operationType())
            && existing.baseRecordVersion() == request.baseRecordVersion()
            && existing.protocolVersion() == request.protocolVersion()
            && existing.eventSchemaVersion() == request.eventSchemaVersion()
            && existing.keyEpoch() == request.keyEpoch()
            && existing.partitionKey().equals(request.partitionKey());
        var objectsMatch = loadObjects(accountId, request.operationId())
            .equals(sorted(request.objects()));
        if (!metadataMatches || !objectsMatch) {
            throw new ApiException("IDEMPOTENCY_MISMATCH", HttpStatus.CONFLICT,
                "The operation identifier is already associated with different metadata.");
        }
    }

    private List<OperationObjectRequest> loadObjects(UUID accountId, UUID operationId) {
        return jdbc.query("""
            SELECT object_key, object_kind, sha256, size_bytes
            FROM sync_operation_objects WHERE account_id = ? AND operation_id = ?
            ORDER BY object_key
            """, (rs, row) -> new OperationObjectRequest(
                rs.getString(1), rs.getString(2), rs.getString(3), rs.getLong(4)), accountId, operationId);
    }

    private List<OperationObjectRequest> sorted(List<OperationObjectRequest> objects) {
        return objects.stream().sorted(Comparator.comparing(OperationObjectRequest::objectKey)).toList();
    }

    private record ExistingOperation(
        UUID deviceId, String recordType, UUID recordId, String operationType,
        long baseRecordVersion, int protocolVersion, int eventSchemaVersion,
        int keyEpoch, String partitionKey, String status
    ) {}

    private record PersistedOperation(String status, boolean existing, List<OperationObjectRequest> objects) {}
}
