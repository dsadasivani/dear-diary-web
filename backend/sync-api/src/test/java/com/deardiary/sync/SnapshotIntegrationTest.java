package com.deardiary.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.device.DeviceRegistrationRequest;
import com.deardiary.sync.device.DeviceRegistrationService;
import com.deardiary.sync.objectstore.InMemoryEncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectKeyFactory;
import com.deardiary.sync.protocol.ProtocolService;
import com.deardiary.sync.snapshot.InitiateSnapshotRequest;
import com.deardiary.sync.snapshot.SnapshotService;
import java.security.KeyPairGenerator;
import java.time.Clock;
import java.util.Base64;
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
class SnapshotIntegrationTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16.9-alpine");
    private static JdbcTemplate jdbc;
    private SnapshotService snapshots;
    private InMemoryEncryptedObjectStore objectStore;
    private UUID accountId;
    private UUID deviceId;

    @BeforeAll
    static void migrate() {
        var dataSource = new DriverManagerDataSource(
            POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        Flyway.configure().dataSource(dataSource).load().migrate();
        jdbc = new JdbcTemplate(dataSource);
    }

    @BeforeEach
    void reset() throws Exception {
        jdbc.execute("""
            TRUNCATE TABLE sync_notification_outbox, sync_object_references, sync_snapshots,
                sync_events, sync_operation_objects, sync_objects, sync_record_versions,
                sync_operations, sync_device_cursors, sync_devices, sync_accounts CASCADE
            """);
        jdbc.update("UPDATE sync_kill_switches SET engaged = FALSE, reason_code = NULL WHERE switch_name IN ('SYNC_WRITES', 'SNAPSHOT_CREATION')");
        jdbc.update("""
            UPDATE sync_protocol_config SET sync_writes_enabled = TRUE,
                snapshot_creation_enabled = TRUE, snapshot_schema_version = 2,
                maximum_snapshot_bytes = 104857600, emergency_mode = FALSE
            WHERE config_id = 1
            """);
        var dataSource = new DriverManagerDataSource(
            POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        var transactionManager = new DataSourceTransactionManager(dataSource);
        var registrations = new DeviceRegistrationService(jdbc, transactionManager, Clock.systemUTC());
        deviceId = UUID.randomUUID();
        accountId = registrations.register("snapshot-user", new DeviceRegistrationRequest(
            deviceId, publicKey(), "PRIMARY", 2, "test")).accountId();
        objectStore = new InMemoryEncryptedObjectStore();
        snapshots = new SnapshotService(jdbc, transactionManager,
            new DeviceAuthorizationService(jdbc), new AccountAuthorizationService(jdbc),
            new ProtocolService(jdbc), new ObjectKeyFactory(), objectStore, Clock.systemUTC());
    }

    @Test
    void snapshotBecomesDiscoverableOnlyAfterVerifiedAtomicRegistration() {
        var request = request(UUID.randomUUID(), 0);
        var initiated = snapshots.initiate("snapshot-user", request);
        var duplicate = snapshots.initiate("snapshot-user", request);

        assertThat(initiated.existing()).isFalse();
        assertThat(duplicate.existing()).isTrue();
        assertThat(duplicate.upload().objectKey()).isEqualTo(initiated.upload().objectKey());
        assertApiCode(() -> snapshots.latest("snapshot-user", "account", 2), "SNAPSHOT_NOT_FOUND");
        assertApiCode(() -> snapshots.register("snapshot-user", request.snapshotId(), deviceId), "OBJECT_MISSING");
        assertThat(status(request.snapshotId())).isEqualTo("UPLOADING");

        objectStore.markUploaded(new ObjectKey(initiated.upload().objectKey()));
        var registered = snapshots.register("snapshot-user", request.snapshotId(), deviceId);
        var repeated = snapshots.register("snapshot-user", request.snapshotId(), deviceId);
        var latest = snapshots.latest("snapshot-user", "account", 2);

        assertThat(registered.status()).isEqualTo("AVAILABLE");
        assertThat(repeated).isEqualTo(registered);
        assertThat(latest.snapshotId()).isEqualTo(request.snapshotId());
        assertThat(latest.downloadUrl()).contains("/download/");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM sync_object_references", Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT storage_status FROM sync_objects", String.class)).isEqualTo("COMMITTED");
    }

    @Test
    void initiationRejectsStaleSequenceMismatchedIdempotencyAndDisabledCreation() {
        assertApiCode(() -> snapshots.initiate("snapshot-user", request(UUID.randomUUID(), 1)), "SNAPSHOT_SEQUENCE_STALE");

        var id = UUID.randomUUID();
        snapshots.initiate("snapshot-user", request(id, 0));
        var changed = new InitiateSnapshotRequest(id, deviceId, 0, "account", "b".repeat(64),
            512, 1, 2, 2);
        assertApiCode(() -> snapshots.initiate("snapshot-user", changed), "IDEMPOTENCY_MISMATCH");

        jdbc.update("UPDATE sync_kill_switches SET engaged = TRUE, reason_code = 'TEST' WHERE switch_name = 'SNAPSHOT_CREATION'");
        assertApiCode(() -> snapshots.initiate("snapshot-user", request(UUID.randomUUID(), 0)), "SNAPSHOT_CREATION_DISABLED");
    }

    private InitiateSnapshotRequest request(UUID snapshotId, long sequence) {
        return new InitiateSnapshotRequest(snapshotId, deviceId, sequence, "account", "a".repeat(64),
            512, 1, 2, 2);
    }

    private String status(UUID snapshotId) {
        return jdbc.queryForObject(
            "SELECT snapshot_status FROM sync_snapshots WHERE snapshot_id = ?", String.class, snapshotId);
    }

    private static String publicKey() throws Exception {
        var generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(256);
        return Base64.getEncoder().encodeToString(generator.generateKeyPair().getPublic().getEncoded());
    }

    private static void assertApiCode(Runnable action, String code) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.code()).isEqualTo(code));
    }
}
