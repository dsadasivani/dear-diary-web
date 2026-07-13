package com.deardiary.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@Testcontainers(disabledWithoutDocker = true)
class SchemaMigrationIntegrationTest {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:16.9-alpine");

    @Test
    void migratesTheCompleteSchemaAndKeepsDangerousFeaturesDisabled() throws Exception {
        var flyway = Flyway.configure()
            .dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
            .load();

        var migration = flyway.migrate();

        assertThat(migration.migrationsExecuted).isEqualTo(19);
        try (Connection connection = DriverManager.getConnection(
                POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             Statement statement = connection.createStatement()) {
            assertThat(queryBoolean(statement,
                "SELECT garbage_collection_enabled FROM sync_protocol_config WHERE config_id = 1"))
                .isFalse();
            assertThat(queryBoolean(statement,
                "SELECT engaged FROM sync_kill_switches WHERE switch_name = 'GARBAGE_COLLECTION'"))
                .isTrue();
            assertThat(queryLong(statement,
                "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'sync_%'"))
                .isEqualTo(17);
            assertThatThrownBy(() -> statement.executeUpdate("""
                INSERT INTO sync_accounts (
                    account_id, owner_subject, current_sequence, current_key_epoch,
                    minimum_read_protocol, minimum_write_protocol, account_status,
                    created_at, updated_at
                ) VALUES (
                    '00000000-0000-0000-0000-000000000001', 'subject-1', -1, 1,
                    2, 2, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
                """))
                .hasMessageContaining("ck_sync_accounts_sequence");
        }
    }

    private boolean queryBoolean(Statement statement, String sql) throws Exception {
        try (ResultSet result = statement.executeQuery(sql)) {
            assertThat(result.next()).isTrue();
            return result.getBoolean(1);
        }
    }

    private long queryLong(Statement statement, String sql) throws Exception {
        try (ResultSet result = statement.executeQuery(sql)) {
            assertThat(result.next()).isTrue();
            return result.getLong(1);
        }
    }
}
