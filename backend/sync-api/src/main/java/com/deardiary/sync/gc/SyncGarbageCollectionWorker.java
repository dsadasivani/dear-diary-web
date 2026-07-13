package com.deardiary.sync.gc;

import com.deardiary.sync.objectstore.EncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Component
@EnableConfigurationProperties(SyncGarbageCollectionProperties.class)
@ConditionalOnProperty(name = "sync.garbage-collection.enabled", havingValue = "true")
public class SyncGarbageCollectionWorker {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final EncryptedObjectStore objectStore;
    private final SyncGarbageCollectionProperties properties;
    private final Clock clock;
    private final MeterRegistry meters;

    public SyncGarbageCollectionWorker(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            EncryptedObjectStore objectStore,
            SyncGarbageCollectionProperties properties,
            Clock clock,
            MeterRegistry meters) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.objectStore = objectStore;
        this.properties = properties;
        this.clock = clock;
        this.meters = meters;
    }

    @Scheduled(fixedDelayString = "${sync.garbage-collection.poll-interval:1h}")
    public void poll() {
        quarantineEligible();
        if (!properties.dryRun()) deleteExpired();
    }

    public List<Candidate> quarantineEligible() {
        var candidates = findEligible();
        meters.counter("deardiary.sync.gc.candidates").increment(candidates.size());
        if (properties.dryRun()) return candidates;
        for (var candidate : candidates) quarantine(candidate);
        return candidates;
    }

    public int deleteExpired() {
        if (properties.dryRun()) return 0;
        var deleted = 0;
        for (var index = 0; index < properties.maximumBatchSize(); index += 1) {
            var candidate = transactions.execute(status -> claimDeletion());
            if (candidate == null) break;
            try {
                objectStore.delete(new ObjectKey(candidate.objectKey()));
                transactions.executeWithoutResult(status -> markDeleted(candidate));
                meters.counter("deardiary.sync.gc.deleted").increment();
                deleted += 1;
            } catch (RuntimeException error) {
                transactions.executeWithoutResult(status -> markDeleteFailed(candidate, error));
            }
        }
        return deleted;
    }

    private List<Candidate> findEligible() {
        var cutoff = OffsetDateTime.now(clock).minus(properties.retention());
        return jdbc.query("""
            SELECT o.account_id, o.object_key,
                   GREATEST(COALESCE(o.retired_sequence, o.created_sequence, 1), 1)
            FROM sync_objects o
            JOIN sync_accounts a ON a.account_id = o.account_id
            CROSS JOIN sync_protocol_config p
            WHERE p.config_id = 1 AND p.garbage_collection_enabled = TRUE AND p.emergency_mode = FALSE
              AND NOT EXISTS (SELECT 1 FROM sync_kill_switches k
                  WHERE k.switch_name = 'GARBAGE_COLLECTION' AND k.engaged = TRUE)
              AND a.account_status = 'ACTIVE'
              AND o.storage_status = 'COMMITTED'
              AND o.retired_sequence IS NOT NULL
              AND o.updated_at <= ?
              AND NOT EXISTS (
                  SELECT 1 FROM sync_object_references r
                  WHERE r.account_id = o.account_id AND r.object_key = o.object_key
                    AND r.deleted_sequence IS NULL
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_operation_objects oo
                  JOIN sync_operations op ON op.account_id = oo.account_id
                    AND op.operation_id = oo.operation_id
                  WHERE oo.account_id = o.account_id AND oo.object_key = o.object_key
                    AND op.operation_status NOT IN ('COMMITTED', 'CONFLICT')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_snapshots s
                  WHERE s.account_id = o.account_id AND s.object_key = o.object_key
                    AND s.snapshot_status = 'AVAILABLE'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_key_packages k
                  WHERE k.account_id = o.account_id AND k.object_key = o.object_key
                    AND k.package_status IN ('PENDING_UPLOAD', 'AVAILABLE')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_recovery_state r
                  WHERE r.account_id = o.account_id
                    AND r.recovery_status NOT IN ('NONE', 'COMPLETED', 'FAILED')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_key_rotations r
                  WHERE r.account_id = o.account_id
                    AND r.rotation_status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_gc_quarantine q
                  WHERE q.account_id = o.account_id AND q.object_key = o.object_key
              )
            ORDER BY o.updated_at, o.object_key
            LIMIT ?
            """, (rs, row) -> new Candidate(
                rs.getObject(1, UUID.class), rs.getString(2), rs.getLong(3)),
            cutoff, properties.maximumBatchSize());
    }

    private void quarantine(Candidate candidate) {
        var now = OffsetDateTime.now(clock);
        var inserted = transactions.execute(status -> jdbc.update("""
            INSERT INTO sync_gc_quarantine (
                account_id, object_key, quarantine_id, reason_code, eligible_sequence,
                quarantined_at, delete_not_before, quarantine_status, attempt_count
            ) VALUES (?, ?, ?, 'UNREFERENCED_RETIRED_OBJECT', ?, ?, ?, 'QUARANTINED', 0)
            ON CONFLICT (account_id, object_key) DO NOTHING
            """, candidate.accountId(), candidate.objectKey(), UUID.randomUUID(),
            candidate.eligibleSequence(), now, now.plus(properties.quarantineDelay())));
        if (inserted == null || inserted == 0) return;
        try {
            objectStore.quarantine(new ObjectKey(candidate.objectKey()));
            transactions.executeWithoutResult(status -> jdbc.update("""
                UPDATE sync_objects SET storage_status = 'QUARANTINED', updated_at = ?
                WHERE account_id = ? AND object_key = ? AND storage_status = 'COMMITTED'
                """, now, candidate.accountId(), candidate.objectKey()));
            transactions.executeWithoutResult(status -> audit(candidate.accountId(), candidate.objectKey(),
                "COMMITTED", "QUARANTINED", "UNREFERENCED_RETIRED_OBJECT", null, now));
            meters.counter("deardiary.sync.gc.quarantined").increment();
        } catch (RuntimeException error) {
            transactions.executeWithoutResult(status -> {
                jdbc.update("DELETE FROM sync_gc_quarantine WHERE account_id = ? AND object_key = ?",
                    candidate.accountId(), candidate.objectKey());
            });
        }
    }

    private Deletion claimDeletion() {
        var now = OffsetDateTime.now(clock);
        var rows = jdbc.query("""
            SELECT q.account_id, q.object_key, q.attempt_count
            FROM sync_gc_quarantine q
            JOIN sync_objects o ON o.account_id = q.account_id AND o.object_key = q.object_key
            JOIN sync_accounts a ON a.account_id = q.account_id
            CROSS JOIN sync_protocol_config p
            WHERE p.config_id = 1 AND p.garbage_collection_enabled = TRUE AND p.emergency_mode = FALSE
              AND NOT EXISTS (SELECT 1 FROM sync_kill_switches k
                  WHERE k.switch_name = 'GARBAGE_COLLECTION' AND k.engaged = TRUE)
              AND a.account_status = 'ACTIVE'
              AND q.quarantine_status IN ('QUARANTINED', 'REVIEWED', 'DELETE_PENDING')
              AND q.delete_not_before <= ? AND q.attempt_count < ?
              AND o.storage_status IN ('QUARANTINED', 'DELETE_PENDING')
              AND NOT EXISTS (
                  SELECT 1 FROM sync_object_references r
                  WHERE r.account_id = q.account_id AND r.object_key = q.object_key
                    AND r.deleted_sequence IS NULL
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_operation_objects oo
                  JOIN sync_operations op ON op.account_id = oo.account_id
                    AND op.operation_id = oo.operation_id
                  WHERE oo.account_id = q.account_id AND oo.object_key = q.object_key
                    AND op.operation_status NOT IN ('COMMITTED', 'CONFLICT')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_snapshots s
                  WHERE s.account_id = q.account_id AND s.object_key = q.object_key
                    AND s.snapshot_status = 'AVAILABLE'
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_key_packages k
                  WHERE k.account_id = q.account_id AND k.object_key = q.object_key
                    AND k.package_status IN ('PENDING_UPLOAD', 'AVAILABLE')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_recovery_state r WHERE r.account_id = q.account_id
                    AND r.recovery_status NOT IN ('NONE', 'COMPLETED', 'FAILED')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_key_rotations r WHERE r.account_id = q.account_id
                    AND r.rotation_status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
              )
            ORDER BY q.delete_not_before, q.object_key
            FOR UPDATE OF q SKIP LOCKED LIMIT 1
            """, (rs, row) -> new Deletion(
                rs.getObject(1, UUID.class), rs.getString(2), rs.getInt(3) + 1),
            now, properties.maximumAttempts());
        if (rows.isEmpty()) return null;
        var deletion = rows.getFirst();
        jdbc.update("""
            UPDATE sync_gc_quarantine SET quarantine_status = 'DELETE_PENDING',
                attempt_count = ?, claimed_at = ?, last_error_code = NULL
            WHERE account_id = ? AND object_key = ?
            """, deletion.attemptCount(), now, deletion.accountId(), deletion.objectKey());
        jdbc.update("""
            UPDATE sync_objects SET storage_status = 'DELETE_PENDING', updated_at = ?
            WHERE account_id = ? AND object_key = ?
            """, now, deletion.accountId(), deletion.objectKey());
        audit(deletion.accountId(), deletion.objectKey(), "QUARANTINED", "DELETE_PENDING",
            "QUARANTINE_ELAPSED", null, now);
        return deletion;
    }

    private void markDeleted(Deletion deletion) {
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            UPDATE sync_objects SET storage_status = 'DELETED', updated_at = ?
            WHERE account_id = ? AND object_key = ?
            """, now, deletion.accountId(), deletion.objectKey());
        jdbc.update("""
            UPDATE sync_gc_quarantine SET quarantine_status = 'DELETED', deleted_at = ?,
                claimed_at = NULL, last_error_code = NULL
            WHERE account_id = ? AND object_key = ?
            """, now, deletion.accountId(), deletion.objectKey());
        audit(deletion.accountId(), deletion.objectKey(), "DELETE_PENDING", "DELETED",
            "OBJECT_STORE_DELETE_CONFIRMED", null, now);
    }

    private void markDeleteFailed(Deletion deletion, RuntimeException error) {
        var now = OffsetDateTime.now(clock);
        var code = error.getClass().getSimpleName();
        jdbc.update("""
            UPDATE sync_gc_quarantine SET quarantine_status = 'QUARANTINED',
                claimed_at = NULL, last_error_code = ?
            WHERE account_id = ? AND object_key = ?
            """, code, deletion.accountId(), deletion.objectKey());
        jdbc.update("""
            UPDATE sync_objects SET storage_status = 'QUARANTINED', updated_at = ?
            WHERE account_id = ? AND object_key = ?
            """, now, deletion.accountId(), deletion.objectKey());
        audit(deletion.accountId(), deletion.objectKey(), "DELETE_PENDING", "RETRY_WAIT",
            "OBJECT_STORE_DELETE_FAILED", code, now);
    }

    private void audit(UUID accountId, String objectKey, String fromStatus, String toStatus,
            String reason, String error, OffsetDateTime now) {
        jdbc.update("""
            INSERT INTO sync_gc_audit (audit_id, account_id, object_key, from_status, to_status,
                reason_code, error_code, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, UUID.randomUUID(), accountId, objectKey, fromStatus, toStatus, reason, error, now);
    }

    public record Candidate(UUID accountId, String objectKey, long eligibleSequence) {}
    private record Deletion(UUID accountId, String objectKey, int attemptCount) {}
}
