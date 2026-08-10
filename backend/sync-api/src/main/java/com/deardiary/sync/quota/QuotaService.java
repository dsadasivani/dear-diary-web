package com.deardiary.sync.quota;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class QuotaService {
    private final JdbcTemplate jdbc;
    private final AccountAuthorizationService accounts;

    public QuotaService(JdbcTemplate jdbc, AccountAuthorizationService accounts) {
        this.jdbc = jdbc;
        this.accounts = accounts;
    }

    public QuotaResponse current(String ownerSubject) {
        var account = accounts.requireActiveAccount(ownerSubject);
        var plan = requirePlan(account.accountId());
        return new QuotaResponse(
            plan.planId(), plan.displayName(),
            new QuotaResponse.Limits(
                plan.maximumCompanions(), plan.maximumPhotosPerEntry(),
                plan.maximumRecordingsPerEntry(), plan.maximumStorageBytes()),
            new QuotaResponse.Usage(
                companionSlotsUsed(account.accountId()), storageBytesUsed(account.accountId())));
    }

    public QuotaPlan requirePlan(UUID accountId) {
        return jdbc.queryForObject("""
            SELECT p.plan_id, p.display_name, p.maximum_companions,
                   p.maximum_photos_per_entry, p.maximum_recordings_per_entry,
                   p.maximum_storage_bytes
            FROM sync_accounts a
            JOIN sync_plans p ON p.plan_id = a.plan_id
            WHERE a.account_id = ?
            """, (rs, row) -> new QuotaPlan(
                rs.getString(1), rs.getString(2), rs.getInt(3),
                rs.getInt(4), rs.getInt(5), rs.getLong(6)), accountId);
    }

    public void requireCompanionSlot(UUID accountId) {
        var plan = requirePlan(accountId);
        var used = companionSlotsUsed(accountId);
        if (used >= plan.maximumCompanions()) {
            throw new ApiException(
                "COMPANION_LIMIT_EXCEEDED", HttpStatus.CONFLICT,
                "This account has reached its companion limit.", false, true,
                Map.of("limit", plan.maximumCompanions(), "used", used, "planId", plan.planId()));
        }
    }

    public void requireEntryMediaCounts(
            UUID accountId, String recordId, int photos, int recordings) {
        var plan = requirePlan(accountId);
        var previous = jdbc.query("""
            SELECT deleted, entry_photo_count, entry_recording_count
            FROM sync_record_versions
            WHERE account_id = ? AND record_type = 'ENTRY' AND record_id = ?
            """, (rs, row) -> new EntryMediaUsage(
                rs.getBoolean(1), nullableInteger(rs, 2), nullableInteger(rs, 3)),
                accountId, recordId);
        var existing = previous.isEmpty() ? null : previous.getFirst();
        var allowedPhotos = existing == null || existing.deleted() || existing.photoCount() == null
            ? plan.maximumPhotosPerEntry()
            : Math.max(plan.maximumPhotosPerEntry(), existing.photoCount());
        var allowedRecordings = existing == null || existing.deleted() || existing.recordingCount() == null
            ? plan.maximumRecordingsPerEntry()
            : Math.max(plan.maximumRecordingsPerEntry(), existing.recordingCount());
        if (photos > allowedPhotos || recordings > allowedRecordings) {
            throw new ApiException(
                "ENTRY_MEDIA_LIMIT_EXCEEDED", HttpStatus.CONFLICT,
                "This entry exceeds the media limits for the account plan.", false, true,
                Map.of(
                    "maximumPhotos", plan.maximumPhotosPerEntry(),
                    "maximumRecordings", plan.maximumRecordingsPerEntry(),
                    "allowedPhotos", allowedPhotos,
                    "allowedRecordings", allowedRecordings,
                    "photoCount", photos,
                    "recordingCount", recordings,
                    "planId", plan.planId()));
        }
    }

    private Integer nullableInteger(java.sql.ResultSet rs, int index) throws java.sql.SQLException {
        var value = rs.getInt(index);
        return rs.wasNull() ? null : value;
    }

    private record EntryMediaUsage(
        boolean deleted, Integer photoCount, Integer recordingCount
    ) {}

    public void requireStorageCapacity(UUID accountId, long additionalBytes, boolean allowOverage) {
        if (allowOverage) return;
        var plan = requirePlan(accountId);
        var used = storageBytesUsed(accountId);
        if (additionalBytes > plan.maximumStorageBytes() - Math.min(used, plan.maximumStorageBytes())) {
            throw new ApiException(
                "STORAGE_QUOTA_EXCEEDED", HttpStatus.INSUFFICIENT_STORAGE,
                "This account has reached its encrypted cloud storage limit.", false, true,
                Map.of(
                    "limitBytes", plan.maximumStorageBytes(),
                    "usedBytes", used,
                    "requestedBytes", additionalBytes,
                    "planId", plan.planId()));
        }
    }

    public long companionSlotsUsed(UUID accountId) {
        var value = jdbc.queryForObject("""
            SELECT count(*) FROM sync_devices
            WHERE account_id = ? AND device_role = 'COMPANION'
              AND device_status IN ('ACTIVE', 'RECOVERY_PENDING')
            """, Long.class, accountId);
        return value == null ? 0 : value;
    }

    public long storageBytesUsed(UUID accountId) {
        var value = jdbc.queryForObject("""
            SELECT COALESCE(sum(size_bytes), 0) FROM sync_objects
            WHERE account_id = ? AND storage_status <> 'DELETED'
            """, Long.class, accountId);
        return value == null ? 0 : value;
    }
}
