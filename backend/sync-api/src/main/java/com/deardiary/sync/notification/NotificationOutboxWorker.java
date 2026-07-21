package com.deardiary.sync.notification;

import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Component
@EnableConfigurationProperties(NotificationWorkerProperties.class)
@ConditionalOnProperty(name = "sync.notification.worker.enabled", havingValue = "true")
public class NotificationOutboxWorker {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final SyncNotificationPublisher publisher;
    private final NotificationWorkerProperties properties;
    private final Clock clock;
    private final String workerId = "notification-worker:" + UUID.randomUUID();

    public NotificationOutboxWorker(
            JdbcTemplate jdbc,
            PlatformTransactionManager transactionManager,
            SyncNotificationPublisher publisher,
            NotificationWorkerProperties properties,
            Clock clock) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.publisher = publisher;
        this.properties = properties;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${sync.notification.worker.poll-interval:5s}")
    public void poll() {
        for (var processed = 0; processed < properties.maximumBatchSize(); processed += 1) {
            if (!runOnce()) return;
        }
    }

    public boolean runOnce() {
        var notification = transactions.execute(status -> claim());
        if (notification == null) return false;
        try {
            publisher.publish(notification.notification());
            transactions.executeWithoutResult(status -> markPublished(notification));
        } catch (NotificationPublishException error) {
            transactions.executeWithoutResult(status -> markFailed(notification, error));
        }
        return true;
    }

    private ClaimedNotification claim() {
        var now = OffsetDateTime.now(clock);
        var rows = jdbc.query("""
            SELECT notification_id, account_id, sequence, notification_type, attempt_count
            FROM sync_notification_outbox
            WHERE (
                (status IN ('PENDING', 'RETRY_WAIT') AND next_attempt_at <= ?) OR
                (status = 'PUBLISHING' AND lease_expires_at <= ?)
            )
            ORDER BY next_attempt_at, created_at
            FOR UPDATE SKIP LOCKED LIMIT 1
            """, (rs, row) -> new ClaimedNotification(
                new SyncNotification(
                    rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                    rs.getLong(3), rs.getString(4)),
                rs.getInt(5) + 1), now, now);
        if (rows.isEmpty()) return null;
        var claimed = rows.getFirst();
        jdbc.update("""
            UPDATE sync_notification_outbox SET status = 'PUBLISHING', attempt_count = ?,
                lease_owner = ?, lease_expires_at = ?, updated_at = ?
            WHERE notification_id = ?
            """, claimed.attemptCount(), workerId, now.plus(properties.leaseDuration()), now,
            claimed.notification().notificationId());
        return claimed;
    }

    private void markPublished(ClaimedNotification claimed) {
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            UPDATE sync_notification_outbox SET status = 'PUBLISHED', published_at = ?,
                lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
            WHERE notification_id = ? AND lease_owner = ?
            """, now, now, claimed.notification().notificationId(), workerId);
    }

    private void markFailed(ClaimedNotification claimed, NotificationPublishException error) {
        var now = OffsetDateTime.now(clock);
        var deadLetter = !error.retryable() || claimed.attemptCount() >= properties.maximumAttempts();
        var exponent = Math.min(Math.max(claimed.attemptCount() - 1, 0), 10);
        var delay = properties.retryBaseDelay().multipliedBy(1L << exponent);
        jdbc.update("""
            UPDATE sync_notification_outbox SET status = ?, next_attempt_at = ?,
                lease_owner = NULL, lease_expires_at = NULL, last_error_code = ?, updated_at = ?
            WHERE notification_id = ? AND lease_owner = ?
            """, deadLetter ? "DEAD_LETTER" : "RETRY_WAIT", now.plus(delay), error.code(), now,
            claimed.notification().notificationId(), workerId);
    }

    private record ClaimedNotification(SyncNotification notification, int attemptCount) {}
}
