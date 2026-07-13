package com.deardiary.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.device.DeviceRegistrationRequest;
import com.deardiary.sync.device.DeviceRegistrationService;
import com.deardiary.sync.migration.AdvanceMigrationRequest;
import com.deardiary.sync.migration.BeginMigrationRequest;
import com.deardiary.sync.migration.MigrationService;
import com.deardiary.sync.keypackage.KeyPackageRequest;
import com.deardiary.sync.keypackage.KeyPackageService;
import com.deardiary.sync.objectstore.InMemoryEncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectKeyFactory;
import com.deardiary.sync.pairing.PairingRequests;
import com.deardiary.sync.pairing.PairingService;
import com.deardiary.sync.protocol.ProtocolService;
import com.deardiary.sync.recovery.RecoveryRequests;
import com.deardiary.sync.recovery.RecoveryService;
import com.deardiary.sync.rotation.RotationRequests;
import com.deardiary.sync.rotation.RotationService;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.HexFormat;
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
class AdvancedWorkflowIntegrationTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16.9-alpine");
    private static JdbcTemplate jdbc;
    private static DataSourceTransactionManager transactions;
    private final Clock clock = Clock.systemUTC();
    private KeyPair primaryKey;
    private UUID primaryDeviceId;
    private UUID accountId;
    private DeviceAuthorizationService devices;
    private AccountAuthorizationService accounts;

    @BeforeAll
    static void migrate() {
        var dataSource = new DriverManagerDataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
        Flyway.configure().dataSource(dataSource).load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        transactions = new DataSourceTransactionManager(dataSource);
    }

    @BeforeEach
    void reset() throws Exception {
        jdbc.execute("TRUNCATE TABLE sync_accounts CASCADE");
        jdbc.update("UPDATE sync_protocol_config SET companion_pairing_enabled = TRUE WHERE config_id = 1");
        jdbc.update("UPDATE sync_kill_switches SET engaged = FALSE, reason_code = NULL WHERE switch_name = 'COMPANION_PAIRING'");
        primaryKey = KeyPairGenerator.getInstance("EC").generateKeyPair();
        primaryDeviceId = UUID.randomUUID();
        var registrations = new DeviceRegistrationService(jdbc, transactions, clock);
        accountId = registrations.register("advanced-user", new DeviceRegistrationRequest(
            primaryDeviceId, Base64.getEncoder().encodeToString(primaryKey.getPublic().getEncoded()),
            "PRIMARY", 2, "test")).accountId();
        devices = new DeviceAuthorizationService(jdbc);
        accounts = new AccountAuthorizationService(jdbc);
    }

    @Test
    void cryptographicPairingActivatesCompanionOnlyAfterVerifiedPackageAndPossessionProof() throws Exception {
        var objectStore = new InMemoryEncryptedObjectStore();
        var pairings = new PairingService(jdbc, transactions, accounts, devices, new ProtocolService(jdbc),
            new ObjectKeyFactory(), objectStore, clock);
        var companionKey = KeyPairGenerator.getInstance("EC").generateKeyPair();
        var pairingId = UUID.randomUUID();
        var companionId = UUID.randomUUID();
        var challenge = new byte[32];
        java.security.SecureRandom.getInstanceStrong().nextBytes(challenge);
        var code = "12345678";
        var codeHash = sha256(code.getBytes(StandardCharsets.UTF_8));
        pairings.create("advanced-user", new PairingRequests.Create(pairingId, companionId,
            Base64.getEncoder().encodeToString(companionKey.getPublic().getEncoded()), "test", codeHash,
            Base64.getEncoder().encodeToString(challenge)));
        var approvalMessage = pairingId + ":" + companionId + ":" + Base64.getEncoder().encodeToString(challenge) + ":" + codeHash;
        var approved = pairings.approve("advanced-user", pairingId, new PairingRequests.Approve(
            primaryDeviceId, code, sign(primaryKey, approvalMessage), UUID.randomUUID(), "a".repeat(64), 7, 1));
        assertThat(jdbc.queryForObject("SELECT device_status FROM sync_devices WHERE device_id = ?", String.class, companionId))
            .isEqualTo("RECOVERY_PENDING");
        objectStore.markUploaded(new ObjectKey(approved.objectKey()));
        var available = pairings.registerPackage("advanced-user", pairingId, primaryDeviceId);
        var completion = "pairing-complete:" + pairingId + ":" + available.keyPackageId();
        pairings.complete("advanced-user", pairingId, new PairingRequests.Complete(companionId,
            sign(companionKey, completion)));
        assertThat(jdbc.queryForObject("SELECT device_status FROM sync_devices WHERE device_id = ?", String.class, companionId))
            .isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("SELECT pairing_status FROM sync_pairing_requests", String.class))
            .isEqualTo("COMPLETED");
    }

    @Test
    void migrationRequiresVerifiedSnapshotAndPermanentlyClosesRollbackAfterV2Mutation() {
        var migrations = new MigrationService(jdbc, transactions, devices, clock);
        var migrationId = UUID.randomUUID();
        var digest = "b".repeat(64);
        migrations.begin("advanced-user", new BeginMigrationRequest(migrationId, primaryDeviceId, digest, 0));
        advance(migrations, migrationId, "DRAINING_V1", null, null);
        advance(migrations, migrationId, "VALIDATING_LOCAL_STATE", null, null);
        advance(migrations, migrationId, "CREATING_V2_SNAPSHOT", digest, null);
        advance(migrations, migrationId, "UPLOADING_V2_SNAPSHOT", digest, null);
        advance(migrations, migrationId, "REGISTERING_V2_ACCOUNT", digest, null);
        assertThatThrownBy(() -> advance(migrations, migrationId, "VERIFYING_V2_RESTORE", digest, UUID.randomUUID()))
            .isInstanceOf(ApiException.class).extracting(error -> ((ApiException) error).code())
            .isEqualTo("SNAPSHOT_NOT_FOUND");
        var snapshotId = insertAvailableSnapshot();
        advance(migrations, migrationId, "VERIFYING_V2_RESTORE", digest, snapshotId);
        advance(migrations, migrationId, "V2_ACTIVE", digest, snapshotId);
        jdbc.update("UPDATE sync_accounts SET current_sequence = 1 WHERE account_id = ?", accountId);
        assertThatThrownBy(() -> migrations.rollback("advanced-user", migrationId, primaryDeviceId))
            .isInstanceOf(ApiException.class).extracting(error -> ((ApiException) error).code())
            .isEqualTo("MIGRATION_ROLLBACK_UNAVAILABLE");
    }

    @Test
    void recoveryRevokesOldPrimaryOnlyAfterKeyProofSnapshotAndCursorValidation() throws Exception {
        enable("primary_recovery_enabled", "PRIMARY_RECOVERY");
        var objectStore = new InMemoryEncryptedObjectStore();
        var protocols = new ProtocolService(jdbc);
        var packages = new KeyPackageService(jdbc, transactions, devices, accounts,
            new ObjectKeyFactory(), objectStore, clock, protocols);
        createAndRegisterPackage(packages, objectStore, UUID.randomUUID(), primaryDeviceId, 1,
            "RECOVERY", null);
        var recovery = new RecoveryService(jdbc, transactions, accounts, protocols, packages, clock);
        var recoveredKey = KeyPairGenerator.getInstance("EC").generateKeyPair();
        var recoveredDevice = UUID.randomUUID();
        var attempt = UUID.randomUUID();
        recovery.begin("advanced-user", new RecoveryRequests.Begin(attempt, recoveredDevice,
            Base64.getEncoder().encodeToString(recoveredKey.getPublic().getEncoded()), "test"));
        recovery.approve("advanced-user", attempt, recoveredDevice);
        assertThat(recovery.packageForRecovery("advanced-user", attempt, recoveredDevice).status())
            .isEqualTo("KEY_PACKAGE_AVAILABLE");
        var snapshotId = insertAvailableSnapshot();
        recovery.markLocalKeyPersisted("advanced-user", attempt, new RecoveryRequests.Persisted(
            recoveredDevice, snapshotId, sign(recoveredKey, "recovery-key-persisted:" + attempt + ":" + snapshotId)));
        assertThat(recovery.finalizeRecovery("advanced-user", attempt, recoveredDevice).status()).isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject("SELECT device_status FROM sync_devices WHERE device_id = ?", String.class, primaryDeviceId))
            .isEqualTo("REVOKED");
        assertThat(jdbc.queryForObject("SELECT device_status FROM sync_devices WHERE device_id = ?", String.class, recoveredDevice))
            .isEqualTo("ACTIVE");
    }

    @Test
    void rotationAdvancesEpochOnlyAfterActiveDeviceAndRecoveryPackagesAreAvailable() throws Exception {
        enable("key_rotation_enabled", "KEY_ROTATION");
        var objectStore = new InMemoryEncryptedObjectStore();
        var protocols = new ProtocolService(jdbc);
        var packages = new KeyPackageService(jdbc, transactions, devices, accounts,
            new ObjectKeyFactory(), objectStore, clock, protocols);
        var rotations = new RotationService(jdbc, transactions, devices, protocols, clock);
        var rotationId = UUID.randomUUID();
        rotations.begin("advanced-user", new RotationRequests.Begin(rotationId, primaryDeviceId));
        rotations.advance("advanced-user", rotationId, new RotationRequests.Advance(primaryDeviceId, "NEW_KEY_CREATED"));
        createAndRegisterPackage(packages, objectStore, UUID.randomUUID(), primaryDeviceId, 2, "DEVICE", rotationId);
        createAndRegisterPackage(packages, objectStore, UUID.randomUUID(), primaryDeviceId, 2, "RECOVERY", rotationId);
        rotations.advance("advanced-user", rotationId, new RotationRequests.Advance(primaryDeviceId, "KEY_PACKAGES_CREATED"));
        rotations.advance("advanced-user", rotationId, new RotationRequests.Advance(primaryDeviceId, "SERVER_EPOCH_PENDING"));
        rotations.commitServerEpoch("advanced-user", rotationId, primaryDeviceId);
        assertThat(jdbc.queryForObject("SELECT current_key_epoch FROM sync_accounts WHERE account_id = ?", Integer.class, accountId))
            .isEqualTo(2);
        rotations.localCommitted("advanced-user", rotationId, new RotationRequests.LocalCommitted(primaryDeviceId,
            sign(primaryKey, "rotation-local-committed:" + rotationId + ":2")));
        var completed = rotations.advance("advanced-user", rotationId,
            new RotationRequests.Advance(primaryDeviceId, "COMPLETED"));
        assertThat(completed.status()).isEqualTo("COMPLETED");
    }

    private void advance(MigrationService service, UUID id, String status, String digest, UUID snapshotId) {
        service.advance("advanced-user", id, new AdvanceMigrationRequest(primaryDeviceId, status, digest, snapshotId));
    }

    private UUID insertAvailableSnapshot() {
        var snapshotId = UUID.randomUUID();
        var key = new ObjectKeyFactory().create(accountId).value();
        var now = OffsetDateTime.now(clock);
        jdbc.update("""
            INSERT INTO sync_objects (account_id, object_key, object_kind, sha256, size_bytes, key_epoch,
                storage_status, created_sequence, created_at, updated_at)
            VALUES (?, ?, 'SNAPSHOT', ?, 1, 1, 'COMMITTED', 1, ?, ?)
            """, accountId, key, "c".repeat(64), now, now);
        jdbc.update("""
            INSERT INTO sync_snapshots (account_id, snapshot_id, sequence, partition_key, object_key,
                sha256, size_bytes, key_epoch, snapshot_schema_version, snapshot_status, created_at, created_by_device_id)
            VALUES (?, ?, 0, 'account', ?, ?, 1, 1, 2, 'AVAILABLE', ?, ?)
            """, accountId, snapshotId, key, "c".repeat(64), now, primaryDeviceId);
        return snapshotId;
    }

    private void createAndRegisterPackage(KeyPackageService packages, InMemoryEncryptedObjectStore objectStore,
            UUID packageId, UUID target, int epoch, String purpose, UUID rotationId) {
        var initiated = packages.initiate("advanced-user", new KeyPackageRequest(packageId, primaryDeviceId,
            target, epoch, purpose, "d".repeat(64), 9, 1, rotationId, null));
        objectStore.markUploaded(new ObjectKey(initiated.objectKey()));
        packages.register("advanced-user", packageId, primaryDeviceId);
    }

    private void enable(String column, String switchName) {
        jdbc.update("UPDATE sync_protocol_config SET " + column + " = TRUE WHERE config_id = 1");
        jdbc.update("UPDATE sync_kill_switches SET engaged = FALSE, reason_code = NULL WHERE switch_name = ?", switchName);
    }

    private String sign(KeyPair key, String message) throws Exception {
        var signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign(key.getPrivate());
        signature.update(message.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(signature.sign());
    }

    private String sha256(byte[] value) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
    }
}
