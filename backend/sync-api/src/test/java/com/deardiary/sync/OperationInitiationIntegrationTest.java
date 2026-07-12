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
import com.deardiary.sync.protocol.ProtocolService;
import java.security.KeyPairGenerator;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
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
            new InMemoryEncryptedObjectStore(), Clock.systemUTC());
    }

    @Test
    void duplicateInitiationReturnsTheExistingMatchingOperation() {
        var request = request(UUID.randomUUID(), UUID.randomUUID(), keys.create(accountId).value(), 512);

        var first = operations.initiate("operation-user", request);
        var repeated = operations.initiate("operation-user", request);

        assertThat(first.existing()).isFalse();
        assertThat(repeated.existing()).isTrue();
        assertThat(repeated.status()).isEqualTo("OBJECTS_PENDING");
        assertThat(repeated.uploads()).hasSize(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM sync_operations", Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM sync_operation_objects", Long.class)).isEqualTo(1);

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

    private static InitiateOperationRequest request(UUID operationId, UUID recordId, String objectKey, long size) {
        return new InitiateOperationRequest(
            operationId, deviceId, "ENTRY", recordId, "UPSERT", 0,
            2, 2, 1, "2026-07",
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
