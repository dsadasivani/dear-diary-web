package com.deardiary.sync;

import static org.assertj.core.api.Assertions.assertThat;

import com.deardiary.sync.gc.SyncGarbageCollectionProperties;
import com.deardiary.sync.gc.SyncGarbageCollectionWorker;
import com.deardiary.sync.objectstore.InMemoryEncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectKeyFactory;
import com.deardiary.sync.objectstore.UploadObjectCommand;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@Testcontainers(disabledWithoutDocker = true)
class GarbageCollectionIntegrationTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16.9-alpine");
    private static JdbcTemplate jdbc;
    private static DataSourceTransactionManager transactionManager;
    private final Clock clock = Clock.fixed(Instant.parse("2026-07-13T00:00:00Z"), ZoneOffset.UTC);
    private InMemoryEncryptedObjectStore objects;
    private UUID accountId;

    @BeforeAll
    static void migrate() {
        var dataSource = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        Flyway.configure().dataSource(dataSource).load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        transactionManager = new DataSourceTransactionManager(dataSource);
    }

    @BeforeEach
    void reset() {
        jdbc.execute("TRUNCATE TABLE sync_accounts CASCADE");
        jdbc.update("UPDATE sync_protocol_config SET garbage_collection_enabled = TRUE WHERE config_id = 1");
        jdbc.update("UPDATE sync_kill_switches SET engaged = FALSE, reason_code = NULL WHERE switch_name = 'GARBAGE_COLLECTION'");
        accountId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO sync_accounts (account_id, owner_subject, current_sequence, current_key_epoch,
                minimum_read_protocol, minimum_write_protocol, account_status, created_at, updated_at)
            VALUES (?, ?, 7, 1, 2, 2, 'ACTIVE', ?, ?)
            """, accountId, "gc-user-" + accountId, OffsetDateTime.now(clock), OffsetDateTime.now(clock));
        objects = new InMemoryEncryptedObjectStore();
    }

    @Test
    void dryRunIsNonMutatingAndQuarantineDelayPreventsImmediateDeletion() {
        var eligible = insertRetired(false);
        var referenced = insertRetired(true);
        var dryRun = worker(true, Duration.ofDays(30));
        assertThat(dryRun.quarantineEligible()).extracting(SyncGarbageCollectionWorker.Candidate::objectKey)
            .containsExactly(eligible);
        assertThat(count("sync_gc_quarantine")).isZero();
        jdbc.update("UPDATE sync_kill_switches SET engaged = TRUE, reason_code = 'TEST' WHERE switch_name = 'GARBAGE_COLLECTION'");
        assertThat(dryRun.quarantineEligible()).isEmpty();
        jdbc.update("UPDATE sync_kill_switches SET engaged = FALSE, reason_code = NULL WHERE switch_name = 'GARBAGE_COLLECTION'");

        var enabled = worker(false, Duration.ofDays(30));
        enabled.quarantineEligible();
        assertThat(jdbc.queryForObject("SELECT storage_status FROM sync_objects WHERE object_key = ?", String.class, eligible))
            .isEqualTo("QUARANTINED");
        assertThat(enabled.deleteExpired()).isZero();
        assertThat(jdbc.queryForObject("SELECT storage_status FROM sync_objects WHERE object_key = ?", String.class, referenced))
            .isEqualTo("COMMITTED");
    }

    @Test
    void expiredQuarantineDeletesOnlyWhileAllServerSafetyControlsRemainOpen() {
        insertRetired(false);
        var enabled = worker(false, Duration.ofHours(1));
        enabled.quarantineEligible();
        jdbc.update("UPDATE sync_gc_quarantine SET quarantined_at = ?, delete_not_before = ?",
            OffsetDateTime.parse("2026-07-11T00:00:00Z"), OffsetDateTime.parse("2026-07-12T00:00:00Z"));
        assertThat(enabled.deleteExpired()).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT storage_status FROM sync_objects", String.class)).isEqualTo("DELETED");
        assertThat(jdbc.queryForObject("SELECT quarantine_status FROM sync_gc_quarantine", String.class)).isEqualTo("DELETED");
    }

    private SyncGarbageCollectionWorker worker(boolean dryRun, Duration delay) {
        return new SyncGarbageCollectionWorker(jdbc, transactionManager, objects,
            new SyncGarbageCollectionProperties(true, dryRun, Duration.ofDays(30), delay, 25, 3), clock,
            new SimpleMeterRegistry());
    }

    private String insertRetired(boolean referenced) {
        var key = new ObjectKeyFactory().create(accountId).value();
        var old = OffsetDateTime.parse("2026-05-01T00:00:00Z");
        jdbc.update("""
            INSERT INTO sync_objects (account_id, object_key, object_kind, sha256, size_bytes, key_epoch,
                storage_status, created_sequence, retired_sequence, created_at, updated_at)
            VALUES (?, ?, 'MEDIA', ?, 1, 1, 'COMMITTED', 1, 7, ?, ?)
            """, accountId, key, "a".repeat(64), old, old);
        var objectKey = new ObjectKey(key);
        objects.initiateUpload(new UploadObjectCommand(objectKey, "MEDIA", "a".repeat(64), 1));
        objects.markUploaded(objectKey);
        if (referenced) jdbc.update("""
            INSERT INTO sync_object_references (account_id, object_key, owner_record_type, owner_record_id,
                reference_kind, created_sequence, created_at) VALUES (?, ?, 'ACCOUNT', ?, 'MEDIA', 1, ?)
            """, accountId, key, accountId.toString(), old);
        return key;
    }

    private long count(String table) {
        return jdbc.queryForObject("SELECT count(*) FROM " + table, Long.class);
    }
}
