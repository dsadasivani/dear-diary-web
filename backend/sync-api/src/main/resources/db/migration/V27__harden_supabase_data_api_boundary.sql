-- Sync V2 is accessed only through the authenticated Spring API. Supabase's
-- browser-facing Data API roles must never read or mutate backend metadata.
DO $migration$
DECLARE
    api_role NAME;
    database_object RECORD;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon'::NAME, 'authenticated'::NAME, 'service_role'::NAME]
    LOOP
        -- These roles exist on Supabase but not on a generic PostgreSQL runtime.
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            FOR database_object IN
                SELECT
                    namespace.nspname AS schema_name,
                    relation.relname AS object_name,
                    CASE WHEN relation.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS object_type
                FROM pg_class relation
                JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname = current_schema()
                  AND relation.relname LIKE 'sync\_%' ESCAPE '\'
                  AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')
            LOOP
                EXECUTE format(
                    'REVOKE ALL PRIVILEGES ON %s %I.%I FROM %I',
                    database_object.object_type,
                    database_object.schema_name,
                    database_object.object_name,
                    api_role
                );
            END LOOP;

            FOR database_object IN
                SELECT
                    namespace.nspname AS schema_name,
                    procedure.proname AS object_name,
                    pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
                FROM pg_proc procedure
                JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
                WHERE namespace.nspname = current_schema()
                  AND procedure.proname LIKE 'sync\_%' ESCAPE '\'
            LOOP
                EXECUTE format(
                    'REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I',
                    database_object.schema_name,
                    database_object.object_name,
                    database_object.identity_arguments,
                    api_role
                );
            END LOOP;

            -- Keep later Flyway-created objects private by default as well.
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL PRIVILEGES ON TABLES FROM %I',
                current_schema(),
                api_role
            );
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL PRIVILEGES ON SEQUENCES FROM %I',
                current_schema(),
                api_role
            );
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL PRIVILEGES ON FUNCTIONS FROM %I',
                current_schema(),
                api_role
            );
        END IF;
    END LOOP;
END
$migration$;
