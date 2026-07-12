import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
  assert.deepEqual(migrationFiles, [
    '001_multi_device_sync.sql',
    '002_companion_pairing.sql',
    '003_portable_state_events.sql',
    '004_atomic_cascade_events.sql',
    '005_device_management.sql',
    '006_key_package_retirement.sql',
    '007_sync_object_maintenance.sql',
    '008_safe_primary_recovery.sql',
    '009_partitioned_latest_first_sync.sql',
    '010_sync_gc_retention.sql',
    '011_fix_pairing_digest.sql',
    '012_sync_object_kind_constraint.sql',
    '013_sync_media_gc.sql',
    '014_two_phase_recovery_and_rotation.sql',
    '015_fix_partition_restore_bundle_ambiguity.sql',
    '016_idempotent_key_rotation_finalize.sql',
    '017_guard_key_rotation_abort_race.sql',
    '018_idempotent_primary_recovery_finalize.sql',
  ], 'expected the complete ordered Supabase migration set');
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

const sha256Hex = value => createHash('sha256').update(value).digest('hex');

const commitEvent = async (sql, {
  primaryDeviceId,
  afterSequence,
  driveFileId,
  operationId,
  recordType = 'entry',
  recordId,
  baseRecordVersion,
}) => {
  const [row] = await sql`
    select *
    from public.commit_sync_object(
      p_device_id => ${primaryDeviceId}::uuid,
      p_after_sequence => ${afterSequence}::bigint,
      p_drive_file_id => ${driveFileId},
      p_object_kind => 'event',
      p_sha256 => ${'b'.repeat(64)},
      p_size_bytes => 128::bigint,
      p_record_type => ${recordType},
      p_record_id => ${recordId},
      p_base_record_version => ${baseRecordVersion}::bigint,
      p_operation_id => ${operationId}
    )
  `;
  return row;
};

const commitMedia = async (sql, {
  primaryDeviceId,
  afterSequence,
  driveFileId,
  operationId,
}) => {
  const [row] = await sql`
    select *
    from public.commit_sync_object(
      p_device_id => ${primaryDeviceId}::uuid,
      p_after_sequence => ${afterSequence}::bigint,
      p_drive_file_id => ${driveFileId},
      p_object_kind => 'media',
      p_sha256 => ${'c'.repeat(64)},
      p_size_bytes => 1024::bigint,
      p_operation_id => ${operationId}
    )
  `;
  return row;
};

