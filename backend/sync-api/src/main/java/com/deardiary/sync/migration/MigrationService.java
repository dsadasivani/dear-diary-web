package com.deardiary.sync.migration;

import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
public class MigrationService {
    private static final Map<String, Set<String>> TRANSITIONS = Map.ofEntries(
        Map.entry("PRECHECK", Set.of("DRAINING_V1", "FAILED")),
        Map.entry("DRAINING_V1", Set.of("VALIDATING_LOCAL_STATE", "FAILED")),
        Map.entry("VALIDATING_LOCAL_STATE", Set.of("CREATING_V2_SNAPSHOT", "FAILED")),
        Map.entry("CREATING_V2_SNAPSHOT", Set.of("UPLOADING_V2_SNAPSHOT", "FAILED")),
        Map.entry("UPLOADING_V2_SNAPSHOT", Set.of("REGISTERING_V2_ACCOUNT", "FAILED")),
        Map.entry("REGISTERING_V2_ACCOUNT", Set.of("VERIFYING_V2_RESTORE", "FAILED")),
        Map.entry("VERIFYING_V2_RESTORE", Set.of("V2_ACTIVE", "FAILED")),
        Map.entry("V2_ACTIVE", Set.of("V1_READ_ONLY"))
    );

    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final DeviceAuthorizationService devices;
    private final Clock clock;

    public MigrationService(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            DeviceAuthorizationService devices,
            Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.devices = devices;
        this.clock = clock;
    }

    public MigrationResponse begin(String ownerSubject, BeginMigrationRequest request) {
        var device = devices.requireActiveDevice(ownerSubject, request.deviceId());
        return transactions.execute(status -> {
            lockAccount(device.accountId());
            var existing = loadOptional(device.accountId(), request.migrationId(), true);
            if (existing != null) {
                if (!existing.deviceId().equals(request.deviceId())
                        || !existing.baselineDigest().equals(request.baselineDigest())
                        || existing.baselineSequence() != request.baselineSequence()) {
                    throw new ApiException("IDEMPOTENCY_MISMATCH", HttpStatus.CONFLICT,
                        "The migration identifier is associated with different metadata.");
                }
                return response(existing);
            }
            var now = OffsetDateTime.now(clock);
            jdbc.update("""
                INSERT INTO sync_migrations (
                    account_id, migration_id, device_id, migration_status, baseline_digest,
                    baseline_sequence, created_at, updated_at
                ) VALUES (?, ?, ?, 'PRECHECK', ?, ?, ?, ?)
                """, device.accountId(), request.migrationId(), request.deviceId(),
                request.baselineDigest(), request.baselineSequence(), now, now);
            return response(load(device.accountId(), request.migrationId(), false));
        });
    }

    public MigrationResponse advance(
            String ownerSubject, UUID migrationId, AdvanceMigrationRequest request) {
        var device = devices.requireActiveDevice(ownerSubject, request.deviceId());
        return transactions.execute(status -> {
            var account = lockAccount(device.accountId());
            var migration = load(device.accountId(), migrationId, true);
            requireOwnerDevice(migration, request.deviceId());
            if (migration.status().equals(request.nextStatus())) return response(migration);
            if (!TRANSITIONS.getOrDefault(migration.status(), Set.of()).contains(request.nextStatus())) {
                throw new ApiException("INVALID_MIGRATION_TRANSITION", HttpStatus.CONFLICT,
                    "The migration state transition is invalid.", false, true, Map.of());
            }
            if ("VERIFYING_V2_RESTORE".equals(request.nextStatus())) {
                requireAvailableSnapshot(device.accountId(), request.snapshotId());
            }
            if ("V2_ACTIVE".equals(request.nextStatus())) {
                if (request.validationDigest() == null || !request.validationDigest().equals(migration.baselineDigest())) {
                    throw new ApiException("MIGRATION_VALIDATION_MISMATCH", HttpStatus.CONFLICT,
                        "The temporary V2 restore does not match local V1 state.", false, true, Map.of());
                }
                requireAvailableSnapshot(device.accountId(), migration.snapshotId());
            }
            var now = OffsetDateTime.now(clock);
            jdbc.update("""
                UPDATE sync_migrations SET migration_status = ?,
                    validation_digest = COALESCE(?, validation_digest),
                    snapshot_id = COALESCE(?, snapshot_id),
                    activated_sequence = CASE WHEN ? = 'V2_ACTIVE' THEN ? ELSE activated_sequence END,
                    updated_at = ?
                WHERE account_id = ? AND migration_id = ?
                """, request.nextStatus(), request.validationDigest(), request.snapshotId(),
                request.nextStatus(), account.currentSequence(), now, device.accountId(), migrationId);
            if ("V1_READ_ONLY".equals(request.nextStatus())) {
                jdbc.update("UPDATE sync_accounts SET v1_mode = 'READ_ONLY', updated_at = ? WHERE account_id = ?",
                    now, device.accountId());
            }
            return response(load(device.accountId(), migrationId, false));
        });
    }

