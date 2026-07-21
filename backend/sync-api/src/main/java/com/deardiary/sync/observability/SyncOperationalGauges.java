package com.deardiary.sync.observability;

import io.micrometer.core.instrument.MeterRegistry;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import javax.sql.DataSource;
import com.zaxxer.hikari.HikariDataSource;

@Component
public class SyncOperationalGauges {
    private final JdbcTemplate jdbc;
    private final AtomicInteger notificationDepth = new AtomicInteger();
    private final AtomicInteger sequenceLag = new AtomicInteger();

    public SyncOperationalGauges(JdbcTemplate jdbc, DataSource dataSource, MeterRegistry meters) {
        this.jdbc = jdbc;
        meters.gauge("sync_notification_outbox_depth", notificationDepth);
        meters.gauge("sync_sequence_lag", sequenceLag);
        if (dataSource instanceof HikariDataSource hikari) {
            meters.gauge("sync_database_pool_active", hikari, value -> {
                var pool = value.getHikariPoolMXBean();
                return pool == null ? 0 : pool.getActiveConnections();
            });
            meters.gauge("sync_database_pool_pending", hikari, value -> {
                var pool = value.getHikariPoolMXBean();
                return pool == null ? 0 : pool.getThreadsAwaitingConnection();
            });
        }
        for (var name : new String[] {
            "sync_operation_conflict_total", "sync_operation_duplicate_total",
            "sync_object_validation_failure_total", "sync_device_revoked_request_total",
            "sync_notification_publish_failure_total", "sync_database_deadlock_total",
            "sync_database_corruption_total"
        }) meters.counter(name);
    }

    @Scheduled(fixedDelayString = "${sync.observability.gauge-interval:30s}")
    public void refresh() {
        notificationDepth.set(jdbc.queryForObject(
            "SELECT count(*) FROM sync_notification_outbox WHERE status IN ('PENDING', 'RETRY_WAIT', 'PUBLISHING')",
            Integer.class));
        sequenceLag.set(jdbc.queryForObject("""
            SELECT COALESCE(MAX(a.current_sequence - c.last_applied_sequence), 0)
            FROM sync_accounts a LEFT JOIN sync_device_cursors c ON c.account_id = a.account_id
            """, Integer.class));
    }
}
