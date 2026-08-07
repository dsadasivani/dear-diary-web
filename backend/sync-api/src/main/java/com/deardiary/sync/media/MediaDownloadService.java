package com.deardiary.sync.media;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.objectstore.EncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectKeyFactory;
import com.deardiary.sync.objectstore.ObjectStoreException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class MediaDownloadService {
    private final JdbcTemplate jdbc;
    private final AccountAuthorizationService accounts;
    private final ObjectKeyFactory objectKeys;
    private final EncryptedObjectStore objectStore;

    public MediaDownloadService(
            JdbcTemplate jdbc,
            AccountAuthorizationService accounts,
            ObjectKeyFactory objectKeys,
            EncryptedObjectStore objectStore) {
        this.jdbc = jdbc;
        this.accounts = accounts;
        this.objectKeys = objectKeys;
        this.objectStore = objectStore;
    }

    public MediaDownloadResponse get(String ownerSubject, UUID objectId) {
        var account = accounts.requireActiveAccount(ownerSubject);
        var key = objectKeys.forObjectId(account.accountId(), objectId);
        var rows = jdbc.query("""
            SELECT object.object_kind, object.sha256, object.size_bytes, object.key_epoch
            FROM sync_objects object
            WHERE object.account_id = ? AND object.object_key = ?
              AND object.object_kind IN ('MEDIA', 'THUMBNAIL')
              AND object.storage_status = 'COMMITTED'
              AND EXISTS (
                SELECT 1 FROM sync_object_references reference
                WHERE reference.account_id = object.account_id
                  AND reference.object_key = object.object_key
                  AND reference.reference_kind IN ('MEDIA', 'THUMBNAIL')
                  AND reference.deleted_sequence IS NULL
              )
            """, (rs, row) -> new MediaRow(
                rs.getString(1), rs.getString(2), rs.getLong(3), rs.getInt(4)),
            account.accountId(), key.value());
        if (rows.isEmpty()) {
            throw new ApiException("OBJECT_MISSING", HttpStatus.NOT_FOUND,
                "The encrypted media object is unavailable.");
        }
        try {
            var download = objectStore.createDownload(key);
            var row = rows.getFirst();
            return new MediaDownloadResponse(objectId, row.kind(), row.sha256(), row.sizeBytes(),
                row.keyEpoch(), download.url(), download.expiresAt());
        } catch (ObjectStoreException error) {
            throw new ApiException(error.code(),
                error.retryable() ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.NOT_FOUND,
                "The encrypted media object is unavailable.", error.retryable(), false, Map.of());
        }
    }

    private record MediaRow(String kind, String sha256, long sizeBytes, int keyEpoch) {}
}