    public MigrationResponse rollback(String ownerSubject, UUID migrationId, UUID deviceId) {
        var device = devices.requireActiveDevice(ownerSubject, deviceId);
        return transactions.execute(status -> {
            var account = lockAccount(device.accountId());
            var migration = load(device.accountId(), migrationId, true);
            requireOwnerDevice(migration, deviceId);
            if ("V1_READ_ONLY".equals(migration.status())) {
                throw rollbackUnavailable();
            }
            if (migration.activatedSequence() != null && account.currentSequence() != migration.activatedSequence()) {
                throw rollbackUnavailable();
            }
            if ("ROLLED_BACK".equals(migration.status())) return response(migration);
            var now = OffsetDateTime.now(clock);
            jdbc.update("""
                UPDATE sync_migrations SET migration_status = 'ROLLED_BACK', updated_at = ?
                WHERE account_id = ? AND migration_id = ?
                """, now, device.accountId(), migrationId);
            jdbc.update("UPDATE sync_accounts SET v1_mode = 'READ_WRITE', updated_at = ? WHERE account_id = ?",
                now, device.accountId());
            return response(load(device.accountId(), migrationId, false));
        });
    }

    public MigrationResponse get(String ownerSubject, UUID migrationId) {
        var accounts = jdbc.query("SELECT account_id FROM sync_accounts WHERE owner_subject = ?",
            (rs, row) -> rs.getObject(1, UUID.class), ownerSubject);
        if (accounts.isEmpty()) throw new ApiException("ACCOUNT_NOT_FOUND", HttpStatus.NOT_FOUND,
            "The synchronization account is not registered.");
        return response(load(accounts.getFirst(), migrationId, false));
    }

    private AccountRow lockAccount(UUID accountId) {
        return jdbc.queryForObject("SELECT current_sequence, v1_mode FROM sync_accounts WHERE account_id = ? FOR UPDATE",
            (rs, row) -> new AccountRow(rs.getLong(1), rs.getString(2)), accountId);
    }

    private void requireAvailableSnapshot(UUID accountId, UUID snapshotId) {
        if (snapshotId == null) throw new ApiException("SNAPSHOT_NOT_FOUND", HttpStatus.CONFLICT,
            "A verified migration snapshot is required.");
        var count = jdbc.queryForObject("""
            SELECT count(*) FROM sync_snapshots
            WHERE account_id = ? AND snapshot_id = ? AND snapshot_status = 'AVAILABLE'
            """, Long.class, accountId, snapshotId);
        if (count == null || count == 0) throw new ApiException("SNAPSHOT_NOT_FOUND", HttpStatus.CONFLICT,
            "A verified migration snapshot is required.");
    }

    private void requireOwnerDevice(MigrationRow migration, UUID deviceId) {
        if (!migration.deviceId().equals(deviceId)) throw new ApiException("MIGRATION_DEVICE_MISMATCH",
            HttpStatus.FORBIDDEN, "The migration belongs to another device.", false, true, Map.of());
    }

    private MigrationRow load(UUID accountId, UUID migrationId, boolean lock) {
        var row = loadOptional(accountId, migrationId, lock);
        if (row == null) throw new ApiException("MIGRATION_NOT_FOUND", HttpStatus.NOT_FOUND,
            "The migration was not found.");
        return row;
    }

    private MigrationRow loadOptional(UUID accountId, UUID migrationId, boolean lock) {
        var rows = jdbc.query("""
            SELECT m.migration_id, m.device_id, m.migration_status, m.baseline_digest,
                   m.validation_digest, m.baseline_sequence, m.activated_sequence,
                   m.snapshot_id, a.v1_mode
            FROM sync_migrations m JOIN sync_accounts a ON a.account_id = m.account_id
            WHERE m.account_id = ? AND m.migration_id = ?
            """ + (lock ? " FOR UPDATE OF m" : ""), (rs, row) -> new MigrationRow(
                rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3),
                rs.getString(4), rs.getString(5), rs.getLong(6), nullableLong(rs, 7),
                rs.getObject(8, UUID.class), rs.getString(9)), accountId, migrationId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private MigrationResponse response(MigrationRow row) {
        return new MigrationResponse(row.migrationId(), row.status(), row.baselineDigest(),
            row.validationDigest(), row.baselineSequence(), row.activatedSequence(), row.snapshotId(), row.v1Mode());
    }

    private ApiException rollbackUnavailable() {
        return new ApiException("MIGRATION_ROLLBACK_UNAVAILABLE", HttpStatus.CONFLICT,
            "Rollback is unavailable after authoritative V2 mutations or V1 read-only finalization.",
            false, true, Map.of());
    }

    private Long nullableLong(java.sql.ResultSet rs, int index) throws java.sql.SQLException {
        var value = rs.getLong(index);
        return rs.wasNull() ? null : value;
    }

    private record AccountRow(long currentSequence, String v1Mode) {}
    private record MigrationRow(
        UUID migrationId, UUID deviceId, String status, String baselineDigest,
        String validationDigest, long baselineSequence, Long activatedSequence,
        UUID snapshotId, String v1Mode
    ) {}
}
