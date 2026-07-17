package com.deardiary.sync.event;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.objectstore.EncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectStoreException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class EventPullService {
    public static final int MAXIMUM_PAGE_SIZE = 100;
    private final JdbcTemplate jdbc;
    private final AccountAuthorizationService accounts;
    private final EncryptedObjectStore objectStore;

    public EventPullService(
            JdbcTemplate jdbc,
            AccountAuthorizationService accounts,
            EncryptedObjectStore objectStore) {
        this.jdbc = jdbc;
        this.accounts = accounts;
        this.objectStore = objectStore;
    }

    public PullEventsResponse pull(String ownerSubject, long after, int limit) {
        if (after < 0 || limit < 1 || limit > MAXIMUM_PAGE_SIZE) {
            throw new ApiException("INVALID_CURSOR", HttpStatus.BAD_REQUEST, "The event cursor or page size is invalid.");
        }
        var account = accounts.requireActiveAccount(ownerSubject);
        if (after > account.currentSequence()) {
            throw new ApiException("CURSOR_AHEAD", HttpStatus.CONFLICT,
                "The event cursor is ahead of the account sequence.", false, true, Map.of());
        }
        var rows = jdbc.query("""
            SELECT sequence, event_id, operation_id, device_id, record_type, record_id,
                   operation_type, record_version, key_epoch, partition_key, object_key,
                   sha256, size_bytes, event_schema_version
            FROM sync_events WHERE account_id = ? AND sequence > ?
            ORDER BY sequence ASC LIMIT ?
            """, (rs, row) -> new EventRow(
                rs.getLong(1), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class),
                rs.getObject(4, UUID.class), rs.getString(5), rs.getString(6),
                rs.getString(7), rs.getLong(8), rs.getInt(9), rs.getString(10),
                rs.getString(11), rs.getString(12), rs.getLong(13), rs.getInt(14)),
            account.accountId(), after, limit + 1);
        var expectedSequence = after + 1;
        for (var row : rows) {
            if (row.sequence() != expectedSequence) {
                throw new ApiException("SEQUENCE_GAP", HttpStatus.CONFLICT,
                    "A gap was found in the remote event sequence.", false, true,
                    Map.of("expectedSequence", expectedSequence, "actualSequence", row.sequence()));
            }
            expectedSequence += 1;
        }
        var page = rows.stream().limit(limit).map(this::withDownload).toList();
        var lastSequence = page.isEmpty() ? after : page.getLast().sequence();
        var hasMore = rows.size() > limit || account.currentSequence() > lastSequence;
        return new PullEventsResponse(page, account.currentSequence(), hasMore);
    }

    private PullEventsResponse.Event withDownload(EventRow row) {
        try {
            var download = objectStore.createDownload(new ObjectKey(row.objectKey()));
            return new PullEventsResponse.Event(
                row.sequence(), row.eventId(), row.operationId(), row.deviceId(), row.recordType(),
                row.recordId(), row.operationType(), row.recordVersion(), row.keyEpoch(), row.partitionKey(),
                row.objectKey(), row.sha256(), row.sizeBytes(), row.eventSchemaVersion(),
                download.url(), download.expiresAt());
        } catch (ObjectStoreException error) {
            throw new ApiException(error.code(), error.retryable() ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.CONFLICT,
                "A required encrypted object is unavailable.", error.retryable(), false, Map.of());
        }
    }

    private record EventRow(
        long sequence, UUID eventId, UUID operationId, UUID deviceId,
        String recordType, String recordId, String operationType, long recordVersion,
        int keyEpoch, String partitionKey, String objectKey, String sha256,
        long sizeBytes, int eventSchemaVersion
    ) {}
}
