import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';

const exec = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(rootDir, 'docs', 'supabase');
const image = process.env.SUPABASE_TEST_POSTGRES_IMAGE || 'postgres:16-alpine';
const containerName = `dear-diary-supabase-test-${randomUUID()}`;
const password = `test-${randomUUID()}`;
const database = 'postgres';

const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const userC = '33333333-3333-4333-8333-333333333333';
let dockerCommand;

const resolveDockerCommand = async () => {
  if (dockerCommand) return dockerCommand;
  const candidates = [
    process.env.DOCKER_BIN,
    process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : '',
    process.platform === 'win32' ? 'docker.exe' : 'docker',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try {
        await access(candidate);
        dockerCommand = candidate;
        return dockerCommand;
      } catch {
        continue;
      }
    }
    dockerCommand = candidate;
    return dockerCommand;
  }
  dockerCommand = 'docker';
  return dockerCommand;
};

const docker = async (args, options = {}) => exec(await resolveDockerCommand(), args, {
  cwd: rootDir,
  maxBuffer: 10 * 1024 * 1024,
  ...options,
});

const die = message => {
  console.error(message);
  process.exitCode = 1;
};

const connect = port => postgres({
  host: '127.0.0.1',
  port,
  database,
  username: 'postgres',
  password,
  max: 1,
  idle_timeout: 1,
  connect_timeout: 5,
  onnotice: () => undefined,
});

