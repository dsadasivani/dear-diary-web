package com.deardiary.sync.operation;

import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.objectstore.EncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectStoreException;
import com.deardiary.sync.protocol.ProtocolService;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.dao.TransientDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class OperationCommitService {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ProtocolService protocols;
    private final EncryptedObjectStore objectStore;
    private final Clock clock;

    public OperationCommitService(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            ProtocolService protocols,
            EncryptedObjectStore objectStore,
            Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.protocols = protocols;
        this.objectStore = objectStore;
        this.clock = clock;
    }

    public CommitOperationResponse commit(String ownerSubject, UUID operationId) {
        try {
            var outcome = transactions.execute(status -> commitInTransaction(ownerSubject, operationId));
            if (outcome.error() != null) throw outcome.error();
            return outcome.response();
        } catch (TransientDataAccessException error) {
            throw new ApiException("DATABASE_TEMPORARY_FAILURE", HttpStatus.SERVICE_UNAVAILABLE,
                "The operation can be retried safely.", true, false, Map.of());
        }
    }

    private CommitOutcome commitInTransaction(String ownerSubject, UUID operationId) {
        var account = lockAccount(ownerSubject);
        var operation = lockOperation(account.accountId(), operationId);
        if ("COMMITTED".equals(operation.status())) {
            return CommitOutcome.success(new CommitOperationResponse(
                "COMMITTED", operationId, operation.committedSequence(), operation.committedRecordVersion()));
        }
        var currentVersion = lockCurrentVersion(account.accountId(), operation.recordType(), operation.recordId());
        if ("CONFLICT".equals(operation.status()) || currentVersion != operation.baseRecordVersion()) {
            jdbc.update("""
                UPDATE sync_operations SET operation_status = 'CONFLICT',
                    last_error_code = 'RECORD_VERSION_CONFLICT', updated_at = ?
                WHERE account_id = ? AND operation_id = ?
                """, OffsetDateTime.now(clock), account.accountId(), operationId);
            return CommitOutcome.failure(conflict(currentVersion, operation.baseRecordVersion()));
        }
        validateAccountAndProtocol(account, operation);
        requireActiveOperationDevice(account.accountId(), operation.deviceId());
        var objects = loadObjects(account.accountId(), operationId);
        verifyObjects(objects);

        var nextSequence = account.currentSequence() + 1;
        var nextRecordVersion = currentVersion + 1;
        var eventObject = objects.stream().filter(object -> "EVENT".equals(object.kind())).findFirst()
            .orElseThrow(() -> new ApiException("INVALID_OPERATION_OBJECTS", HttpStatus.CONFLICT,
                "The operation has no encrypted event object."));
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            INSERT INTO sync_events (
                account_id, sequence, event_id, operation_id, device_id, record_type,
                record_id, operation_type, record_version, key_epoch, partition_key,
                object_key, sha256, size_bytes, event_schema_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, account.accountId(), nextSequence, operationId, operationId, operation.deviceId(),
            operation.recordType(), operation.recordId(), operation.operationType(), nextRecordVersion,
            operation.keyEpoch(), operation.partitionKey(), eventObject.objectKey(), eventObject.sha256(),
            eventObject.sizeBytes(), operation.eventSchemaVersion(), now);
        jdbc.update("""
            INSERT INTO sync_record_versions (
                account_id, record_type, record_id, current_version, last_sequence, deleted, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (account_id, record_type, record_id) DO UPDATE SET
                current_version = EXCLUDED.current_version,
                last_sequence = EXCLUDED.last_sequence,
                deleted = EXCLUDED.deleted,
                updated_at = EXCLUDED.updated_at
            """, account.accountId(), operation.recordType(), operation.recordId(), nextRecordVersion,
            nextSequence, "DELETE".equals(operation.operationType()), now);
        jdbc.update("""
            UPDATE sync_object_references SET deleted_sequence = ?
            WHERE account_id = ? AND owner_record_type = ? AND owner_record_id = ?
              AND deleted_sequence IS NULL AND reference_kind IN ('MEDIA', 'THUMBNAIL')
            """, nextSequence, account.accountId(), operation.recordType(), operation.recordId());
        for (var object : objects) {
            jdbc.update("""
                UPDATE sync_objects SET storage_status = 'COMMITTED',
                    created_sequence = COALESCE(created_sequence, ?), updated_at = ?
                WHERE account_id = ? AND object_key = ?
                """, nextSequence, now, account.accountId(), object.objectKey());
            if ("DELETE".equals(operation.operationType()) && !"EVENT".equals(object.kind())) continue;
            jdbc.update("""
                INSERT INTO sync_object_references (
                    account_id, object_key, owner_record_type, owner_record_id,
                    reference_kind, created_sequence, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """, account.accountId(), object.objectKey(), operation.recordType(), operation.recordId(),
                referenceKind(object.kind()), nextSequence, now);
        }
        jdbc.update("""
            UPDATE sync_operations SET operation_status = 'COMMITTED', committed_sequence = ?,
                committed_record_version = ?, last_error_code = NULL, updated_at = ?
            WHERE account_id = ? AND operation_id = ?
            """, nextSequence, nextRecordVersion, now, account.accountId(), operationId);
        jdbc.update("UPDATE sync_accounts SET current_sequence = ?, updated_at = ? WHERE account_id = ?",
            nextSequence, now, account.accountId());
        jdbc.update("""
            INSERT INTO sync_notification_outbox (
                notification_id, account_id, sequence, notification_type, status,
                attempt_count, next_attempt_at, created_at
            ) VALUES (?, ?, ?, 'SYNC_WAKE_UP', 'PENDING', 0, ?, ?)
            """, UUID.randomUUID(), account.accountId(), nextSequence, now, now);
        return CommitOutcome.success(new CommitOperationResponse(
            "COMMITTED", operationId, nextSequence, nextRecordVersion));
    }

    private AccountRow lockAccount(String ownerSubject) {
        var rows = jdbc.query("""
            SELECT account_id, current_sequence, current_key_epoch, account_status,
                   minimum_write_protocol
            FROM sync_accounts WHERE owner_subject = ? FOR UPDATE
            """, (rs, row) -> new AccountRow(
                rs.getObject(1, UUID.class), rs.getLong(2), rs.getInt(3), rs.getString(4), rs.getInt(5)),
            ownerSubject);
        if (rows.isEmpty()) throw new ApiException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND,
            "The synchronization account is not registered.");
        return rows.getFirst();
    }

    private OperationRow lockOperation(UUID accountId, UUID operationId) {
        var rows = jdbc.query("""
            SELECT device_id, record_type, record_id, operation_type, base_record_version,
                   operation_status, protocol_version, event_schema_version, key_epoch,
                   partition_key, committed_sequence, committed_record_version
            FROM sync_operations WHERE account_id = ? AND operation_id = ? FOR UPDATE
            """, (rs, row) -> new OperationRow(
                rs.getObject(1, UUID.class), rs.getString(2), rs.getObject(3, UUID.class),
                rs.getString(4), rs.getLong(5), rs.getString(6), rs.getInt(7), rs.getInt(8),
                rs.getInt(9), rs.getString(10), nullableLong(rs, 11), nullableLong(rs, 12)),
            accountId, operationId);
        if (rows.isEmpty()) throw new ApiException("OPERATION_NOT_FOUND", HttpStatus.NOT_FOUND,
            "The synchronization operation was not found.");
        return rows.getFirst();
    }

    private long lockCurrentVersion(UUID accountId, String recordType, UUID recordId) {
        var versions = jdbc.query("""
            SELECT current_version FROM sync_record_versions
            WHERE account_id = ? AND record_type = ? AND record_id = ? FOR UPDATE
            """, (rs, row) -> rs.getLong(1), accountId, recordType, recordId);
        return versions.isEmpty() ? 0 : versions.getFirst();
    }

    private void validateAccountAndProtocol(AccountRow account, OperationRow operation) {
        if (!"ACTIVE".equals(account.status())) {
            throw new ApiException("ACCOUNT_NOT_ACTIVE", HttpStatus.CONFLICT,
                "The synchronization account is not active.", false, true, Map.of());
        }
        var protocol = protocols.current();
        if (!protocol.featureFlags().syncWritesEnabled()) {
            throw new ApiException("SYNC_WRITES_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
                "Cloud synchronization writes are temporarily disabled.", true, false, Map.of());
        }
        if (operation.protocolVersion() < account.minimumWriteProtocol()
                || operation.protocolVersion() > protocol.currentProtocolVersion()
                || operation.eventSchemaVersion() != protocol.eventSchemaVersion()) {
            throw new ApiException("PROTOCOL_INCOMPATIBLE", HttpStatus.CONFLICT,
                "The client synchronization protocol is incompatible.", false, true, Map.of());
        }
        if (operation.keyEpoch() != account.currentKeyEpoch()) {
            throw new ApiException("KEY_EPOCH_MISMATCH", HttpStatus.CONFLICT,
                "The operation uses an unavailable key epoch.", false, true, Map.of());
        }
    }

    private void requireActiveOperationDevice(UUID accountId, UUID deviceId) {
        var status = jdbc.query("""
            SELECT device_status FROM sync_devices WHERE account_id = ? AND device_id = ?
            """, (rs, row) -> rs.getString(1), accountId, deviceId);
        if (status.isEmpty()) throw new ApiException("DEVICE_NOT_FOUND", HttpStatus.NOT_FOUND,
            "The device is not registered for this account.");
        if (!"ACTIVE".equals(status.getFirst())) throw new ApiException("DEVICE_REVOKED", HttpStatus.FORBIDDEN,
            "The device is no longer authorized.", false, true, Map.of());
    }

    private List<ObjectRow> loadObjects(UUID accountId, UUID operationId) {
        return jdbc.query("""
            SELECT object_key, object_kind, sha256, size_bytes
            FROM sync_operation_objects WHERE account_id = ? AND operation_id = ?
            ORDER BY object_key
            """, (rs, row) -> new ObjectRow(rs.getString(1), rs.getString(2), rs.getString(3), rs.getLong(4)),
            accountId, operationId);
    }

    private void verifyObjects(List<ObjectRow> objects) {
        if (objects.isEmpty()) throw new ApiException("INVALID_OPERATION_OBJECTS", HttpStatus.CONFLICT,
            "The operation has no encrypted objects.");
        for (var object : objects) {
            try {
                var metadata = objectStore.head(new ObjectKey(object.objectKey()));
                if (metadata.sizeBytes() != object.sizeBytes()) {
                    throw new ApiException("OBJECT_SIZE_MISMATCH", HttpStatus.CONFLICT,
                        "An encrypted object failed its size check.", false, true, Map.of());
                }
                if (!object.sha256().equals(metadata.sha256())) {
                    throw new ApiException("HASH_MISMATCH", HttpStatus.CONFLICT,
                        "An encrypted object failed its integrity check.", false, true, Map.of());
                }
            } catch (ObjectStoreException error) {
                throw new ApiException(error.code(), error.retryable() ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.CONFLICT,
                    "A required encrypted object is unavailable.", error.retryable(), false, Map.of());
            }
        }
    }

    private String referenceKind(String objectKind) {
        return switch (objectKind) {
            case "EVENT" -> "EVENT_PAYLOAD";
            case "MEDIA" -> "MEDIA";
            case "THUMBNAIL" -> "THUMBNAIL";
            default -> throw new ApiException("INVALID_OPERATION_OBJECTS", HttpStatus.CONFLICT,
                "The operation contains an unsupported encrypted object kind.");
        };
    }

    private ApiException conflict(long expected, long provided) {
        return new ApiException("RECORD_VERSION_CONFLICT", HttpStatus.CONFLICT,
            "The record has changed on another device.", false, true,
            Map.of("expectedVersion", expected, "providedVersion", provided));
    }

    private Long nullableLong(java.sql.ResultSet rs, int index) throws java.sql.SQLException {
        var value = rs.getLong(index);
        return rs.wasNull() ? null : value;
    }

    private record AccountRow(UUID accountId, long currentSequence, int currentKeyEpoch, String status, int minimumWriteProtocol) {}
    private record OperationRow(
        UUID deviceId, String recordType, UUID recordId, String operationType,
        long baseRecordVersion, String status, int protocolVersion, int eventSchemaVersion,
        int keyEpoch, String partitionKey, Long committedSequence, Long committedRecordVersion
    ) {}
    private record ObjectRow(String objectKey, String kind, String sha256, long sizeBytes) {}
    private record CommitOutcome(CommitOperationResponse response, ApiException error) {
        static CommitOutcome success(CommitOperationResponse response) { return new CommitOutcome(response, null); }
        static CommitOutcome failure(ApiException error) { return new CommitOutcome(null, error); }
    }
}
