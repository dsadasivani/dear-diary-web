package com.deardiary.sync.retention;

import com.deardiary.sync.protocol.ProtocolService;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class EventRetentionWorker {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ProtocolService protocols;
    private final Clock clock;
    private final MeterRegistry meters;

    public EventRetentionWorker(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            ProtocolService protocols,
            Clock clock,
            MeterRegistry meters) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.protocols = protocols;
        this.clock = clock;
        this.meters = meters;
    }

    @Scheduled(fixedDelayString = "${sync.event-retention.poll-interval:24h}")
    public void poll() {
        markStaleDevices();
        for (var candidate : findEligibleWatermarks()) recordCandidate(candidate);
        if (protocols.current().bootstrapControls().retentionDeletionEnabled()) deleteMatured();
    }

    public int markStaleDevices() {
        return jdbc.update("""
            UPDATE sync_devices SET rebootstrap_required = TRUE
            WHERE device_status = 'ACTIVE' AND rebootstrap_required = FALSE
              AND last_seen_at < ?
            """, OffsetDateTime.now(clock).minusDays(90));
    }

    public List<Candidate> findEligibleWatermarks() {
        var recentCutoff = OffsetDateTime.now(clock).minusDays(90);
        return jdbc.query("""
            SELECT a.account_id,
                   LEAST(s.sequence, COALESCE(MIN(c.last_applied_sequence), s.sequence)) AS watermark
            FROM sync_accounts a
            JOIN LATERAL (
                SELECT sequence FROM sync_snapshots
                WHERE account_id = a.account_id AND partition_key = 'account'
                  AND snapshot_status = 'AVAILABLE' AND verified = TRUE
                ORDER BY sequence DESC, created_at DESC LIMIT 1
            ) s ON TRUE
            LEFT JOIN sync_devices d ON d.account_id = a.account_id
              AND d.device_status = 'ACTIVE' AND d.rebootstrap_required = FALSE
              AND d.last_seen_at >= ?
            LEFT JOIN sync_device_cursors c ON c.account_id = d.account_id AND c.device_id = d.device_id
            WHERE a.account_status = 'ACTIVE'
              AND NOT EXISTS (
                  SELECT 1 FROM sync_bootstraps b WHERE b.account_id = a.account_id
                    AND b.bootstrap_status IN ('READY', 'ACTIVATING')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_pairing_requests p WHERE p.account_id = a.account_id
                    AND p.pairing_status NOT IN ('COMPLETED', 'EXPIRED', 'REJECTED')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_recovery_state r WHERE r.account_id = a.account_id
                    AND r.recovery_status NOT IN ('NONE', 'COMPLETED', 'FAILED')
              )
              AND NOT EXISTS (
                  SELECT 1 FROM sync_key_rotations r WHERE r.account_id = a.account_id
                    AND r.rotation_status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
              )
            GROUP BY a.account_id, a.minimum_available_sequence, s.sequence
            HAVING LEAST(s.sequence, COALESCE(MIN(c.last_applied_sequence), s.sequence))
                > a.minimum_available_sequence
            """, (rs, row) -> new Candidate(rs.getObject(1, UUID.class), rs.getLong(2)), recentCutoff);
    }

    private void recordCandidate(Candidate candidate) {
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            INSERT INTO sync_event_retention_candidates (
                account_id, eligible_through_sequence, candidate_status,
                first_eligible_at, delete_not_before, last_verified_at
            ) VALUES (?, ?, 'DRY_RUN', ?, ?, ?)
            ON CONFLICT (account_id) DO UPDATE SET
                eligible_through_sequence = EXCLUDED.eligible_through_sequence,
                candidate_status = CASE
                    WHEN sync_event_retention_candidates.eligible_through_sequence
                         = EXCLUDED.eligible_through_sequence
                    THEN sync_event_retention_candidates.candidate_status
                    ELSE 'DRY_RUN'
                END,
                first_eligible_at = CASE
                    WHEN sync_event_retention_candidates.eligible_through_sequence
                         = EXCLUDED.eligible_through_sequence
                    THEN sync_event_retention_candidates.first_eligible_at
                    ELSE EXCLUDED.first_eligible_at
                END,
                delete_not_before = CASE
                    WHEN sync_event_retention_candidates.eligible_through_sequence
                         = EXCLUDED.eligible_through_sequence
                    THEN sync_event_retention_candidates.delete_not_before
                    ELSE EXCLUDED.delete_not_before
                END,
                last_verified_at = EXCLUDED.last_verified_at,
                deleted_at = NULL
            """, candidate.accountId(), candidate.watermark(), now, now.plusDays(30), now);
        meters.counter("deardiary.sync.retention.candidate").increment();
    }

    private void deleteMatured() {
        var candidates = jdbc.query("""
            SELECT account_id, eligible_through_sequence
            FROM sync_event_retention_candidates
            WHERE candidate_status IN ('DRY_RUN', 'GRACE') AND delete_not_before <= ?
            ORDER BY delete_not_before LIMIT 10
            """, (rs, row) -> new Candidate(rs.getObject(1, UUID.class), rs.getLong(2)),
            OffsetDateTime.now(clock));
        for (var candidate : candidates) {
            transactions.executeWithoutResult(status -> deleteCandidate(candidate));
        }
    }

    private void deleteCandidate(Candidate candidate) {
        jdbc.queryForObject("SELECT account_id FROM sync_accounts WHERE account_id = ? FOR UPDATE",
            UUID.class, candidate.accountId());
        var stillEligible = findEligibleWatermarks().stream()
            .anyMatch(row -> row.accountId().equals(candidate.accountId())
                && row.watermark() >= candidate.watermark());
        if (!stillEligible) {
            jdbc.update("""
                UPDATE sync_event_retention_candidates SET candidate_status = 'RELEASED'
                WHERE account_id = ?
                """, candidate.accountId());
            return;
        }
        var objectKeys = jdbc.query("""
            SELECT object_key FROM sync_events WHERE account_id = ? AND sequence <= ?
            """, (rs, row) -> rs.getString(1), candidate.accountId(), candidate.watermark());
        jdbc.update("""
            UPDATE sync_object_references SET deleted_sequence = ?
            WHERE account_id = ? AND reference_kind = 'EVENT_PAYLOAD'
              AND created_sequence <= ? AND deleted_sequence IS NULL
            """, candidate.watermark(), candidate.accountId(), candidate.watermark());
        jdbc.update("DELETE FROM sync_events WHERE account_id = ? AND sequence <= ?",
            candidate.accountId(), candidate.watermark());
        for (var objectKey : objectKeys) {
            jdbc.update("""
                UPDATE sync_objects SET retired_sequence = ?, updated_at = ?
                WHERE account_id = ? AND object_key = ? AND retired_sequence IS NULL
                """, candidate.watermark(), OffsetDateTime.now(clock), candidate.accountId(), objectKey);
        }
        jdbc.update("""
            UPDATE sync_accounts SET minimum_available_sequence = ?, updated_at = ?
            WHERE account_id = ?
            """, candidate.watermark(), OffsetDateTime.now(clock), candidate.accountId());
        jdbc.update("""
            UPDATE sync_event_retention_candidates
            SET candidate_status = 'DELETED', deleted_at = ?, last_verified_at = ?
            WHERE account_id = ?
            """, OffsetDateTime.now(clock), OffsetDateTime.now(clock), candidate.accountId());
        meters.counter("deardiary.sync.retention.deleted").increment();
    }

    public record Candidate(UUID accountId, long watermark) {}
}
