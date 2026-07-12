package com.deardiary.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.device.DeviceRegistrationRequest;
import com.deardiary.sync.device.DeviceRegistrationService;
import com.deardiary.sync.protocol.ProtocolService;
import java.security.KeyPairGenerator;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Base64;
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
class DeviceAndProtocolIntegrationTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16.9-alpine");
    private static JdbcTemplate jdbc;
    private static DeviceRegistrationService registrations;
    private static DeviceAuthorizationService authorization;
    private static ProtocolService protocols;

    @BeforeAll
    static void migrate() {
        var dataSource = new DriverManagerDataSource(
            POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        Flyway.configure().dataSource(dataSource).load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        registrations = new DeviceRegistrationService(
            jdbc,
            new DataSourceTransactionManager(dataSource),
            Clock.fixed(Instant.parse("2026-07-12T12:00:00Z"), ZoneOffset.UTC));
        authorization = new DeviceAuthorizationService(jdbc);
        protocols = new ProtocolService(jdbc);
    }

    @Test
    void registrationIsIdempotentAndAuthorizationIsOwnerAndStatusBound() throws Exception {
        var deviceId = UUID.randomUUID();
        var request = new DeviceRegistrationRequest(
            deviceId, publicKey(), "PRIMARY", 2, "test-1.0.0");

        var created = registrations.register("user-device-test", request);
        var repeated = registrations.register("user-device-test", request);

        assertThat(created.created()).isTrue();
        assertThat(repeated.created()).isFalse();
        assertThat(repeated.accountId()).isEqualTo(created.accountId());
        assertThat(authorization.requireActiveDevice("user-device-test", deviceId).accountId())
            .isEqualTo(created.accountId());
        assertApiCode(
            () -> authorization.requireActiveDevice("another-user", deviceId),
            "DEVICE_NOT_FOUND");

        var mismatched = new DeviceRegistrationRequest(
            deviceId, publicKey(), "PRIMARY", 2, "test-1.0.0");
        assertApiCode(() -> registrations.register("user-device-test", mismatched), "IDEMPOTENCY_MISMATCH");

        var secondDevice = new DeviceRegistrationRequest(
            UUID.randomUUID(), publicKey(), "PRIMARY", 2, "test-1.0.0");
        assertApiCode(
            () -> registrations.register("user-device-test", secondDevice),
            "DEVICE_REGISTRATION_REQUIRES_PAIRING");

        jdbc.update("""
            UPDATE sync_devices SET device_status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP
            WHERE device_id = ?
            """, deviceId);
        assertApiCode(() -> authorization.requireActiveDevice("user-device-test", deviceId), "DEVICE_REVOKED");
        assertApiCode(() -> registrations.register("user-device-test", request), "DEVICE_REVOKED");
    }

    @Test
    void protocolConfigurationCombinesPersistentFlagsWithKillSwitches() {
        var protocol = protocols.current();

        assertThat(protocol.currentProtocolVersion()).isEqualTo(2);
        assertThat(protocol.maximumEventBytes()).isEqualTo(10_485_760);
        assertThat(protocol.featureFlags().syncWritesEnabled()).isTrue();
        assertThat(protocol.featureFlags().snapshotCreationEnabled()).isFalse();
        assertThat(protocol.featureFlags().garbageCollectionEnabled()).isFalse();
        assertThat(protocol.featureFlags().keyRotationEnabled()).isFalse();

        jdbc.update("UPDATE sync_kill_switches SET engaged = TRUE, reason_code = 'TEST' WHERE switch_name = 'SYNC_WRITES'");
        assertThat(protocols.current().featureFlags().syncWritesEnabled()).isFalse();
    }

    private static String publicKey() throws Exception {
        var generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(256);
        return Base64.getEncoder().encodeToString(generator.generateKeyPair().getPublic().getEncoded());
    }

    private static void assertApiCode(ThrowingAction action, String code) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.code()).isEqualTo(code));
    }

    @FunctionalInterface
    private interface ThrowingAction {
        void run() throws Exception;
    }
}
