package com.deardiary.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.device.DeviceRegistrationRequest;
import com.deardiary.sync.device.DeviceRegistrationService;
import com.deardiary.sync.objectstore.InMemoryEncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectKeyFactory;
import com.deardiary.sync.operation.InitiateOperationRequest;
import com.deardiary.sync.operation.OperationCommitService;
import com.deardiary.sync.operation.OperationInitiationService;
import com.deardiary.sync.operation.OperationObjectRequest;
import com.deardiary.sync.operation.OperationQueryService;
import com.deardiary.sync.protocol.ProtocolService;
import java.security.KeyPairGenerator;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
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
class AtomicCommitIntegrationTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16.9-alpine");
    private static DriverManagerDataSource dataSource;
    private static JdbcTemplate jdbc;
    private OperationInitiationService initiation;
    private OperationCommitService commits;
    private OperationQueryService queries;
    private InMemoryEncryptedObjectStore objectStore;
    private ObjectKeyFactory keys;
    private UUID accountId;
    private UUID deviceId;

    @BeforeAll
    static void migrate() {
        dataSource = new DriverManagerDataSource(
            POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        Flyway.configure().dataSource(dataSource).load().migrate();
        jdbc = new JdbcTemplate(dataSource);
    }

    @BeforeEach
    void reset() throws Exception {
        jdbc.execute("""
            TRUNCATE TABLE sync_notification_outbox, sync_object_references, sync_events,
                sync_operation_objects, sync_objects, sync_record_versions, sync_operations,
                sync_device_cursors, sync_devices, sync_accounts CASCADE
            """);
        jdbc.update("UPDATE sync_kill_switches SET engaged = FALSE, reason_code = NULL WHERE switch_name IN ('SYNC_WRITES', 'REMOTE_PULL', 'REALTIME')");
        jdbc.update("""
            UPDATE sync_protocol_config SET minimum_read_protocol_version = 2,
                minimum_write_protocol_version = 2, current_protocol_version = 2,
                event_schema_version = 2, sync_writes_enabled = TRUE
            WHERE config_id = 1
            """);
        var transactionManager = new DataSourceTransactionManager(dataSource);
        var deviceAuthorization = new DeviceAuthorizationService(jdbc);
        var registrations = new DeviceRegistrationService(jdbc, transactionManager, Clock.systemUTC());
        deviceId = UUID.randomUUID();
        accountId = registrations.register("commit-user", new DeviceRegistrationRequest(
            deviceId, publicKey(), "PRIMARY", 2, "test")).accountId();
        objectStore = new InMemoryEncryptedObjectStore();
        keys = new ObjectKeyFactory();
        var protocols = new ProtocolService(jdbc);
        initiation = new OperationInitiationService(
            jdbc, transactionManager, deviceAuthorization, protocols, keys, objectStore, Clock.systemUTC());
        commits = new OperationCommitService(jdbc, transactionManager, protocols, objectStore, Clock.systemUTC());
        queries = new OperationQueryService(jdbc, new com.deardiary.sync.account.AccountAuthorizationService(jdbc));
    }

    @Test
    void firstAndDuplicateCommitProduceOneEventAndContinuousSequences() {
        var first = initiate(deviceId, UUID.randomUUID(), 0);
        objectStore.markUploaded(first.objectKey());

        var committed = commits.commit("commit-user", first.operationId());
        var duplicate = commits.commit("commit-user", first.operationId());

        assertThat(committed.sequence()).isEqualTo(1);
        assertThat(committed.recordVersion()).isEqualTo(1);
        assertThat(duplicate).isEqualTo(committed);
        assertThat(queries.find("commit-user", first.operationId()).status()).isEqualTo("COMMITTED");
        assertThat(count("sync_events")).isEqualTo(1);
        assertThat(count("sync_notification_outbox")).isEqualTo(1);
        assertThat(count("sync_object_references")).isEqualTo(1);

        var second = initiate(deviceId, UUID.randomUUID(), 0);
        objectStore.markUploaded(second.objectKey());
        assertThat(commits.commit("commit-user", second.operationId()).sequence()).isEqualTo(2);
        assertThat(jdbc.queryForList("SELECT sequence FROM sync_events ORDER BY sequence", Long.class))
            .containsExactly(1L, 2L);
    }

    @Test
    void concurrentDuplicateCommitsReturnOneLogicalCommit() throws Exception {
        var operation = initiate(deviceId, UUID.randomUUID(), 0);
        objectStore.markUploaded(operation.objectKey());
        try (var executor = Executors.newFixedThreadPool(2)) {
            var tasks = List.<Callable<com.deardiary.sync.operation.CommitOperationResponse>>of(
                () -> commits.commit("commit-user", operation.operationId()),
                () -> commits.commit("commit-user", operation.operationId()));
            var results = executor.invokeAll(tasks).stream().map(future -> {
                try { return future.get(); } catch (Exception error) { throw new RuntimeException(error); }
            }).toList();
            assertThat(results.get(0)).isEqualTo(results.get(1));
        }
        assertThat(count("sync_events")).isEqualTo(1);
        assertThat(count("sync_notification_outbox")).isEqualTo(1);
    }

    @Test
    void competingDevicesAtTheSameBaseVersionProduceOneConflict() throws Exception {
        var companionId = UUID.randomUUID();
        jdbc.update("""
            INSERT INTO sync_devices (
                device_id, account_id, device_public_key, device_role, device_status,
                registered_at, last_seen_at, created_protocol_version
            ) VALUES (?, ?, ?, 'COMPANION', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 2)
            """, companionId, accountId, Base64.getDecoder().decode(publicKey()));
        jdbc.update("""
            INSERT INTO sync_device_cursors (account_id, device_id, last_applied_sequence, last_acknowledged_at)
            VALUES (?, ?, 0, CURRENT_TIMESTAMP)
            """, accountId, companionId);
        var recordId = UUID.randomUUID();
        var first = initiate(deviceId, recordId, 0);
        var second = initiate(companionId, recordId, 0);
        objectStore.markUploaded(first.objectKey());
        objectStore.markUploaded(second.objectKey());

        commits.commit("commit-user", first.operationId());
        assertApiCode(() -> commits.commit("commit-user", second.operationId()), "RECORD_VERSION_CONFLICT");

        assertThat(count("sync_events")).isEqualTo(1);
        assertThat(count("sync_notification_outbox")).isEqualTo(1);
        assertThat(queries.find("commit-user", second.operationId()).status()).isEqualTo("CONFLICT");
    }

    @Test
    void missingObjectRollsBackEveryAuthoritativeCommitSideEffect() {
        var operation = initiate(deviceId, UUID.randomUUID(), 0);

        assertApiCode(() -> commits.commit("commit-user", operation.operationId()), "OBJECT_MISSING");

        assertThat(count("sync_events")).isZero();
        assertThat(count("sync_record_versions")).isZero();
        assertThat(count("sync_notification_outbox")).isZero();
        assertThat(queries.find("commit-user", operation.operationId()).status()).isEqualTo("OBJECTS_PENDING");
    }

    @Test
    void commitRechecksDeviceProtocolAndWriteKillSwitch() {
        var revoked = initiate(deviceId, UUID.randomUUID(), 0);
        objectStore.markUploaded(revoked.objectKey());
        jdbc.update("UPDATE sync_devices SET device_status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP WHERE device_id = ?", deviceId);
        assertApiCode(() -> commits.commit("commit-user", revoked.operationId()), "DEVICE_REVOKED");
        jdbc.update("UPDATE sync_devices SET device_status = 'ACTIVE', revoked_at = NULL WHERE device_id = ?", deviceId);

        var disabled = initiate(deviceId, UUID.randomUUID(), 0);
        objectStore.markUploaded(disabled.objectKey());
        jdbc.update("UPDATE sync_kill_switches SET engaged = TRUE, reason_code = 'TEST' WHERE switch_name = 'SYNC_WRITES'");
        assertApiCode(() -> commits.commit("commit-user", disabled.operationId()), "SYNC_WRITES_DISABLED");
        jdbc.update("UPDATE sync_kill_switches SET engaged = FALSE, reason_code = NULL WHERE switch_name = 'SYNC_WRITES'");

        var incompatible = initiate(deviceId, UUID.randomUUID(), 0);
        objectStore.markUploaded(incompatible.objectKey());
        jdbc.update("UPDATE sync_accounts SET minimum_write_protocol = 3 WHERE account_id = ?", accountId);
        assertApiCode(() -> commits.commit("commit-user", incompatible.operationId()), "PROTOCOL_INCOMPATIBLE");

        assertThat(count("sync_events")).isZero();
        assertThat(count("sync_notification_outbox")).isZero();
    }

    private Initiated initiate(UUID committingDeviceId, UUID recordId, long baseVersion) {
        var operationId = UUID.randomUUID();
        var objectKey = keys.create(accountId);
        initiation.initiate("commit-user", new InitiateOperationRequest(
            operationId, committingDeviceId, "ENTRY", recordId, "UPSERT", baseVersion,
            2, 2, 1, "2026-07", List.of(new OperationObjectRequest(
                objectKey.value(), "EVENT", "a".repeat(64), 512))));
        return new Initiated(operationId, objectKey);
    }

    private long count(String table) {
        return jdbc.queryForObject("SELECT count(*) FROM " + table, Long.class);
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

    private record Initiated(UUID operationId, ObjectKey objectKey) {}
}
