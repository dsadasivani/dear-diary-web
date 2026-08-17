package com.deardiary.sync.snapshot;

import com.deardiary.sync.protocol.ProtocolService;
import java.time.Clock;
import java.time.OffsetDateTime;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class SnapshotRetentionWorker {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ProtocolService protocols;
    private final Clock clock;

    public SnapshotRetentionWorker(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            ProtocolService protocols,
            Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.protocols = protocols;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${sync.snapshot-retention.poll-interval:24h}")
    public void poll() {
        if (!protocols.current().bootstrapControls().rollingSnapshotsEnabled()) return;
        var candidates = jdbc.query("""
            SELECT account_id, snapshot_id, object_key, sequence FROM (
                SELECT s.account_id, s.snapshot_id, s.object_key, s.sequence,
                       ROW_NUMBER() OVER (
                           PARTITION BY s.account_id, s.partition_key
                           ORDER BY s.sequence DESC, s.created_at DESC
                       ) AS rank
                FROM sync_snapshots s
                WHERE s.snapshot_status = 'AVAILABLE' AND s.verified = TRUE
            ) ranked
            WHERE rank > 2
              AND NOT EXISTS (
                  SELECT 1 FROM sync_bootstraps b
                  WHERE b.account_id = ranked.account_id AND b.snapshot_id = ranked.snapshot_id
                    AND b.bootstrap_status IN ('READY', 'ACTIVATING')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_recovery_state r
                  WHERE r.account_id = ranked.account_id
                    AND r.validation_snapshot_id = ranked.snapshot_id
                    AND r.recovery_status NOT IN ('NONE', 'COMPLETED', 'FAILED')
              )
            """, (rs, row) -> new Candidate(
                rs.getObject(1, java.util.UUID.class), rs.getObject(2, java.util.UUID.class),
                rs.getString(3), rs.getLong(4)));
        for (var candidate : candidates) {
            transactions.executeWithoutResult(status -> retire(candidate));
        }
    }

    private void retire(Candidate candidate) {
        var now = OffsetDateTime.now(clock);
        var updated = jdbc.update("""
            UPDATE sync_snapshots SET snapshot_status = 'RETIRED', retired_at = ?
            WHERE account_id = ? AND snapshot_id = ? AND snapshot_status = 'AVAILABLE'
              AND NOT EXISTS (
                  SELECT 1 FROM sync_bootstraps b
                  WHERE b.account_id = ? AND b.snapshot_id = ?
                    AND b.bootstrap_status IN ('READY', 'ACTIVATING')
              )
            """, now, candidate.accountId(), candidate.snapshotId(),
            candidate.accountId(), candidate.snapshotId());
        if (updated == 0) return;
        var objectKeys = jdbc.query("""
            SELECT object_key FROM sync_snapshot_chunks
            WHERE account_id = ? AND snapshot_id = ? ORDER BY chunk_index
            """, (rs, row) -> rs.getString(1), candidate.accountId(), candidate.snapshotId());
        if (objectKeys.isEmpty()) objectKeys = java.util.List.of(candidate.objectKey());
        for (var objectKey : objectKeys) {
            jdbc.update("""
                UPDATE sync_object_references SET deleted_sequence = ?
                WHERE account_id = ? AND object_key = ? AND reference_kind = 'SNAPSHOT'
                  AND deleted_sequence IS NULL
                """, Math.max(1, candidate.sequence()), candidate.accountId(), objectKey);
            jdbc.update("""
                UPDATE sync_objects SET retired_sequence = ?, updated_at = ?
                WHERE account_id = ? AND object_key = ? AND retired_sequence IS NULL
                """, Math.max(1, candidate.sequence()), now, candidate.accountId(), objectKey);
        }
    }

    private record Candidate(
        java.util.UUID accountId, java.util.UUID snapshotId, String objectKey, long sequence
    ) {}
}