const testRequiredCapabilities = async adminSql => {
  const requiredTables = [
    'accounts',
    'devices',
    'sync_objects',
    'pairing_sessions',
    'primary_recovery_attempts',
    'key_epoch_rotations',
  ];
  const rlsRows = await adminSql`
    select c.relname, c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ${adminSql(requiredTables)}
    order by c.relname
  `;
  assert.deepEqual(
    rlsRows.map(row => `${row.relname}:${row.relrowsecurity}`),
    requiredTables.sort().map(table => `${table}:true`),
    'required Supabase tables must have RLS enabled',
  );

  const capabilityRows = await adminSql`
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ${adminSql([
        'begin_device_key_rotation',
        'begin_primary_mobile_recovery',
        'commit_sync_object',
        'create_pairing_session',
        'finalize_device_key_rotation',
        'finalize_primary_mobile_recovery',
        'retire_sync_objects',
      ])}
    order by p.proname
  `;
  assert.deepEqual(
    [...new Set(capabilityRows.map(row => row.proname))],
    [
      'begin_device_key_rotation',
      'begin_primary_mobile_recovery',
      'commit_sync_object',
      'create_pairing_session',
      'finalize_device_key_rotation',
      'finalize_primary_mobile_recovery',
      'retire_sync_objects',
    ],
    'required Supabase RPC capabilities are installed',
  );

  const syncColumns = await adminSql`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sync_objects'
      and column_name in ${adminSql(['operation_id', 'key_epoch', 'partition_key', 'retired_at'])}
    order by column_name
  `;
  assert.deepEqual(
    syncColumns.map(row => row.column_name),
    ['key_epoch', 'operation_id', 'partition_key', 'retired_at'],
    'sync object stale-schema capabilities are present',
  );
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

const testSyncObjectGuards = async port => {
  const userId = '66666666-6666-4666-8666-666666666666';
  const account = await createAccount(port, userId, 'sync-guards@example.com', 'sync-guards');

  await asUser(port, userId, 'sync-guards@example.com', async sql => {
    const first = await commitEvent(sql, {
      primaryDeviceId: account.primaryDeviceId,
      afterSequence: 0,
      driveFileId: 'sync-guards-entry-v1',
      operationId: 'sync-guards-op',
      recordId: 'entry-sync-guards',
      baseRecordVersion: 0,
    });
    assert.equal(first.sequence, '1');
    assert.equal(first.record_version, '1');

    const duplicate = await commitEvent(sql, {
      primaryDeviceId: account.primaryDeviceId,
      afterSequence: 0,
      driveFileId: 'sync-guards-entry-duplicate',
      operationId: 'sync-guards-op',
      recordId: 'entry-sync-guards',
      baseRecordVersion: 0,
    });
    assert.equal(duplicate.id, first.id, 'duplicate operation IDs return the original object');

    await expectReject(
      () => commitEvent(sql, {
        primaryDeviceId: account.primaryDeviceId,
        afterSequence: first.sequence,
        driveFileId: 'sync-guards-entry-stale-record',
        operationId: 'sync-guards-stale-record-op',
        recordId: 'entry-sync-guards',
        baseRecordVersion: 0,
      }),
      /stale_record_version/,
      'stale record versions are rejected',
    );

    await expectReject(
      () => commitMedia(sql, {
        primaryDeviceId: account.primaryDeviceId,
        afterSequence: 99,
        driveFileId: 'sync-guards-future-sequence',
        operationId: 'sync-guards-future-sequence-op',
      }),
      /future_sync_sequence/,
      'future sync sequences are rejected',
    );
  });
};

const testPairingGuards = async (port, adminSql) => {
  const userId = '77777777-7777-4777-8777-777777777777';
  const account = await createAccount(port, userId, 'pairing@example.com', 'pairing');
  const pairingCode = '135790';

  await asUser(port, userId, 'pairing@example.com', async sql => {
    const [session] = await sql`
      select *
      from public.create_pairing_session(
        'pairing-public-key',
        'Pairing Browser',
        'web',
        ${sha256Hex(pairingCode)},
        now() + interval '5 minutes'
      )
    `;

    await expectReject(
      () => sql`
        select public.approve_pairing_session(
          ${session.id}::uuid,
          ${account.primaryDeviceId}::uuid,
          '000000',
          0::bigint,
          'pairing-wrong-code-key-package',
          ${'d'.repeat(64)},
          64::bigint
        )
      `,
      /pairing_code_invalid/,
      'pairing approval rejects wrong code digests',
    );

    const [approved] = await sql`
      select public.approve_pairing_session(
        ${session.id}::uuid,
        ${account.primaryDeviceId}::uuid,
        ${pairingCode},
        0::bigint,
        'pairing-approved-key-package',
        ${'e'.repeat(64)},
        64::bigint
      ) as result
    `;
    assert.equal(approved.result.device.role, 'web_companion');
    assert.equal(approved.result.key_object.object_kind, 'key_package');

    await expectReject(
      () => sql`
        select public.approve_pairing_session(
          ${session.id}::uuid,
          ${account.primaryDeviceId}::uuid,
          ${pairingCode},
          1::bigint,
          'pairing-replay-key-package',
          ${'f'.repeat(64)},
          64::bigint
        )
      `,
      /pairing_session_already_approved/,
      'pairing approval replay is rejected',
    );
  });

  const [expiredSession] = await adminSql`
    insert into public.pairing_sessions (
      account_id,
      requested_device_public_key,
      requested_display_name,
      requested_platform,
      pairing_code_hash,
      expires_at
    )
    values (
      ${account.accountId}::uuid,
      'expired-pairing-key',
      'Expired Browser',
      'web',
      ${sha256Hex('246802')},
      now() - interval '1 minute'
    )
    returning id
  `;

  await asUser(port, userId, 'pairing@example.com', async sql => {
    await expectReject(
      () => sql`
        select public.approve_pairing_session(
          ${expiredSession.id}::uuid,
          ${account.primaryDeviceId}::uuid,
          '246802',
          1::bigint,
          'pairing-expired-key-package',
          ${'1'.repeat(64)},
          64::bigint
        )
      `,
      /pairing_session_expired/,
      'expired pairing approvals are rejected',
    );
  });
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
        select public.abort_device_key_rotation(
          ${account.primaryDeviceId}::uuid,
          ${rotation.id}::uuid
        )
      `,
      /key_rotation_has_committed_packages/,
      'rotation abort is rejected after key packages are committed',
    );

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

    await adminSql`
      update public.key_epoch_rotations
      set status = 'aborted'
      where id = ${rotation.id}::uuid
    `;

    const [finalized] = await sql`
      select public.finalize_device_key_rotation(
        ${account.primaryDeviceId}::uuid,
        ${rotation.id}::uuid,
        ${survivorObject.sequence}::bigint
      ) as result
    `;
    assert.equal(finalized.result.account.current_key_epoch, 2);

    const [retryFinalized] = await sql`
      select public.finalize_device_key_rotation(
        ${account.primaryDeviceId}::uuid,
        ${rotation.id}::uuid,
        ${survivorObject.sequence}::bigint
      ) as result
    `;
    assert.equal(retryFinalized.result.account.current_key_epoch, 2);
    assert.equal(retryFinalized.result.rotation.status, 'finalized');
  });

  const [revoked] = await adminSql`select revoked_at is not null as revoked from public.devices where id = ${revokedDeviceId}::uuid`;
  assert.equal(revoked.revoked, true);
  const [revocationCount] = await adminSql`
    select count(*)::int as count
    from public.device_revocations
    where device_id = ${revokedDeviceId}::uuid
  `;
  assert.equal(revocationCount.count, 1);
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

const testConcurrentPrimaryRecoveries = async port => {
  const userId = '55555555-5555-4555-8555-555555555555';
  const account = await createAccount(port, userId, 'recovery-concurrency@example.com', 'recovery-concurrency');

  const attempts = await Promise.allSettled([
    asUser(port, userId, 'recovery-concurrency@example.com', sql => sql`
      select public.begin_primary_mobile_recovery(
        'google-recovery-concurrency',
        'recovery-concurrency@example.com',
        'Replacement A',
        'android',
        'replacement-public-key-a',
        true,
        ${account.primaryDeviceId}::uuid
      ) as result
    `),
    asUser(port, userId, 'recovery-concurrency@example.com', sql => sql`
      select public.begin_primary_mobile_recovery(
        'google-recovery-concurrency',
        'recovery-concurrency@example.com',
        'Replacement B',
        'android',
        'replacement-public-key-b',
        true,
        ${account.primaryDeviceId}::uuid
      ) as result
    `),
  ]);

  const fulfilled = attempts.filter(result => result.status === 'fulfilled');
  const rejected = attempts.filter(result => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one pending recovery should be reserved');
  assert.equal(rejected.length, 1, 'the competing primary recovery should fail');
  assert.match(
    String(rejected[0].reason?.message || rejected[0].reason),
    /primary_recovery_attempts_one_pending_per_account|duplicate key/i,
  );

  const recoveryResult = fulfilled[0].value[0].result;
  await asUser(port, userId, 'recovery-concurrency@example.com', async sql => {
    await expectReject(
      () => commitKeyPackage(sql, {
        primaryDeviceId: recoveryResult.device.id,
        afterSequence: 0,
        driveFileId: 'pending-recovery-write',
        operationId: 'pending-recovery-write',
        keyEpoch: 1,
      }),
      /device_not_active/,
      'pending recovery devices cannot commit sync objects',
    );

    const [aborted] = await sql`
      select *
      from public.abort_primary_mobile_recovery(
        ${recoveryResult.attempt.id}::uuid,
        ${recoveryResult.device.id}::uuid
      )
    `;
    assert.equal(aborted.status, 'aborted');

    const [replacement] = await sql`
      select public.begin_primary_mobile_recovery(
        'google-recovery-concurrency',
        'recovery-concurrency@example.com',
        'Replacement C',
        'android',
        'replacement-public-key-c',
        true,
        ${account.primaryDeviceId}::uuid
      ) as result
    `;
    assert.equal(replacement.result.device.activation_state, 'pending_recovery');
  });
};

const testPrimaryRecoveryFinalizeRetry = async port => {
  const userId = '88888888-8888-4888-8888-888888888888';
  const account = await createAccount(port, userId, 'recovery-retry@example.com', 'recovery-retry');

  await asUser(port, userId, 'recovery-retry@example.com', async sql => {
    const [pending] = await sql`
      select public.begin_primary_mobile_recovery(
        'google-recovery-retry',
        'recovery-retry@example.com',
        'Recovery Retry Phone',
        'android',
        'recovery-retry-public-key',
        true,
        ${account.primaryDeviceId}::uuid
      ) as result
    `;

    const [finalized] = await sql`
      select public.finalize_primary_mobile_recovery(
        ${pending.result.attempt.id}::uuid,
        ${pending.result.device.id}::uuid,
        0::bigint
      ) as result
    `;
    assert.equal(finalized.result.device.activation_state, 'active');

    const [retry] = await sql`
      select public.finalize_primary_mobile_recovery(
        ${pending.result.attempt.id}::uuid,
        ${pending.result.device.id}::uuid,
        0::bigint
      ) as result
    `;
    assert.equal(retry.result.attempt.status, 'finalized');
    assert.equal(retry.result.account.active_primary_device_id, pending.result.device.id);
  });
};

const testSyncObjectRetirement = async port => {
  const userId = '99999999-9999-4999-8999-999999999999';
  const account = await createAccount(port, userId, 'retention@example.com', 'retention');

  await asUser(port, userId, 'retention@example.com', async sql => {
    const event = await commitEvent(sql, {
      primaryDeviceId: account.primaryDeviceId,
      afterSequence: 0,
      driveFileId: 'retention-event',
      operationId: 'retention-event-op',
      recordId: 'entry-retention',
      baseRecordVersion: 0,
    });
    const media = await commitMedia(sql, {
      primaryDeviceId: account.primaryDeviceId,
      afterSequence: event.sequence,
      driveFileId: 'retention-media',
      operationId: 'retention-media-op',
    });
    const keyPackage = await commitKeyPackage(sql, {
      primaryDeviceId: account.primaryDeviceId,
      afterSequence: media.sequence,
      driveFileId: 'retention-key-package',
      operationId: 'retention-key-package-op',
      keyEpoch: 1,
    });

    const retired = await sql`
      select drive_file_id, object_kind, retired_at is not null as retired
      from public.retire_sync_objects(
        ${account.primaryDeviceId}::uuid,
        array['retention-event', 'retention-media', 'retention-key-package']::text[]
      )
      order by drive_file_id
    `;
    assert.deepEqual(
      retired.map(row => `${row.drive_file_id}:${row.object_kind}:${row.retired}`),
      ['retention-event:event:true', 'retention-media:media:true'],
      'GC retirement excludes key packages while retiring event/media objects',
    );

    const visible = await sql`
      select drive_file_id
      from public.list_sync_objects_after(${account.primaryDeviceId}::uuid, 0::bigint, 100)
      order by drive_file_id
    `;
    assert.deepEqual(visible.map(row => row.drive_file_id), [keyPackage.drive_file_id]);
  });
};

const main = async () => {
  let port;
  let adminSql;
  try {
    port = await startPostgres();
    adminSql = connect(port);
    await installSupabaseCompat(adminSql);
    await applyMigrations(adminSql);
    await applyMigrations(adminSql);
    await installRoleGrants(adminSql);
    await testRequiredCapabilities(adminSql);
    await testRlsIsolation(port, adminSql);
    await testSyncObjectGuards(port);
    await testPairingGuards(port, adminSql);
    await testRotationRpcGuards(port, adminSql);
    await testConcurrentRotations(port, adminSql);
    await testConcurrentPrimaryRecoveries(port);
    await testPrimaryRecoveryFinalizeRetry(port);
    await testSyncObjectRetirement(port);
    console.log('Supabase integration tests passed.');
  } catch (error) {
    die(error.stack || error.message || String(error));
  } finally {
    if (adminSql) await adminSql.end({ timeout: 1 }).catch(() => undefined);
    await docker(['rm', '-f', containerName]).catch(() => undefined);
  }
};

await main();