const waitForPostgres = async port => {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    const sql = connect(port);
    try {
      await sql`select 1`;
      await sql.end();
      return;
    } catch (error) {
      lastError = error;
      await sql.end({ timeout: 1 }).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error('Postgres did not become ready.');
};

const startPostgres = async () => {
  try {
    await docker(['version', '--format', '{{.Server.Version}}']);
  } catch (error) {
    throw new Error(
      `Docker is required for Supabase integration tests, but the daemon is unavailable.\n${error.stderr || error.message}`,
    );
  }

  await docker([
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${database}`,
    '-p',
    '127.0.0.1::5432',
    image,
  ]);
  const { stdout } = await docker(['inspect', containerName, '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}']);
  const port = Number(stdout.trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error('Could not determine mapped Postgres port.');
  await waitForPostgres(port);
  return port;
};

const installSupabaseCompat = async sql => {
  await sql.unsafe(`
    create schema if not exists auth;

    create or replace function auth.uid()
    returns uuid
    language sql
    stable
    as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    create or replace function auth.jwt()
    returns jsonb
    language sql
    stable
    as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
    $$;

    do $$
    begin
      create role anon;
    exception when duplicate_object then null;
    end $$;

    do $$
    begin
      create role authenticated;
    exception when duplicate_object then null;
    end $$;

    do $$
    begin
      create publication supabase_realtime;
    exception when duplicate_object then null;
    end $$;
  `);
};

const applyMigrations = async sql => {
  const migrationFiles = (await readdir(migrationsDir))
    .filter(file => /^\d+_.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
  assert.equal(migrationFiles.length, 14, 'expected all 14 Supabase migrations');
  for (const file of migrationFiles) {
    const sqlText = await readFile(path.join(migrationsDir, file), 'utf8');
    await sql.unsafe(sqlText);
  }
};

const installRoleGrants = async sql => {
  await sql.unsafe(`
    grant usage on schema public, auth to anon, authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant execute on all functions in schema public to authenticated;
    grant execute on all functions in schema auth to authenticated;
  `);
};

const asUser = async (port, userId, email, fn) => {
  const sql = connect(port);
  try {
    await sql.unsafe('set role authenticated');
    await sql`select set_config('request.jwt.claim.sub', ${userId}, false)`;
    await sql`select set_config('request.jwt.claim.email', ${email}, false)`;
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({
      sub: userId,
      email,
      user_metadata: { email },
    })}, false)`;
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
};

const expectReject = async (operation, pattern, label) => {
  try {
    await operation();
  } catch (error) {
    assert.match(String(error.message || error), pattern, label);
    return error;
  }
  assert.fail(`${label} did not reject`);
};

const createAccount = async (port, userId, email, suffix) => asUser(port, userId, email, async sql => {
  const [row] = await sql`
    select public.create_primary_mobile_account(
      ${`google-${suffix}`},
      ${email},
      ${`Phone ${suffix}`},
      'android',
      ${`public-key-${suffix}`},
      true
    ) as result
  `;
  return {
    accountId: row.result.account.id,
    primaryDeviceId: row.result.device.id,
  };
});

const addCompanion = async (adminSql, accountId, suffix) => {
  const [row] = await adminSql`
    insert into public.devices (account_id, role, public_key, display_name, platform)
    values (${accountId}::uuid, 'web_companion', ${`companion-key-${suffix}`}, ${`Browser ${suffix}`}, 'web')
    returning id
  `;
  return row.id;
};

const commitKeyPackage = async (sql, {
  primaryDeviceId,
  afterSequence,
  driveFileId,
  operationId,
  keyEpoch,
}) => {
  const [row] = await sql`
    select *
    from public.commit_sync_object(
      p_device_id => ${primaryDeviceId}::uuid,
      p_after_sequence => ${afterSequence}::bigint,
      p_drive_file_id => ${driveFileId},
      p_object_kind => 'key_package',
      p_sha256 => ${'a'.repeat(64)},
      p_size_bytes => 32::bigint,
      p_operation_id => ${operationId},
      p_key_epoch => ${keyEpoch}::integer
    )
  `;
  return row;
};

const testRlsIsolation = async (port, adminSql) => {
  const a = await createAccount(port, userA, 'a@example.com', 'a');
  const b = await createAccount(port, userB, 'b@example.com', 'b');
  await asUser(port, userA, 'a@example.com', sql => commitKeyPackage(sql, {
    primaryDeviceId: a.primaryDeviceId,
    afterSequence: 0,
    driveFileId: 'drive-a-key',
    operationId: 'rls-a-key',
    keyEpoch: 1,
  }));
  await asUser(port, userB, 'b@example.com', sql => commitKeyPackage(sql, {
    primaryDeviceId: b.primaryDeviceId,
    afterSequence: 0,
    driveFileId: 'drive-b-key',
    operationId: 'rls-b-key',
    keyEpoch: 1,
  }));

  await asUser(port, userA, 'a@example.com', async sql => {
    const accounts = await sql`select google_user_id from public.accounts order by google_user_id`;
    assert.deepEqual(accounts.map(row => row.google_user_id), ['google-a']);

    const objects = await sql`select drive_file_id from public.sync_objects order by drive_file_id`;
    assert.deepEqual(objects.map(row => row.drive_file_id), ['drive-a-key']);

    await expectReject(
      () => sql`
        insert into public.accounts (supabase_user_id, google_user_id, google_email, recovery_configured)
        values (${userB}::uuid, 'google-evil', 'evil@example.com', true)
      `,
      /row-level security/i,
      'RLS rejects cross-user account inserts',
    );
  });

  const allAccounts = await adminSql`select count(*)::int as count from public.accounts`;
  assert.equal(allAccounts[0].count, 2);
};

const testRotationRpcGuards = async (port, adminSql) => {
  const userId = '44444444-4444-4444-8444-444444444444';
  const account = await createAccount(port, userId, 'rotation@example.com', 'rotation');
  const revokedDeviceId = await addCompanion(adminSql, account.accountId, 'revoked');
  const survivorDeviceId = await addCompanion(adminSql, account.accountId, 'survivor');

  await asUser(port, userId, 'rotation@example.com', async sql => {
    const [rotation] = await sql`
      select *
      from public.begin_device_key_rotation(${account.primaryDeviceId}::uuid, ${revokedDeviceId}::uuid, 'test')
    `;
    assert.equal(rotation.next_key_epoch, 2);

    await expectReject(
      () => sql`
        select public.finalize_device_key_rotation(
          ${account.primaryDeviceId}::uuid,
          ${rotation.id}::uuid,
          ${rotation.starting_sequence}::bigint
        )
      `,
      /missing_key_rotation_packages/,
      'rotation finalization requires key packages',
    );

    const recoveryObject = await commitKeyPackage(sql, {
      primaryDeviceId: account.primaryDeviceId,
      afterSequence: rotation.starting_sequence,
      driveFileId: 'drive-recovery-epoch-2',
      operationId: `key-epoch-recovery:${account.accountId}:2:${rotation.id}`,
      keyEpoch: 2,
    });

    await expectReject(
      () => sql`
        select public.finalize_device_key_rotation(
          ${account.primaryDeviceId}::uuid,
          ${rotation.id}::uuid,
          ${recoveryObject.sequence}::bigint
        )
      `,
      /missing_device_key_package/,
      'rotation finalization requires every remaining companion package',
    );

    const survivorObject = await commitKeyPackage(sql, {
      primaryDeviceId: account.primaryDeviceId,
      afterSequence: recoveryObject.sequence,
      driveFileId: 'drive-survivor-epoch-2',
      operationId: `key-epoch:${account.accountId}:2:${rotation.id}:${survivorDeviceId}`,
      keyEpoch: 2,
    });

    const [finalized] = await sql`
      select public.finalize_device_key_rotation(
        ${account.primaryDeviceId}::uuid,
        ${rotation.id}::uuid,
        ${survivorObject.sequence}::bigint
      ) as result
    `;
    assert.equal(finalized.result.account.current_key_epoch, 2);
  });

  const [revoked] = await adminSql`select revoked_at is not null as revoked from public.devices where id = ${revokedDeviceId}::uuid`;
  assert.equal(revoked.revoked, true);
};

const testConcurrentRotations = async (port, adminSql) => {
  const account = await createAccount(port, userC, 'concurrency@example.com', 'concurrency');
  const firstTarget = await addCompanion(adminSql, account.accountId, 'first-target');
  const secondTarget = await addCompanion(adminSql, account.accountId, 'second-target');

  const attempts = await Promise.allSettled([
    asUser(port, userC, 'concurrency@example.com', sql => sql`
      select *
      from public.begin_device_key_rotation(${account.primaryDeviceId}::uuid, ${firstTarget}::uuid, 'first')
    `),
    asUser(port, userC, 'concurrency@example.com', sql => sql`
      select *
      from public.begin_device_key_rotation(${account.primaryDeviceId}::uuid, ${secondTarget}::uuid, 'second')
    `),
  ]);

  const fulfilled = attempts.filter(result => result.status === 'fulfilled');
  const rejected = attempts.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent rotation should reserve the pending slot');
  assert.equal(rejected.length, 1, 'the competing rotation should fail');
  assert.match(String(rejected[0].reason?.message || rejected[0].reason), /key_epoch_rotations_one_pending_per_account|duplicate key/i);

  const rows = await adminSql`
    select status, next_key_epoch
    from public.key_epoch_rotations
    where account_id = ${account.accountId}::uuid
  `;
  assert.deepEqual(rows.map(row => `${row.status}:${row.next_key_epoch}`), ['pending:2']);
};

const main = async () => {
  let port;
  let adminSql;
  try {
    port = await startPostgres();
    adminSql = connect(port);
    await installSupabaseCompat(adminSql);
    await applyMigrations(adminSql);
    await installRoleGrants(adminSql);
    await testRlsIsolation(port, adminSql);
    await testRotationRpcGuards(port, adminSql);
    await testConcurrentRotations(port, adminSql);
    console.log('Supabase integration tests passed.');
  } catch (error) {
    die(error.stack || error.message || String(error));
  } finally {
    if (adminSql) await adminSql.end({ timeout: 1 }).catch(() => undefined);
    await docker(['rm', '-f', containerName]).catch(() => undefined);
  }
};

await main();
