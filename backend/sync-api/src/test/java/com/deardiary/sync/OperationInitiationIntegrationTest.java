package com.deardiary.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.device.DeviceRegistrationRequest;
import com.deardiary.sync.device.DeviceRegistrationService;
import com.deardiary.sync.objectstore.InMemoryEncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKeyFactory;
import com.deardiary.sync.operation.InitiateOperationRequest;
import com.deardiary.sync.operation.OperationInitiationService;
import com.deardiary.sync.operation.OperationObjectRequest;
import com.deardiary.sync.operation.RetainedMediaObjectRequest;
import com.deardiary.sync.protocol.ProtocolService;
import java.security.KeyPairGenerator;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Callable;
import com.deardiary.sync.operation.InitiateOperationResponse;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@Testcontainers(disabledWithoutDocker = true)
class OperationInitiationIntegrationTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16.9-alpine");
    private static JdbcTemplate jdbc;
    private static OperationInitiationService operations;
    private static ObjectKeyFactory keys;
    private static UUID deviceId;
    private static UUID accountId;

    @BeforeAll
    static void setup() throws Exception {
        var dataSource = new DriverManagerDataSource(
            POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        Flyway.configure().dataSource(dataSource).load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        var transactionManager = new DataSourceTransactionManager(dataSource);
        var devices = new DeviceAuthorizationService(jdbc);
        var registrations = new DeviceRegistrationService(jdbc, transactionManager, Clock.systemUTC());
        deviceId = UUID.randomUUID();
        accountId = registrations.register("operation-user", new DeviceRegistrationRequest(
            deviceId, publicKey(), "PRIMARY", 2, "test")).accountId();
        keys = new ObjectKeyFactory();
        operations = new OperationInitiationService(
            jdbc, transactionManager, devices, new ProtocolService(jdbc), keys,
            new InMemoryEncryptedObjectStore(), Clock.systemUTC(),
            new com.deardiary.sync.quota.QuotaService(jdbc,
                new com.deardiary.sync.account.AccountAuthorizationService(jdbc)));
    }

    @Test
    void duplicateInitiationReturnsTheExistingMatchingOperation() {
        var request = request(UUID.randomUUID(), "note-" + UUID.randomUUID(), keys.create(accountId).value(), 512);

        var first = operations.initiate("operation-user", request);
        var repeated = operations.initiate("operation-user", request);

        assertThat(first.existing()).isFalse();
        assertThat(repeated.existing()).isTrue();
        assertThat(repeated.status()).isEqualTo("OBJECTS_PENDING");
        assertThat(repeated.uploads()).hasSize(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM sync_operations WHERE operation_id = ?", Long.class, request.operationId()))
            .isEqualTo(1);
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM sync_operation_objects WHERE operation_id = ?", Long.class, request.operationId()))
            .isEqualTo(1);

        var mismatched = request(request.operationId(), UUID.randomUUID(), request.objects().getFirst().objectKey(), 512);
        assertApiCode(() -> operations.initiate("operation-user", mismatched), "IDEMPOTENCY_MISMATCH");
    }

    @Test
    void initiationRejectsForeignNamespacesOversizedEventsAndDisabledWrites() {
        var foreignKey = keys.create(UUID.randomUUID()).value();
        assertApiCode(
            () -> operations.initiate("operation-user", request(UUID.randomUUID(), UUID.randomUUID(), foreignKey, 512)),
            "INVALID_OBJECT_KEY");

        var largeKey = keys.create(accountId).value();
        assertApiCode(
            () -> operations.initiate("operation-user", request(
                UUID.randomUUID(), UUID.randomUUID(), largeKey, 10_485_761)),
            "OBJECT_TOO_LARGE");

        jdbc.update("UPDATE sync_kill_switches SET engaged = TRUE, reason_code = 'TEST' WHERE switch_name = 'SYNC_WRITES'");
        var disabledKey = keys.create(accountId).value();
        assertApiCode(
            () -> operations.initiate("operation-user", request(
                UUID.randomUUID(), UUID.randomUUID(), disabledKey, 512)),
            "SYNC_WRITES_DISABLED");
        jdbc.update("UPDATE sync_kill_switches SET engaged = FALSE, reason_code = NULL WHERE switch_name = 'SYNC_WRITES'");
    }

    @Test
    void mediaInitiationHonorsTheFeatureFlagAndRejectsNonLiveRetainedObjects() {
        var eventKey = keys.create(accountId).value();
        var mediaKey = keys.create(accountId).value();
        jdbc.update("UPDATE sync_kill_switches SET engaged = TRUE, reason_code = 'TEST' WHERE switch_name = 'MEDIA_UPLOAD'");
        assertApiCode(() -> operations.initiate("operation-user", new InitiateOperationRequest(
            UUID.randomUUID(), deviceId, "ENTRY", UUID.randomUUID().toString(), "UPSERT", 0,
            3, 2, 1, "account", List.of(
                new OperationObjectRequest(eventKey, "EVENT", "a".repeat(64), 512),
                new OperationObjectRequest(mediaKey, "MEDIA", "b".repeat(64), 1024)),
            List.of())), "MEDIA_UPLOAD_DISABLED");
        jdbc.update("UPDATE sync_kill_switches SET engaged = FALSE, reason_code = NULL WHERE switch_name = 'MEDIA_UPLOAD'");

        assertApiCode(() -> operations.initiate("operation-user", new InitiateOperationRequest(
            UUID.randomUUID(), deviceId, "ENTRY", UUID.randomUUID().toString(), "UPSERT", 0,
            3, 2, 1, "account", List.of(
                new OperationObjectRequest(keys.create(accountId).value(), "EVENT", "c".repeat(64), 512)),
            List.of(new RetainedMediaObjectRequest(keys.create(accountId).value(), "MEDIA")))),
            "INVALID_MEDIA_REFERENCE");
    }

    @Test
    void concurrentDuplicateInitiationCreatesOneMatchingOperation() throws Exception {
        var request = request(UUID.randomUUID(), UUID.randomUUID(), keys.create(accountId).value(), 512);
        try (var executor = Executors.newFixedThreadPool(2)) {
            var futures = executor.invokeAll(List.<Callable<InitiateOperationResponse>>of(
                () -> operations.initiate("operation-user", request),
                () -> operations.initiate("operation-user", request)));
            var responses = futures.stream().map(future -> {
                try { return future.get(); } catch (Exception error) { throw new RuntimeException(error); }
            }).toList();
            assertThat(responses).extracting(response -> response.existing())
                .containsExactlyInAnyOrder(false, true);
        }
        assertThat(jdbc.queryForObject(
            "SELECT count(*) FROM sync_operations WHERE operation_id = ?", Long.class, request.operationId()))
            .isEqualTo(1);
    }

    @Test
    void accountPlanEnforcesSeparateEntryMediaAndProjectedStorageLimits() {
        jdbc.update("UPDATE sync_plans SET maximum_photos_per_entry = 1 WHERE plan_id = 'default'");
        try {
            var overMedia = new InitiateOperationRequest(
                UUID.randomUUID(), deviceId, "ENTRY", UUID.randomUUID().toString(), "UPSERT", 0,
                3, 2, 1, "account",
                List.of(new OperationObjectRequest(
                    keys.create(accountId).value(), "EVENT", "d".repeat(64), 128)),
                List.of(), new InitiateOperationRequest.EntryMediaCounts(2, 0));
            assertApiCode(() -> operations.initiate("operation-user", overMedia),
                "ENTRY_MEDIA_LIMIT_EXCEEDED");

            var grandfatheredRecordId = UUID.randomUUID().toString();
            jdbc.update("""
                INSERT INTO sync_record_versions (
                    account_id, record_type, record_id, current_version, last_sequence, deleted,
                    entry_photo_count, entry_recording_count, updated_at
                ) VALUES (?, 'ENTRY', ?, 5, 5, FALSE, 5, 0, CURRENT_TIMESTAMP)
                """, accountId, grandfatheredRecordId);
            var unchangedExistingMedia = new InitiateOperationRequest(
                UUID.randomUUID(), deviceId, "ENTRY", grandfatheredRecordId, "UPSERT", 5,
                3, 2, 1, "account",
                List.of(new OperationObjectRequest(
                    keys.create(accountId).value(), "EVENT", "f".repeat(64), 128)),
                List.of(), new InitiateOperationRequest.EntryMediaCounts(5, 0));
            assertThat(operations.initiate("operation-user", unchangedExistingMedia).existing()).isFalse();

            var growingExistingMedia = new InitiateOperationRequest(
                UUID.randomUUID(), deviceId, "ENTRY", grandfatheredRecordId, "UPSERT", 5,
                3, 2, 1, "account",
                List.of(new OperationObjectRequest(
                    keys.create(accountId).value(), "EVENT", "9".repeat(64), 128)),
                List.of(), new InitiateOperationRequest.EntryMediaCounts(6, 0));
            assertApiCode(() -> operations.initiate("operation-user", growingExistingMedia),
                "ENTRY_MEDIA_LIMIT_EXCEEDED");
        } finally {
            jdbc.update("UPDATE sync_plans SET maximum_photos_per_entry = 3 WHERE plan_id = 'default'");
        }

        var used = jdbc.queryForObject("""
            SELECT COALESCE(sum(size_bytes), 0) FROM sync_objects
            WHERE account_id = ? AND storage_status <> 'DELETED'
            """, Long.class, accountId);
        jdbc.update("UPDATE sync_plans SET maximum_storage_bytes = ? WHERE plan_id = 'default'", used + 100);
        try {
            assertApiCode(() -> operations.initiate("operation-user", request(
                UUID.randomUUID(), UUID.randomUUID(), keys.create(accountId).value(), 101)),
                "STORAGE_QUOTA_EXCEEDED");

            var deleteRequest = new InitiateOperationRequest(
                UUID.randomUUID(), deviceId, "ENTRY", UUID.randomUUID().toString(), "DELETE", 0,
                3, 2, 1, "account",
                List.of(new OperationObjectRequest(
                    keys.create(accountId).value(), "EVENT", "e".repeat(64), 101)));
            assertThat(operations.initiate("operation-user", deleteRequest).existing()).isFalse();
        } finally {
            jdbc.update("UPDATE sync_plans SET maximum_storage_bytes = 524288000 WHERE plan_id = 'default'");
        }
    }

    private static InitiateOperationRequest request(UUID operationId, UUID recordId, String objectKey, long size) {
        return request(operationId, recordId.toString(), objectKey, size);
    }

    private static InitiateOperationRequest request(UUID operationId, String recordId, String objectKey, long size) {
        return new InitiateOperationRequest(
            operationId, deviceId, "ENTRY", recordId, "UPSERT", 0,
            3, 2, 1, "2026-07",
            List.of(new OperationObjectRequest(objectKey, "EVENT", "a".repeat(64), size)));
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
