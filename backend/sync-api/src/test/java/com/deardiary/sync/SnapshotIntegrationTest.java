package com.deardiary.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.deardiary.sync.account.AccountAuthorizationService;
import com.deardiary.sync.bootstrap.BootstrapRequests;
import com.deardiary.sync.bootstrap.BootstrapService;
import com.deardiary.sync.common.ApiException;
import com.deardiary.sync.cursor.CursorService;
import com.deardiary.sync.device.DeviceAuthorizationService;
import com.deardiary.sync.device.DeviceRegistrationRequest;
import com.deardiary.sync.device.DeviceRegistrationService;
import com.deardiary.sync.objectstore.InMemoryEncryptedObjectStore;
import com.deardiary.sync.objectstore.ObjectKey;
import com.deardiary.sync.objectstore.ObjectKeyFactory;
import com.deardiary.sync.protocol.ProtocolService;
import com.deardiary.sync.snapshot.InitiateSnapshotRequest;
import com.deardiary.sync.snapshot.InitiateSnapshotResponse;
import com.deardiary.sync.snapshot.SnapshotService;
import com.deardiary.sync.snapshot.SnapshotResponse;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.time.Clock;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
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
    private DataSourceTransactionManager transactions;
    private SnapshotService snapshots;
    private InMemoryEncryptedObjectStore objectStore;
    private UUID accountId;
    private UUID deviceId;
    private KeyPair deviceKey;

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
        transactions = new DataSourceTransactionManager(dataSource);
        var registrations = new DeviceRegistrationService(jdbc, transactions, Clock.systemUTC());
        deviceId = UUID.randomUUID();
        deviceKey = KeyPairGenerator.getInstance("EC").generateKeyPair();
        accountId = registrations.register("snapshot-user", new DeviceRegistrationRequest(
            deviceId, Base64.getEncoder().encodeToString(deviceKey.getPublic().getEncoded()),
            "PRIMARY", 2, "test")).accountId();
        objectStore = new InMemoryEncryptedObjectStore();
        snapshots = new SnapshotService(jdbc, transactions,
            new DeviceAuthorizationService(jdbc), new AccountAuthorizationService(jdbc),
            new ProtocolService(jdbc), new ObjectKeyFactory(), objectStore, Clock.systemUTC(),
            new com.deardiary.sync.quota.QuotaService(jdbc, new AccountAuthorizationService(jdbc)));
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
            512, 1, 2, 3, null);
        assertApiCode(() -> snapshots.initiate("snapshot-user", changed), "IDEMPOTENCY_MISMATCH");
        assertApiCode(() -> snapshots.initiate("snapshot-user", request(UUID.randomUUID(), 0)),
            "SNAPSHOT_SEQUENCE_EXISTS");

        jdbc.update("UPDATE sync_kill_switches SET engaged = TRUE, reason_code = 'TEST' WHERE switch_name = 'SNAPSHOT_CREATION'");
        assertApiCode(() -> snapshots.initiate("snapshot-user", request(UUID.randomUUID(), 0)), "SNAPSHOT_CREATION_DISABLED");
    }

    @Test
    void chunkedSnapshotRegistersOnlyAfterEveryChunkIsVerified() throws Exception {
        var snapshotId = UUID.randomUUID();
        var chunks = List.of(
            new InitiateSnapshotRequest.Chunk(0, "a".repeat(64), 256),
            new InitiateSnapshotRequest.Chunk(1, "b".repeat(64), 384));
        var request = new InitiateSnapshotRequest(
            snapshotId, deviceId, 0, "account", chunkDigest(chunks), 640,
            1, 2, 3, null, chunks);

        var initiated = snapshots.initiate("snapshot-user", request);
        assertThat(initiated.uploads()).hasSize(2);
        objectStore.markUploaded(new ObjectKey(initiated.uploads().getFirst().objectKey()));
        var resumed = snapshots.initiate("snapshot-user", request);
        assertThat(resumed.uploads()).extracting(InitiateSnapshotResponse.Upload::uploaded)
            .containsExactly(true, false);
        assertApiCode(() -> snapshots.register("snapshot-user", snapshotId, deviceId), "OBJECT_MISSING");

        objectStore.markUploaded(new ObjectKey(initiated.uploads().get(1).objectKey()));
        var registered = snapshots.register("snapshot-user", snapshotId, deviceId);
        var latest = snapshots.latest("snapshot-user", "account", 2);

        assertThat(registered.status()).isEqualTo("AVAILABLE");
        assertThat(latest.chunks()).hasSize(2);
        assertThat(latest.chunks()).extracting(SnapshotResponse.Chunk::index).containsExactly(0, 1);
        assertThat(latest.chunks()).allSatisfy(chunk ->
            assertThat(chunk.downloadUrl()).contains("/download/"));
        assertThat(jdbc.queryForObject("SELECT count(*) FROM sync_object_references", Long.class))
            .isEqualTo(2);
        assertThat(jdbc.queryForObject("""
            SELECT count(*) FROM sync_objects WHERE storage_status = 'COMMITTED'
            """, Long.class)).isEqualTo(2);
    }

    @Test
    void staleActiveDeviceCanRebootstrapFromPinnedSnapshotAndAcknowledgeItsHead() throws Exception {
        var request = request(UUID.randomUUID(), 0);
        var initiated = snapshots.initiate("snapshot-user", request);
        objectStore.markUploaded(new ObjectKey(initiated.upload().objectKey()));
        snapshots.register("snapshot-user", request.snapshotId(), deviceId);
        jdbc.update("""
            UPDATE sync_protocol_config SET bootstrap_manifest_enabled = TRUE,
                remote_pull_enabled = TRUE WHERE config_id = 1
            """);
        jdbc.update("UPDATE sync_accounts SET current_sequence = 7 WHERE account_id = ?", accountId);
        jdbc.update("""
            UPDATE sync_device_cursors SET last_applied_sequence = 7
            WHERE account_id = ? AND device_id = ?
            """, accountId, deviceId);
        jdbc.update("""
            UPDATE sync_devices SET rebootstrap_required = TRUE
            WHERE account_id = ? AND device_id = ?
            """, accountId, deviceId);

        var devices = new DeviceAuthorizationService(jdbc);
        var bootstraps = new BootstrapService(jdbc, transactions,
            new AccountAuthorizationService(jdbc), devices, new ProtocolService(jdbc),
            objectStore, Clock.systemUTC());
        var bootstrapId = UUID.randomUUID();
        var manifest = bootstraps.create("snapshot-user",
            new BootstrapRequests.Create(bootstrapId, deviceId, null));

        assertThat(manifest.snapshot().throughSequence()).isZero();
        assertThat(manifest.headSequence()).isEqualTo(7);
        assertThat(jdbc.queryForObject("""
            SELECT last_applied_sequence FROM sync_device_cursors
            WHERE account_id = ? AND device_id = ?
            """, Long.class, accountId, deviceId)).isZero();

        var cursors = new CursorService(jdbc, transactions, devices, Clock.systemUTC());
        assertThat(cursors.acknowledge("snapshot-user", deviceId, 7).lastAppliedSequence())
            .isEqualTo(7);
        var proof = sign("bootstrap-complete:" + bootstrapId + ":7");
        var completed = bootstraps.complete("snapshot-user", bootstrapId,
            new BootstrapRequests.Complete(deviceId, 7, proof));

        assertThat(completed.status()).isEqualTo("COMPLETED");
        assertThat(jdbc.queryForObject("""
            SELECT rebootstrap_required FROM sync_devices
            WHERE account_id = ? AND device_id = ?
            """, Boolean.class, accountId, deviceId)).isFalse();
    }

    private InitiateSnapshotRequest request(UUID snapshotId, long sequence) {
        return new InitiateSnapshotRequest(snapshotId, deviceId, sequence, "account", "a".repeat(64),
            512, 1, 2, 3, null);
    }

    private String status(UUID snapshotId) {
        return jdbc.queryForObject(
            "SELECT snapshot_status FROM sync_snapshots WHERE snapshot_id = ?", String.class, snapshotId);
    }

    private String sign(String message) throws Exception {
        var signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(deviceKey.getPrivate());
        signer.update(message.getBytes(StandardCharsets.UTF_8));
        return Base64.getEncoder().encodeToString(signer.sign());
    }

    private static String chunkDigest(List<InitiateSnapshotRequest.Chunk> chunks) throws Exception {
        var digest = MessageDigest.getInstance("SHA-256");
        for (var chunk : chunks) {
            digest.update((chunk.index() + ":" + chunk.sha256() + ":" + chunk.sizeBytes() + "\n")
                .getBytes(StandardCharsets.UTF_8));
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static void assertApiCode(Runnable action, String code) {
        assertThatThrownBy(action::run)
            .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.code()).isEqualTo(code));
    }
}
