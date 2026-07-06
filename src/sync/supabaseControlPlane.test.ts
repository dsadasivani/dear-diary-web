import assert from 'node:assert/strict';
import test from 'node:test';
import { SupabaseControlPlaneClient, SupabaseControlPlaneError } from './supabaseControlPlane';

test('posts metadata operations through Supabase RPC with auth headers', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({
      id: 'object-1',
      account_id: 'account-1',
      sequence: 2,
      drive_file_id: 'drive-file-1',
      object_kind: 'event',
      sha256: 'a'.repeat(64),
      size_bytes: 123,
      created_by_device_id: 'device-1',
      created_at: '2026-07-05T00:00:00.000Z',
      record_type: 'note',
      record_id: 'note-1',
      base_record_version: 3,
      record_version: 4,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const client = new SupabaseControlPlaneClient({
    url: 'https://example.supabase.co/',
    anonKey: 'anon-key',
    accessToken: async () => 'access-token',
    fetchImpl,
  });

  const object = await client.commitSyncObject({
    deviceId: 'device-1',
    afterSequence: 1,
    driveFileId: 'drive-file-1',
    objectKind: 'event',
    sha256: 'a'.repeat(64),
    sizeBytes: 123,
    recordType: 'note',
    recordId: 'note-1',
    baseRecordVersion: 3,
  });

  assert.equal(object.sequence, 2);
  assert.equal(object.driveFileId, 'drive-file-1');
  assert.equal(object.recordVersion, 4);
  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/commit_sync_object');
  assert.equal(new Headers(calls[0].init.headers).get('apikey'), 'anon-key');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer access-token');
  assert.equal(calls[0].init.body, JSON.stringify({
    p_device_id: 'device-1',
    p_after_sequence: 1,
    p_drive_file_id: 'drive-file-1',
    p_object_kind: 'event',
    p_sha256: 'a'.repeat(64),
    p_size_bytes: 123,
    p_record_type: 'note',
    p_record_id: 'note-1',
    p_base_record_version: 3,
    p_affected_records: [],
    p_partition_key: null,
    p_affected_partition_keys: [],
    p_operation_id: null,
    p_key_epoch: 1,
  }));
});

test('posts idempotent batch commits with partition metadata', async () => {
  let requestUrl = '';
  let requestBody = '';
  const fetchImpl: typeof fetch = async (input, init: RequestInit = {}) => {
    requestUrl = String(input);
    requestBody = String(init.body);
    return new Response(JSON.stringify([{
      id: 'object-1',
      account_id: 'account-1',
      sequence: 10,
      drive_file_id: 'drive-event-1',
      object_kind: 'event',
      sha256: 'a'.repeat(64),
      size_bytes: 456,
      created_by_device_id: 'device-1',
      created_at: '2026-07-05T00:00:00.000Z',
      record_type: 'entry',
      record_id: 'entry-1',
      base_record_version: 0,
      record_version: 1,
      partition_key: 'month:2026-07',
      affected_partition_keys: ['month:2026-07'],
      operation_id: 'operation-1',
      key_epoch: 2,
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new SupabaseControlPlaneClient({
    url: 'https://example.supabase.co',
    anonKey: 'anon-key',
    accessToken: 'access-token',
    fetchImpl,
  });

  const objects = await client.commitSyncBatch({
    deviceId: 'device-1',
    operationId: 'operation-1',
    objects: [{
      driveFileId: 'drive-event-1',
      objectKind: 'event',
      sha256: 'a'.repeat(64),
      sizeBytes: 456,
      partitionKey: 'month:2026-07',
    }],
    recordType: 'entry',
    recordId: 'entry-1',
    baseRecordVersion: 0,
    partitionKey: 'month:2026-07',
    affectedPartitionKeys: ['month:2026-07'],
    keyEpoch: 2,
  });

  assert.equal(requestUrl, 'https://example.supabase.co/rest/v1/rpc/commit_sync_batch');
  assert.equal(objects[0].partitionKey, 'month:2026-07');
  assert.equal(objects[0].operationId, 'operation-1');
  assert.equal(objects[0].keyEpoch, 2);
  assert.equal(requestBody, JSON.stringify({
    p_device_id: 'device-1',
    p_operation_id: 'operation-1',
    p_objects: [{
      drive_file_id: 'drive-event-1',
      object_kind: 'event',
      sha256: 'a'.repeat(64),
      size_bytes: 456,
      partition_key: 'month:2026-07',
    }],
    p_record_type: 'entry',
    p_record_id: 'entry-1',
    p_base_record_version: 0,
    p_affected_records: [],
    p_partition_key: 'month:2026-07',
    p_affected_partition_keys: ['month:2026-07'],
    p_key_epoch: 2,
  }));
});

test('rotates account key epoch through Supabase RPC', async () => {
  let requestUrl = '';
  let requestBody = '';
  const client = new SupabaseControlPlaneClient({
    url: 'https://example.supabase.co',
    anonKey: 'anon-key',
    accessToken: 'access-token',
    fetchImpl: async (input, init: RequestInit = {}) => {
      requestUrl = String(input);
      requestBody = String(init.body);
      return new Response(JSON.stringify(3), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const epoch = await client.rotateAccountKeyEpoch('primary-device-1');

  assert.equal(epoch, 3);
  assert.equal(requestUrl, 'https://example.supabase.co/rest/v1/rpc/rotate_account_key_epoch');
  assert.equal(requestBody, JSON.stringify({ p_primary_device_id: 'primary-device-1' }));
});

test('retires generic sync objects through Supabase RPC', async () => {
  let requestUrl = '';
  let requestBody = '';
  const client = new SupabaseControlPlaneClient({
    url: 'https://example.supabase.co',
    anonKey: 'anon-key',
    accessToken: 'access-token',
    fetchImpl: async (input, init: RequestInit = {}) => {
      requestUrl = String(input);
      requestBody = String(init.body);
      return new Response(JSON.stringify([{
        id: 'object-1',
        account_id: 'account-1',
        sequence: 1,
        drive_file_id: 'drive-event-1',
        object_kind: 'event',
        sha256: 'a'.repeat(64),
        size_bytes: 123,
        created_by_device_id: 'device-1',
        created_at: '2026-07-05T00:00:00.000Z',
        retired_at: '2026-07-06T00:00:00.000Z',
      }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const retired = await client.retireSyncObjects('primary-device-1', ['drive-event-1']);

  assert.equal(retired[0].objectKind, 'event');
  assert.equal(retired[0].retiredAt, '2026-07-06T00:00:00.000Z');
  assert.equal(requestUrl, 'https://example.supabase.co/rest/v1/rpc/retire_sync_objects');
  assert.equal(requestBody, JSON.stringify({
    p_primary_device_id: 'primary-device-1',
    p_drive_file_ids: ['drive-event-1'],
  }));
});

test('surfaces Supabase RPC errors with status and detail', async () => {
  const client = new SupabaseControlPlaneClient({
    url: 'https://example.supabase.co',
    anonKey: 'anon-key',
    fetchImpl: async () => new Response(JSON.stringify({ message: 'device_revoked' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  await assert.rejects(
    () => client.getDeviceStatus('device-1'),
    (error: unknown) => (
      error instanceof SupabaseControlPlaneError &&
      error.status === 400 &&
      error.message === 'device_revoked'
    ),
  );
});

test('loads recovery metadata without requiring a device transfer first', async () => {
  let requestUrl = '';
  let requestBody = '';
  const client = new SupabaseControlPlaneClient({
    url: 'https://example.supabase.co',
    anonKey: 'anon',
    accessToken: 'token',
    fetchImpl: async (input, init: RequestInit = {}) => {
      requestUrl = String(input);
      requestBody = String(init.body);
      return new Response(JSON.stringify([{
        id: 'key-object', account_id: 'account-1', sequence: 1,
        drive_file_id: 'key-file', object_kind: 'key_package', sha256: 'a'.repeat(64),
        size_bytes: 100, created_by_device_id: 'device-1', created_at: '', retired_at: null,
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  const objects = await client.listAccountRecoveryObjects();

  assert.equal(objects[0].objectKind, 'key_package');
  assert.equal(requestUrl, 'https://example.supabase.co/rest/v1/rpc/list_account_recovery_objects');
  assert.equal(requestBody, '{}');
});

test('maps approved pairing details and sends atomic provisioning metadata', async () => {
  let requestBody = '';
  const fetchImpl: typeof fetch = async (_input, init: RequestInit = {}) => {
    requestBody = String(init.body);
    return new Response(JSON.stringify({
      session: {
        id: 'pair-1', account_id: 'account-1', requested_device_public_key: '{}',
        requested_display_name: 'Chrome', requested_platform: 'web', pairing_code_hash: 'a'.repeat(64),
        expires_at: '2026-07-05T00:10:00.000Z', approved_by_primary_device_id: 'primary-1',
        approved_at: '2026-07-05T00:01:00.000Z', approved_device_id: 'device-2',
        key_package_drive_file_id: 'drive-key-1', key_package_sha256: 'b'.repeat(64),
        key_package_size_bytes: 321,
      },
      device: {
        id: 'device-2', account_id: 'account-1', role: 'web_companion', public_key: '{}',
        display_name: 'Chrome', platform: 'web', created_at: '', last_seen_at: '', revoked_at: null,
        replaced_by_device_id: null,
      },
      key_object: {
        id: 'object-2', account_id: 'account-1', sequence: 9, drive_file_id: 'drive-key-1',
        object_kind: 'key_package', sha256: 'b'.repeat(64), size_bytes: 321,
        created_by_device_id: 'primary-1', created_at: '',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = new SupabaseControlPlaneClient({
    url: 'https://example.supabase.co', anonKey: 'anon', accessToken: 'token', fetchImpl,
  });

  const details = await client.approvePairingSession({
    sessionId: 'pair-1', primaryDeviceId: 'primary-1', pairingCode: '12345678',
    afterSequence: 8, driveFileId: 'drive-key-1', sha256: 'b'.repeat(64), sizeBytes: 321,
  });

  assert.equal(details.device?.role, 'web_companion');
  assert.equal(details.keyObject?.sequence, 9);
  assert.equal(details.session.keyPackageSizeBytes, 321);
  assert.equal(requestBody, JSON.stringify({
    p_session_id: 'pair-1',
    p_primary_device_id: 'primary-1',
    p_pairing_code: '12345678',
    p_after_sequence: 8,
    p_drive_file_id: 'drive-key-1',
    p_sha256: 'b'.repeat(64),
    p_size_bytes: 321,
  }));
});
