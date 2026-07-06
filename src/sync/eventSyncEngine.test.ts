import assert from 'node:assert/strict';
import test from 'node:test';
import type { SyncDevice, SyncObjectMetadata } from '../types';
import { EventSyncEngine, SyncConflictError } from './eventSyncEngine';
import { SupabaseControlPlaneError, type SupabaseControlPlaneClient } from './supabaseControlPlane';
import { createRepository } from './testSupport';
import { decryptSyncPayload } from './encryptedSyncObject';
import { parseRepositorySnapshotPayload } from './syncSnapshot';
import { decodeSyncMediaPayload, parseSyncMediaReference } from './syncMedia';

test('uploads and commits an encrypted event before applying it locally', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let committedInput: any;
  let uploadedBytes = 0;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      committedInput = input;
      return {
        id: 'object-1', accountId: 'account-1', sequence: 3, driveFileId: input.driveFileId,
        objectKind: 'event', sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '', recordType: 'note', recordId: 'note-1',
        baseRecordVersion: 0, recordVersion: 1,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase-token', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive-token',
    }),
    createControlPlane: () => controlPlane,
    upload: async input => { uploadedBytes = input.bytes.byteLength; return { id: 'drive-1' }; },
  });
  const note = {
    id: 'note-1', title: 'Committed', body: 'Encrypted first.', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 1,
  };

  await engine.commitMutation('note', 'upsert', note.id, note);

  assert.ok(uploadedBytes > 0);
  assert.equal(committedInput.afterSequence, 2);
  assert.equal(committedInput.baseRecordVersion, 0);
  assert.deepEqual(await repository.getNote(note.id), note);
});

test('rejects writes while offline without changing local content', async () => {
  const repository = await createRepository();
  const engine = new EventSyncEngine(repository, { isOnline: () => false });
  await assert.rejects(
    () => engine.commitMutation('note', 'delete', 'note-1', null),
    /must be online/,
  );
  assert.equal(await repository.getNote('note-1'), null);
});

test('creates an encrypted version-aware snapshot and advances local sync metadata', async () => {
  const repository = await createRepository();
  const note = await repository.createNote({ title: 'Checkpoint', body: '', isPinned: false, tags: [] });
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    latestSnapshotSequence: 2, currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const rootKey = new Uint8Array(32);
  let uploadedBytes = new Uint8Array();
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    lookupCurrentGoogleAccount: async () => ({
      id: 'account-1', googleUserId: 'google-1', googleEmail: 'writer@example.com', createdAt: '',
      activePrimaryDeviceId: 'device-1', currentSyncSequence: 2, currentSnapshotSequence: 2,
      recoveryConfigured: true,
    }),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => ({
      id: 'snapshot-object-3', accountId: 'account-1', sequence: 3, driveFileId: input.driveFileId,
      objectKind: 'snapshot', sha256: input.sha256, sizeBytes: input.sizeBytes,
      createdByDeviceId: 'device-1', createdAt: '',
    }),
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: rootKey, devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive',
    }),
    createControlPlane: () => controlPlane,
    upload: async input => { uploadedBytes = input.bytes; return { id: 'snapshot-drive-3' }; },
    maintenance: async () => ({ snapshotsToRetire: [], driveFilesToDelete: [] }),
  });

  const committed = await engine.createSnapshot();
  const decrypted = await decryptSyncPayload(rootKey, uploadedBytes);
  const parsed = parseRepositorySnapshotPayload(decrypted.payload, 'account-1');

  assert.equal(committed?.sequence, 3);
  assert.equal(parsed.baseSequence, 2);
  assert.equal(parsed.snapshot.notes[0]?.id, note.id);
  assert.equal((await repository.getLocalSyncAccountState())?.latestSnapshotSequence, 3);
});

