# Dear Diary Sync API

Spring Boot modular-monolith foundation for the Sync V2 control plane.

Requirements:

- Java 21
- PostgreSQL 16 or newer for local integration tests and runtime

From the repository root:

```text
npm run backend:test
npm run backend:bootRun
```

Runtime database configuration is supplied through `SYNC_DB_URL`, `SYNC_DB_USERNAME`, and `SYNC_DB_PASSWORD`.
No production credentials are committed or required for unit tests.

The API currently exposes only `/actuator/health`. All `/api/v2/**` routes fail closed until JWT authentication and their contracts are implemented.

Flyway owns the PostgreSQL schema through 16 ordered migrations in `src/main/resources/db/migration`.
The migration integration test uses PostgreSQL 16 through Testcontainers and skips only when Docker is unavailable.