test('commits encrypted media before its entry event and hydrates it on another runtime', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    latestSnapshotSequence: 2, currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  const rootKey = new Uint8Array(32);
  const uploads: Array<{ kind: string; bytes: Uint8Array; id: string }> = [];
  let sequence = 2;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      sequence += 1;
      return {
        id: `object-${sequence}`, accountId: 'account-1', sequence, driveFileId: input.driveFileId,
        objectKind: input.objectKind, sha256: input.sha256, sizeBytes: input.sizeBytes,
        createdByDeviceId: 'device-1', createdAt: '',
        recordType: input.recordType || null, recordId: input.recordId || null,
        baseRecordVersion: input.baseRecordVersion ?? null,
        recordVersion: input.objectKind === 'event' ? 1 : null,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const dependencies = {
    isOnline: () => true,
    now: () => 1,
    loadSecrets: async () => ({
      version: 1 as const, accountId: 'account-1', accountRootKey: rootKey, devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive',
    }),
    createControlPlane: () => controlPlane,
    upload: async (input: any) => {
      const id = `drive-${input.objectKind}-${uploads.length + 1}`;
      uploads.push({ kind: input.objectKind, bytes: input.bytes, id });
      return { id };
    },
  };
  const engine = new EventSyncEngine(repository, dependencies);
  const photoDataUri = 'data:image/png;base64,aGVsbG8=';
  const entry = {
    id: 'entry-media', diaryId: 'diary-default', date: '2026-07-06', title: 'Photo', body: '',
    moodName: 'Calm', moodEmoji: '', tags: [], photoUris: [photoDataUri], photoCount: 1,
    wordCount: 0, createdAt: 1, updatedAt: 1,
  };

  await engine.commitMutation('entry', 'upsert', entry.id, entry);

  assert.deepEqual(uploads.map(upload => upload.kind), ['media', 'event']);
  const stored = await repository.getEntry(entry.id);
  const reference = stored?.photoUris[0] || '';
  const parsedReference = parseSyncMediaReference(reference);
  assert.equal(parsedReference?.sequence, 3);
  const decryptedMedia = await decryptSyncPayload(rootKey, uploads[0].bytes);
  assert.equal(new TextDecoder().decode(decodeSyncMediaPayload(decryptedMedia.payload).bytes), 'hello');

  const pointer = await repository.getSyncMediaPointer(3);
  await repository.saveSyncMediaPointer({ ...pointer!, localUri: undefined });
  const freshEngine = new EventSyncEngine(repository, {
    ...dependencies,
    download: async (_session, fileId) => uploads.find(upload => upload.id === fileId)!.bytes,
  });
  const hydrated = await freshEngine.hydrateEntries([stored!]);
  assert.equal(hydrated[0].photoUris[0], photoDataUri);
});

test('preserves a stale note edit as a recovered copy after pulling the winner', async () => {
  const repository = await createRepository();
  await repository.saveLocalSyncAccountState({
    accountId: 'account-1', deviceId: 'device-1', deviceRole: 'primary_mobile',
    googleUserId: 'google-1', googleEmail: 'writer@example.com', devicePublicKey: '{}',
    recoveryKeyDriveFileId: 'key-1', latestSnapshotDriveFileId: 'snapshot-1',
    currentSyncSequence: 2, linkedAt: 1,
  });
  const device: SyncDevice = {
    id: 'device-1', accountId: 'account-1', role: 'primary_mobile', publicKey: '{}',
    displayName: 'Phone', platform: 'android', createdAt: '', lastSeenAt: '',
    revokedAt: null, replacedByDeviceId: null,
  };
  let commitAttempt = 0;
  const controlPlane = {
    getDeviceStatus: async () => device,
    listSyncObjectsAfter: async () => [],
    updateDeviceCursor: async () => ({}),
    commitSyncObject: async (input: any): Promise<SyncObjectMetadata> => {
      commitAttempt += 1;
      if (commitAttempt === 1) {
        throw new SupabaseControlPlaneError('stale_record_version', 409, {});
      }
      return {
        id: 'recovered-object', accountId: 'account-1', sequence: 3,
        driveFileId: input.driveFileId, objectKind: 'event', sha256: input.sha256,
        sizeBytes: input.sizeBytes, createdByDeviceId: 'device-1', createdAt: '',
        recordType: 'note', recordId: input.recordId, baseRecordVersion: 0, recordVersion: 1,
      };
    },
  } as unknown as SupabaseControlPlaneClient;
  const engine = new EventSyncEngine(repository, {
    isOnline: () => true,
    now: () => 10,
    loadSecrets: async () => ({
      version: 1, accountId: 'account-1', accountRootKey: new Uint8Array(32),
      devicePrivateKeyJwk: '{}',
      supabaseSession: { accessToken: 'supabase', refreshToken: 'refresh', expiresAt: 2_000_000_000 },
    }),
    restoreGoogleSession: async () => ({
      userId: 'google-1', email: 'writer@example.com', displayName: null, accessToken: 'drive',
    }),
    createControlPlane: () => controlPlane,
    upload: async () => ({ id: `drive-${commitAttempt + 1}` }),
  });
  const staleNote = {
    id: 'note-1', title: 'My edit', body: 'Keep this', isPinned: false,
    tags: [], createdAt: 1, updatedAt: 2,
  };

  await assert.rejects(
    () => engine.commitMutation('note', 'upsert', staleNote.id, staleNote),
    (error: unknown) => error instanceof SyncConflictError && Boolean(error.recoveredRecordId),
  );

  const notes = await repository.listNotes();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, 'My edit (Recovered copy)');
  assert.equal(notes[0].body, 'Keep this');
});
